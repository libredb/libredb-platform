// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const WORKFLOWS = path.join(__dirname, '..', '..', '.github', 'workflows')
const INSTALLER = path.join(__dirname, '..', '..', 'installer')

interface Job {
  name: string
  lines: string[]
}

function readWorkflow(file: string): string {
  return readFileSync(path.join(WORKFLOWS, file), 'utf8')
}

/**
 * The jobs of a workflow, each with the lines of its block.
 * The workflows indent with two spaces, so a job starts at a two-space key under the top-level `jobs:` key.
 */
function jobsOf(workflow: string): Job[] {
  const lines = workflow.split('\n')
  const start = lines.indexOf('jobs:')
  if (start === -1) throw new Error('the workflow has no top-level jobs: key')
  const jobs: Job[] = []
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break
    const key = /^ {2}([\w-]+):\s*$/.exec(line)
    if (key) jobs.push({ name: key[1], lines: [] })
    else if (jobs.length > 0) jobs[jobs.length - 1].lines.push(line)
  }
  if (jobs.length === 0) throw new Error('the workflow lists no jobs')
  return jobs
}

/** The commands of a job's `run:` steps, one entry per command line, block scalars included. */
function commandsOf(job: Job): string[] {
  const commands: string[] = []
  let blockIndent: number | null = null
  for (const line of job.lines) {
    const indent = line.length - line.trimStart().length
    if (blockIndent !== null) {
      if (line.trim() === '' || indent > blockIndent) {
        if (line.trim() !== '') commands.push(line.trim())
        continue
      }
      blockIndent = null
    }
    const run = /^(\s*)(?:- )?run:\s*(.*)$/.exec(line)
    if (!run) continue
    if (run[2] === '|' || run[2] === '>') blockIndent = indent
    else commands.push(run[2].trim())
  }
  return commands
}

function topLevelEnv(workflow: string, name: string): string | undefined {
  const match = new RegExp(`^ {2}${name}:\\s*'?([^'\\s]+)'?\\s*$`, 'm').exec(workflow.split('\njobs:')[0])
  return match?.[1]
}

/** The lines of a top-level key of a workflow, such as `on:`, without the key's own line. */
function sectionOf(workflow: string, key: string): string[] {
  const lines = workflow.split('\n')
  const start = lines.indexOf(`${key}:`)
  if (start === -1) throw new Error(`the workflow has no top-level ${key}: key`)
  const end = lines.findIndex((line, index) => index > start && /^\S/.test(line))
  return lines.slice(start + 1, end === -1 ? undefined : end)
}

/** The items of the list under the first `key:` of `lines`, without their quotes. */
function listOf(lines: string[], key: string): string[] {
  const start = lines.findIndex(line => new RegExp(`^\\s*${key}:\\s*$`).test(line))
  if (start === -1) return []
  const items: string[] = []
  for (const line of lines.slice(start + 1)) {
    const item = /^\s*- (.+)$/.exec(line)
    if (item) items.push(item[1].trim().replace(/^'(.*)'$/, '$1'))
    else if (line.trim() !== '' && !line.trim().startsWith('#')) break
  }
  return items
}

/** The scopes that the `permissions:` key at `indent` grants, by name. */
function permissionsOf(lines: string[], indent: string): Record<string, string> {
  const start = lines.indexOf(`${indent}permissions:`)
  if (start === -1) return {}
  const scopes: Record<string, string> = {}
  for (const line of lines.slice(start + 1)) {
    if (line.trim().startsWith('#')) continue
    const scope = new RegExp(`^${indent} {2}([\\w-]+):\\s*(\\S+)\\s*$`).exec(line)
    if (!scope) break
    scopes[scope[1]] = scope[2]
  }
  return scopes
}

/** The steps of a job, each as its lines; blank lines and the comments between steps are left out. */
function stepsOf(job: Job): string[][] {
  const start = job.lines.findIndex(line => /^ {4}steps:\s*$/.test(line))
  if (start === -1) throw new Error(`the job ${job.name} has no steps: key`)
  const steps: string[][] = []
  for (const line of job.lines.slice(start + 1)) {
    if (/^ {6}- /.test(line)) steps.push([line])
    else if (/^ {8}/.test(line) && steps.length > 0) steps[steps.length - 1].push(line)
    else if (/^ {0,4}\S/.test(line)) break
  }
  return steps
}

/** The value of one of a step's own one-line keys, such as `uses:` or `if:`. */
function valueOf(step: string[], key: string): string | undefined {
  const pattern = new RegExp(`^(?: {6}- | {8})${key}:\\s*(.+)$`)
  for (const line of step) {
    const match = pattern.exec(line)
    if (match) return match[1].trim()
  }
  return undefined
}

/** The value of one of a job's own one-line keys, such as `needs:`. */
function jobValueOf(job: Job, key: string): string | undefined {
  const pattern = new RegExp(`^ {4}${key}:\\s*(.+)$`)
  for (const line of job.lines) {
    const match = pattern.exec(line)
    if (match) return match[1].trim()
  }
  return undefined
}

/** The inputs of a step's `with:` key, each one-line value as the workflow writes it, and `|` for a block scalar. */
function withOf(step: string[]): Record<string, string> {
  const start = step.findIndex(line => /^ {8}with:\s*$/.test(line))
  if (start === -1) return {}
  const inputs: Record<string, string> = {}
  for (const line of step.slice(start + 1)) {
    // The lines of a block scalar, which blockOf reads.
    if (/^ {11,}\S/.test(line)) continue
    const input = /^ {10}([\w-]+):\s*(.*)$/.exec(line)
    if (!input) break
    inputs[input[1]] = input[2].trim()
  }
  return inputs
}

/** The variables of a step's `env:` key, with their values as the workflow writes them. */
function envOf(step: string[]): Record<string, string> {
  const start = step.findIndex(line => /^ {8}env:\s*$/.test(line))
  if (start === -1) return {}
  const env: Record<string, string> = {}
  for (const line of step.slice(start + 1)) {
    const variable = /^ {10}([A-Za-z_][\w]*):\s*(.*)$/.exec(line)
    if (!variable) break
    env[variable[1]] = variable[2].trim()
  }
  return env
}

/** The lines of the block scalar under the first `key: |` of a step, without their indentation. */
function blockOf(step: string[], key: string): string[] {
  const start = step.findIndex(line => new RegExp(`^\\s*(?:- )?${key}: [|>]\\s*$`).test(line))
  if (start === -1) return []
  const column = step[start].indexOf(`${key}:`)
  const body: string[] = []
  for (const line of step.slice(start + 1)) {
    if (line.trim() !== '' && line.length - line.trimStart().length <= column) break
    body.push(line)
  }
  const indent = Math.min(...body.filter(line => line.trim() !== '').map(line => line.length - line.trimStart().length))
  return body.map(line => line.slice(indent))
}

interface StepRun {
  status: number | null
  stdout: string
  stderr: string
  /** What the script appended to GITHUB_ENV. */
  githubEnv: string
  /** The RUNNER_TEMP of the run, removed once it ends, and the files the script left in it. */
  runnerTemp: string
  files: { name: string; mode: number; content: string }[]
  /** The arguments of each call of a stub command, in order. */
  calls: string[]
}

/**
 * Runs the script of a `run:` step with `bash -e`, as GitHub runs a step that names no shell on Linux, with `env` alone,
 * a fresh RUNNER_TEMP and a GITHUB_ENV file, in a fresh working directory that holds the files of `tree` alone, each by
 * its relative path. Each entry of `stubs` is the body of a sh script that stands in for the command of its name, first
 * on PATH, and every call of one logs its arguments.
 */
function runStep(
  script: string,
  env: Record<string, string>,
  stubs: Record<string, string> = {},
  tree: Record<string, string> = {},
): StepRun {
  const root = mkdtempSync(path.join(tmpdir(), 'workflow-step-'))
  try {
    const bin = path.join(root, 'bin')
    const runnerTemp = path.join(root, 'temp')
    const work = path.join(root, 'work')
    const githubEnv = path.join(root, 'github-env')
    const calls = path.join(root, 'calls.log')
    mkdirSync(bin)
    mkdirSync(runnerTemp)
    mkdirSync(work)
    writeFileSync(githubEnv, '')
    writeFileSync(calls, '')
    for (const [name, body] of Object.entries(stubs)) {
      writeFileSync(path.join(bin, name), ['#!/bin/sh', `printf '%s\\n' "$*" >> '${calls}'`, body, ''].join('\n'))
      chmodSync(path.join(bin, name), 0o755)
    }
    for (const [name, content] of Object.entries(tree)) {
      mkdirSync(path.dirname(path.join(work, name)), { recursive: true })
      writeFileSync(path.join(work, name), content)
    }
    writeFileSync(path.join(root, 'step.sh'), `${script}\n`)
    const run = spawnSync('bash', ['-e', path.join(root, 'step.sh')], {
      cwd: work,
      encoding: 'utf8',
      env: { NODE_ENV: 'test', PATH: `${bin}:/usr/bin:/bin`, RUNNER_TEMP: runnerTemp, GITHUB_ENV: githubEnv, ...env },
    })
    const files = readdirSync(runnerTemp).map(name => ({
      name,
      mode: statSync(path.join(runnerTemp, name)).mode & 0o777,
      content: readFileSync(path.join(runnerTemp, name), 'utf8'),
    }))
    const logged = readFileSync(calls, 'utf8')
    return {
      status: run.status,
      stdout: run.stdout,
      stderr: run.stderr,
      githubEnv: readFileSync(githubEnv, 'utf8'),
      runnerTemp,
      files,
      calls: logged === '' ? [] : logged.trimEnd().split('\n'),
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('.github/workflows', () => {
  it('every ci.yml job runs on Node 24 with npm ci, and a docker-smoke job runs scripts/ci/docker-smoke.sh', () => {
    const workflow = readWorkflow('ci.yml')
    expect(topLevelEnv(workflow, 'NODE_VERSION')).toBe('24')

    for (const job of jobsOf(workflow)) {
      const text = job.lines.join('\n')
      const commands = commandsOf(job)
      // No job installs with npm install, which ignores the lockfile.
      expect(commands.filter(command => /\bnpm (install|i)\b/.test(command)), job.name).toEqual([])
      if (!text.includes('actions/setup-node')) continue
      // Every Node.js job takes its version from NODE_VERSION and installs exactly what package-lock.json pins.
      expect([...text.matchAll(/node-version:\s*(.+)/g)].map(match => match[1].trim()), job.name)
        .toEqual(['${{ env.NODE_VERSION }}'])
      expect(commands, job.name).toContain('npm ci')
    }

    const smoke = jobsOf(workflow).find(job => job.name === 'docker-smoke')
    expect(smoke, 'a docker-smoke job').toBeDefined()
    expect(commandsOf(smoke!)).toContain('scripts/ci/docker-smoke.sh')
  })

  it('docker-build-push.yml builds the runner target', () => {
    const workflow = readWorkflow('docker-build-push.yml')
    const build = workflow.split('\n').findIndex(line => /uses:\s*docker\/build-push-action@/.test(line))
    expect(build, 'a docker/build-push-action step').toBeGreaterThan(-1)
    const withBlock = workflow.split('\n').slice(build + 1).join('\n').split(/\n\s*- /)[0]
    expect(withBlock).toMatch(/^\s+target:\s*runner\s*$/m)
  })

  it('docker-build-push.yml labels the image it publishes org.opencontainers.image.licenses=Elastic-2.0', () => {
    // docker/metadata-action derives that label from the license GitHub detects, and GitHub detects no Elastic License
    // 2.0; build-push-action sets the labels it outputs over the Dockerfile's, so the metadata step names the license.
    const lines = readWorkflow('docker-build-push.yml').split('\n')
    const stepAfter = (uses: RegExp) => {
      const start = lines.findIndex(line => uses.test(line))
      expect(start, `a step that matches ${uses}`).toBeGreaterThan(-1)
      return lines.slice(start + 1).join('\n').split(/\n\s*- /)[0]
    }
    expect(stepAfter(/uses:\s*docker\/metadata-action@/))
      .toMatch(/^\s+org\.opencontainers\.image\.licenses=Elastic-2\.0\s*$/m)
    expect(stepAfter(/uses:\s*docker\/build-push-action@/))
      .toMatch(/^\s+labels:\s*\$\{\{\s*steps\.meta\.outputs\.labels\s*\}\}\s*$/m)
  })

  it('docker-build-push.yml builds every v* tag, and a push to main unless it changes only the installer', () => {
    const on = sectionOf(readWorkflow('docker-build-push.yml'), 'on')
    expect(on.filter(line => /^ {2}[^\s#]/.test(line))).toEqual(['  push:'])
    expect(listOf(on, 'branches')).toEqual(['main'])
    expect(listOf(on, 'tags')).toEqual(['v*'])
    // GitHub evaluates path filters for branch pushes alone, never for the push of a tag.
    expect(listOf(on, 'paths-ignore')).toEqual(['installer/**', '.github/workflows/installer*.yml'])
  })

  it('docker-build-push.yml publishes main and sha-<7 hex> from main, and the version, its major.minor and latest from a v* tag alone', () => {
    const workflow = readWorkflow('docker-build-push.yml')
    const [build] = jobsOf(workflow)
    const meta = stepsOf(build).find(step => /^docker\/metadata-action@/.test(valueOf(step, 'uses') ?? ''))
    expect(meta, 'a docker/metadata-action step').toBeDefined()
    // The action adds no latest of its own, so only the build of a v* tag moves latest, and no push to main does.
    expect(blockOf(meta!, 'flavor')).toEqual(['latest=false'])
    // {{is_default_branch}} is true on a push to main and false on the push of a tag.
    expect(blockOf(meta!, 'tags')).toEqual([
      'type=raw,value=main,enable={{is_default_branch}}',
      'type=sha,enable={{is_default_branch}}',
      "type=semver,pattern={{version}},enable=${{ startsWith(github.ref, 'refs/tags/v') }}",
      "type=semver,pattern={{major}}.{{minor}},enable=${{ startsWith(github.ref, 'refs/tags/v') }}",
      "type=raw,value=latest,enable=${{ startsWith(github.ref, 'refs/tags/v') }}",
    ])
    // No tag follows package.json, whose version a push to main would otherwise publish over the release's.
    expect(workflow).not.toMatch(/package\.json/)
  })

  it('a v* run of docker-build-push.yml stops before it builds unless its tag is vX.Y.Z and the registry answers that this version does not exist', () => {
    const [build] = jobsOf(readWorkflow('docker-build-push.yml'))
    const steps = stepsOf(build)
    const uses = (action: RegExp) => steps.findIndex(step => action.test(valueOf(step, 'uses') ?? ''))
    const guard = steps.findIndex(step => blockOf(step, 'run').some(line => line.includes('docker buildx imagetools inspect')))
    expect(guard, 'a step that runs docker buildx imagetools inspect').toBeGreaterThan(-1)
    // After the registry login, which a private package needs, and before anything is pushed.
    expect(uses(/^docker\/login-action@/)).toBeGreaterThan(-1)
    expect(uses(/^docker\/login-action@/)).toBeLessThan(guard)
    expect(uses(/^docker\/build-push-action@/)).toBeGreaterThan(guard)
    expect(valueOf(steps[guard], 'if')).toBe("startsWith(github.ref, 'refs/tags/v')")
    expect(envOf(steps[guard])).toEqual({ IMAGE: 'ghcr.io/${{ github.repository }}' })
    const script = blockOf(steps[guard], 'run').join('\n')
    expect(script).not.toContain('${{')

    const reference = 'ghcr.io/libredb/libredb-platform:1.0.0'
    // A stand-in for docker that answers the lookup with DOCKER_STDERR and DOCKER_EXIT.
    const docker = '[ -z "$DOCKER_STDERR" ] || printf \'%s\\n\' "$DOCKER_STDERR" >&2\nexit "$DOCKER_EXIT"'
    const run = (tag: string, exit: number, stderr: string) => runStep(
      script,
      { GITHUB_REF_NAME: tag, IMAGE: 'ghcr.io/libredb/libredb-platform', DOCKER_EXIT: String(exit), DOCKER_STDERR: stderr },
      { docker },
    )

    const absent = run('v1.0.0', 1, `ERROR: ${reference}: not found`)
    expect({ status: absent.status, calls: absent.calls }).toEqual({ status: 0, calls: [`buildx imagetools inspect ${reference}`] })

    const published = run('v1.0.0', 0, '')
    expect(published.status).toBe(1)
    expect(published.stdout).toMatch(new RegExp(`^::error::${reference.replace(/[.]/g, '\\.')} already exists`, 'm'))

    // A lookup that fails for any other reason, such as a refused token, does not tell that the version is free.
    const refused = run('v1.0.0', 1, 'ERROR: failed to authorize: failed to fetch anonymous token: 403 Forbidden')
    expect(refused.status).toBe(1)
    expect(refused.stdout).toMatch(/^::error::/m)

    // A tag that is not vX.Y.Z would publish latest alone, without a version.
    for (const tag of ['v1.0', 'v1.1.0-rc.1', 'vnext']) {
      const malformed = run(tag, 1, `ERROR: ${reference}: not found`)
      expect({ status: malformed.status, calls: malformed.calls }, tag).toEqual({ status: 1, calls: [] })
      expect(malformed.stdout, tag).toMatch(/^::error::/m)
    }
  })

  it('installer-release.yml builds the x86_64 binary, LICENSE and SHA256SUMS in its build job, and its publish job publishes those files as the latest release, and nothing for arm64', () => {
    const workflow = readWorkflow('installer-release.yml')
    expect(jobsOf(workflow).map(job => job.name)).toEqual(['build', 'publish'])
    const [build, publish] = jobsOf(workflow)
    // Release 1.0.0 runs on x86_64 alone, because the Platform image is built for linux/amd64 only.
    expect(workflow).not.toMatch(/arm64|aarch64/)
    // A command line that ends with a backslash continues on the next one, so each entry here is one whole command.
    const commands = (job: Job) => commandsOf(job).join('\n').replace(/\\\n/g, ' ').split('\n')
    const files = ['libredb-installer-linux-x64', 'LICENSE']
    // The steps run in installer/ unless they name another directory, so ../LICENSE is the repository's license.
    expect(commands(build)).toContain('cp ../LICENSE dist/LICENSE')
    expect(commands(build).find(command => command.startsWith('sha256sum '))?.split(/\s+/))
      .toEqual(['sha256sum', ...files, '>', 'SHA256SUMS'])

    // The build job hands these three files alone to the publish job, and fails rather than hand over fewer.
    const upload = stepsOf(build).find(step => /^actions\/upload-artifact@/.test(valueOf(step, 'uses') ?? ''))
    expect(upload, 'an upload-artifact step in the build job').toBeDefined()
    expect(blockOf(upload!, 'path')).toEqual([...files, 'SHA256SUMS'].map(file => `installer/dist/${file}`))
    expect(withOf(upload!)['if-no-files-found']).toBe('error')
    expect(withOf(upload!).name).toMatch(/^\S+$/)
    const download = stepsOf(publish).find(step => /^actions\/download-artifact@/.test(valueOf(step, 'uses') ?? ''))
    expect(download, 'a download-artifact step in the publish job').toBeDefined()
    expect(withOf(download!)).toEqual({ name: withOf(upload!).name, path: 'dist' })

    // The release publishes the downloaded files from dist, where the download puts them.
    const creates = (step: string[]) =>
      commands({ name: publish.name, lines: step }).find(command => command.startsWith('gh release create '))
    const createStep = stepsOf(publish).find(step => creates(step) !== undefined)
    expect(createStep, 'a step that runs gh release create').toBeDefined()
    expect(valueOf(createStep!, 'working-directory')).toBe('dist')
    const create = creates(createStep!)
    expect(create?.split(/\s+/).slice(-3)).toEqual([...files, 'SHA256SUMS'])
    expect(create?.split(/\s+/)).toContain('--latest')
    const notes = /--notes "([^"]*)"/.exec(create ?? '')?.[1]
    expect(notes).toMatch(/\bLinux x86_64\b/)
    // The install guide downloads the binary and SHA256SUMS alone, so the check skips the LICENSE it did not download.
    expect(notes).toContain('sha256sum -c --ignore-missing SHA256SUMS')
    // The notes link the Docker install guide as of the release's own tag.
    const guide = /\$GITHUB_SERVER_URL\/\$GITHUB_REPOSITORY\/blob\/\$GITHUB_REF_NAME\/(\S+\.md)\b/.exec(notes ?? '')?.[1]
    expect(guide).toBe('docs/deploy/install-docker.md')
    expect(existsSync(path.join(__dirname, '..', '..', guide!)), guide).toBe(true)
  })

  it('installer-release.yml grants write scopes and the OIDC token to its publish job alone, which runs no code of the repository and attests the binary and SHA256SUMS before it publishes them', () => {
    const workflow = readWorkflow('installer-release.yml')
    const build = jobsOf(workflow).find(job => job.name === 'build')
    const publish = jobsOf(workflow).find(job => job.name === 'publish')
    expect(build, 'a build job').toBeDefined()
    expect(publish, 'a publish job').toBeDefined()
    expect(permissionsOf(workflow.split('\njobs:')[0].split('\n'), '')).toEqual({ contents: 'read' })
    // The build job installs the dependencies and runs their code, so its token reads and nothing more.
    expect(permissionsOf(build!.lines, '    ')).toEqual({ contents: 'read' })
    expect(permissionsOf(publish!.lines, '    '))
      .toEqual({ contents: 'write', 'id-token': 'write', attestations: 'write' })
    // The publish job starts only once every check and the build passed.
    expect(jobValueOf(publish!, 'needs')).toBe('build')

    // It checks out nothing, so no code of the repository or of its dependencies runs while it holds those scopes.
    const steps = stepsOf(publish!)
    expect(steps.flatMap(step => valueOf(step, 'uses') ?? []))
      .toEqual(['actions/download-artifact@v4', 'actions/attest@v4'])
    const commands = commandsOf(publish!).join('\n').replace(/\\\n/g, ' ').split('\n')
    expect(commands.map(command => command.split(/\s+/).slice(0, 3).join(' ')))
      .toEqual(['sha256sum -c SHA256SUMS', 'gh release create'])

    // actions/attest-build-provenance became a wrapper of actions/attest in v4, which GitHub recommends instead.
    const attest = steps.findIndex(step => valueOf(step, 'uses') === 'actions/attest@v4')
    expect(blockOf(steps[attest], 'subject-path')).toEqual(['dist/libredb-installer-linux-x64', 'dist/SHA256SUMS'])
    // download-artifact only warns when the files differ from the upload, so they are checked against the SHA256SUMS
    // of the build job before the attestation, and a failed check or attestation publishes nothing.
    const running = (pattern: RegExp) =>
      steps.findIndex(step => commandsOf({ name: publish!.name, lines: step }).some(command => pattern.test(command)))
    const download = steps.findIndex(step => valueOf(step, 'uses') === 'actions/download-artifact@v4')
    const check = running(/^sha256sum -c SHA256SUMS$/)
    expect(valueOf(steps[check], 'working-directory')).toBe('dist')
    expect(download).toBeLessThan(check)
    expect(check).toBeLessThan(attest)
    expect(running(/^gh release create /)).toBeGreaterThan(attest)
  })

  it('the build job of installer-release.yml runs release:check, typecheck, coverage:check and a smoke test of the binary, and none of its checkouts keeps the token', () => {
    const build = jobsOf(readWorkflow('installer-release.yml')).find(job => job.name === 'build')
    expect(build, 'a build job').toBeDefined()
    const steps = stepsOf(build!)
    const running = (command: string) =>
      steps.findIndex(step => commandsOf({ name: build!.name, lines: step }).includes(command))
    // The publish job needs this job, so none of these failing publishes anything.
    for (const command of ['bun run release:check', 'bun run typecheck', 'bun run coverage:check', 'bun run build']) {
      expect(running(command), command).toBeGreaterThan(-1)
    }
    expect(running('./dist/libredb-installer-linux-x64 version')).toBeGreaterThan(running('bun run build'))
    // Without persist-credentials: false, a checkout leaves the token in .git/config, where the dependencies and the
    // build can read it.
    const checkouts = steps.filter(step => /^actions\/checkout@/.test(valueOf(step, 'uses') ?? ''))
    expect(checkouts.length, 'the checkouts of the repository and of the pinned Studio commit').toBe(2)
    for (const checkout of checkouts) expect(withOf(checkout)['persist-credentials'], checkout.join('\n')).toBe('false')
  })

  it('an installer-release.yml run stops before it builds unless its tag is installer-v<version> of release.config.json and package.json, and release:record recorded that config', () => {
    const build = jobsOf(readWorkflow('installer-release.yml')).find(job => job.name === 'build')
    expect(build, 'a build job').toBeDefined()
    const steps = stepsOf(build!)
    const guard = steps.findIndex(step => blockOf(step, 'run').some(line => line.includes('release/history/')))
    expect(guard, 'a step that reads release/history/').toBeGreaterThan(-1)
    // After the checkout of the files it reads, and before the build.
    const checkout = steps.findIndex(step => /^actions\/checkout@/.test(valueOf(step, 'uses') ?? ''))
    const builds = steps.findIndex(step => commandsOf({ name: build!.name, lines: step }).includes('bun run build'))
    expect(checkout).toBeGreaterThan(-1)
    expect(checkout).toBeLessThan(guard)
    expect(builds).toBeGreaterThan(guard)
    // It runs in installer/, the default of the job, and reads GITHUB_REF_NAME, which GitHub sets for every step.
    expect(build!.lines.join('\n')).toMatch(/^ {4}defaults:\n {6}run:\n {8}working-directory: installer$/m)
    expect({ workingDirectory: valueOf(steps[guard], 'working-directory'), if: valueOf(steps[guard], 'if') })
      .toEqual({ workingDirectory: undefined, if: undefined })
    expect(envOf(steps[guard])).toEqual({})
    const script = blockOf(steps[guard], 'run').join('\n')
    expect(script).not.toContain('${{')

    const committed = JSON.parse(readFileSync(path.join(INSTALLER, 'release', 'release.config.json'), 'utf8'))
    const installerPackage = JSON.parse(readFileSync(path.join(INSTALLER, 'package.json'), 'utf8'))
    const manifest = { ...committed, version: '1.2.3' }
    // What release:record writes for a config: the manifest, indented by two spaces, with a final newline.
    const recorded = (written: typeof manifest) => `${JSON.stringify(written, null, 2)}\n`
    // The installer tree of a tag: the config at `configVersion`, in another layout and key order than release:record
    // writes, which release:check takes as the same release; package.json at `packageVersion`; and `history` as the
    // history file of 1.2.3.
    const tree = ({
      configVersion = '1.2.3',
      packageVersion = '1.2.3',
      history = recorded(manifest) as string | null,
    } = {}) => {
      const { contracts, ...rest } = { ...manifest, version: configVersion }
      const files: Record<string, string> = {
        'release/release.config.json': JSON.stringify({ contracts, ...rest }),
        'package.json': `${JSON.stringify({ ...installerPackage, version: packageVersion }, null, 2)}\n`,
      }
      if (history !== null) files['release/history/1.2.3.json'] = history
      return files
    }
    const run = (tag: string, files: Record<string, string>) => runStep(script, { GITHUB_REF_NAME: tag }, {}, files)

    const released = run('installer-v1.2.3', tree())
    expect({ status: released.status, stderr: released.stderr }).toEqual({ status: 0, stderr: '' })
    expect(released.stdout).not.toMatch(/::error::/)

    // A mistyped tag, or one that is not installer-vX.Y.Z, would publish the release of the config under another name.
    for (const tag of ['installer-v1.2.4', 'installer-v1.2', 'installer-v1.2.3-rc.1', 'installer-1.2.3', 'v1.2.3']) {
      const mistyped = run(tag, tree())
      expect(mistyped.status, tag).toBe(1)
      expect(mistyped.stdout, tag).toMatch(/^::error::/m)
    }
    // The binary embeds the release of the config, and reports the version of package.json as its own.
    const configBehind = run('installer-v1.2.4', tree({ packageVersion: '1.2.4' }))
    expect(configBehind.status).toBe(1)
    expect(configBehind.stdout).toMatch(/^::error::.*release\/release\.config\.json/m)
    const packageBehind = run('installer-v1.2.3', tree({ packageVersion: '1.2.2' }))
    expect(packageBehind.status).toBe(1)
    expect(packageBehind.stdout).toMatch(/^::error::.*package\.json/m)

    // Without its history file, release:check never checks the next release against this one.
    const unrecorded = run('installer-v1.2.3', tree({ history: null }))
    expect(unrecorded.status).toBe(1)
    expect(unrecorded.stdout).toMatch(/^::error::.*release\/history\/1\.2\.3\.json.*release:record/m)
    // A history file that records other contracts, images or minimums is not the release this tag publishes.
    const platform = { ...manifest.images.platform, digest: `sha256:${'1'.repeat(64)}` }
    const others: [string, typeof manifest][] = [
      ['contracts', { ...manifest, contracts: { ...manifest.contracts, studioSupports: [1, 2] } }],
      ['images', { ...manifest, images: { ...manifest.images, platform } }],
      ['minimums', { ...manifest, minimums: { ...manifest.minimums, compose: '2.99.0' } }],
    ]
    for (const [field, written] of others) {
      const differs = run('installer-v1.2.3', tree({ history: recorded(written) }))
      expect(differs.status, field).toBe(1)
      expect(differs.stdout, field).toMatch(/^::error::.*release\/history\/1\.2\.3\.json/m)
    }
  })

  it('every workflow pins an action outside actions/* by a full commit SHA with its release in a comment, and names an action of actions/* by its major tag', () => {
    const references = readdirSync(WORKFLOWS).filter(file => file.endsWith('.yml')).flatMap(file =>
      readWorkflow(file).split('\n').flatMap((line, index) => {
        const uses = /^\s*(?:- )?uses:\s*(.+?)\s*$/.exec(line)
        return uses ? [{ where: `${file}:${index + 1}`, value: uses[1] }] : []
      }))
    expect(references.length, 'an action reference').toBeGreaterThan(0)
    for (const { where, value } of references) {
      const reference = /^([\w.-]+)\/[\w./-]+@(\S+?)(?:\s+#\s*(.*))?$/.exec(value)
      expect(reference, `${where}: ${value} is not of the form owner/repo@ref`).not.toBeNull()
      const [, owner, ref, comment] = reference!
      if (owner === 'actions') {
        expect({ ref, comment }, where).toEqual({ ref: expect.stringMatching(/^v\d+$/), comment: undefined })
      } else {
        // The owner of an action can move any of its tags to other code, and a commit SHA names one tree for good.
        expect({ ref, comment }, where).toEqual({
          ref: expect.stringMatching(/^[0-9a-f]{40}$/),
          comment: expect.stringMatching(/^v\d+(\.\d+){0,2}$/),
        })
      }
    }
  })

  it('installer-e2e.yml hands the Docker end-to-end tests the license of the secret LIBREDB_E2E_LICENSE in a 0600 file, and notes the skipped test without it', () => {
    const docker = jobsOf(readWorkflow('installer-e2e.yml')).find(job => job.name === 'docker')
    expect(docker, 'a docker job').toBeDefined()
    const steps = stepsOf(docker!)
    const write = steps.findIndex(step => 'LIBREDB_E2E_LICENSE' in envOf(step))
    expect(write, 'a step that receives the secret LIBREDB_E2E_LICENSE').toBeGreaterThan(-1)
    // The secret reaches the step through its environment alone, never through the text of its script.
    expect(envOf(steps[write])).toEqual({ LIBREDB_E2E_LICENSE: '${{ secrets.LIBREDB_E2E_LICENSE }}' })
    const script = blockOf(steps[write], 'run').join('\n')
    expect(script).not.toContain('${{')

    // A stand-in value: the step writes the secret as it is and checks nothing of its form.
    const license = 'a-stand-in-for-the-ci-license'
    const licensed = runStep(script, { LIBREDB_E2E_LICENSE: license })
    expect(licensed.status).toBe(0)
    expect(licensed.files.map(({ mode, content }) => ({ mode, content }))).toEqual([{ mode: 0o600, content: license }])
    expect(licensed.githubEnv).toBe(`LIBREDB_E2E_LICENSE_FILE=${path.join(licensed.runnerTemp, licensed.files[0].name)}\n`)
    expect(licensed.stdout + licensed.stderr).not.toContain(license)

    // A pull request from a fork, or a repository without the secret, gets an empty value.
    const unlicensed = runStep(script, { LIBREDB_E2E_LICENSE: '' })
    expect({ status: unlicensed.status, files: unlicensed.files, githubEnv: unlicensed.githubEnv })
      .toEqual({ status: 0, files: [], githubEnv: '' })
    expect(unlicensed.stdout).toMatch(/^::notice::.*docker-platform\.test\.ts.*skipped/m)

    // sudo resets the environment, so every run of test/e2e/docker-platform.test.ts as root passes the file on.
    const runsPlatformTests = (command: string) =>
      /"\$\(command -v bun\)" test /.test(command) &&
      /\stest\/e2e(\/docker-platform\.test\.ts)?$/.test(command) &&
      !command.includes("--path-ignore-patterns 'test/e2e/docker-platform.test.ts'")
    const platformRuns = steps.flatMap((step, index) =>
      commandsOf({ name: docker!.name, lines: step }).filter(runsPlatformTests).map(command => ({ index, command })))
    expect(platformRuns.length, 'a run of test/e2e/docker-platform.test.ts').toBeGreaterThan(0)
    for (const { index, command } of platformRuns) {
      expect(index, command).toBeGreaterThan(write)
      expect(command).toMatch(/^sudo env "LIBREDB_E2E_LICENSE_FILE=\$LIBREDB_E2E_LICENSE_FILE" "\$\(command -v bun\)" test /)
    }
  })
})
