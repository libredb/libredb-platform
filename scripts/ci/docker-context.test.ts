// @vitest-environment node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// The Docker build context is the repository root filtered by .dockerignore. `next build` type-checks every file of
// it that tsconfig.json includes, and `npm run build:migrator` bundles two of them, so each file the context keeps
// must find its imports there. Nothing that neither the Dockerfile nor the build reads belongs in it.

const ROOT = path.join(__dirname, '..', '..')

interface Pattern {
  /** A `!` line, which re-includes what it matches. */
  exception: boolean
  /** The cleaned pattern without its `!`, relative to the context root. */
  text: string
  regexp: RegExp
}

/**
 * The regular expression of a pattern, built the way moby/patternmatcher builds it: `*` and `?` never match a `/`,
 * `**` matches any number of directories, and the pattern must match the whole path.
 */
function compile(pattern: string): RegExp {
  let source = ''
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]
    if (char === '*' && pattern[index + 1] === '*') {
      index += pattern[index + 2] === '/' ? 2 : 1
      source += index === pattern.length - 1 ? '.*' : '(.*/)?'
    } else if (char === '*') source += '[^/]*'
    else if (char === '?') source += '[^/]'
    else if (char === '\\') source += `\\${pattern[++index] ?? '\\'}`
    else source += char.replace(/[.+(){}|$]/, '\\$&')
  }
  return new RegExp(`^${source}$`)
}

/** The patterns of .dockerignore, read the way Docker reads them: `#` starts a comment, a pattern is a clean path. */
function readPatterns(): Pattern[] {
  const patterns: Pattern[] = []
  for (const line of readFileSync(path.join(ROOT, '.dockerignore'), 'utf8').split('\n')) {
    if (line.startsWith('#') || line.trim() === '') continue
    const exception = line.trim().startsWith('!')
    const text = path.posix.normalize(line.trim().slice(exception ? 1 : 0).trim()).replace(/^\/|\/$/g, '')
    patterns.push({ exception, text, regexp: compile(text) })
  }
  return patterns
}

const PATTERNS = readPatterns()

/**
 * Matches one entry the way BuildKit's walker does (patternmatcher MatchesUsingParentResults): a pattern that matched
 * the parent directory matches the entry, a pattern that cannot change the result is skipped, and the last match wins.
 */
function matchEntry(entry: string, parent: boolean[] | undefined): { excluded: boolean; matched: boolean[] } {
  let excluded = false
  const matched = PATTERNS.map(() => false)
  for (const [index, pattern] of PATTERNS.entries()) {
    let match = parent?.[index] ?? false
    if (!match) {
      if (pattern.exception !== excluded) continue
      match = pattern.regexp.test(entry)
    }
    matched[index] = match
    if (match) excluded = !pattern.exception
  }
  return { excluded, matched }
}

/** Whether BuildKit walks into the excluded directory `dir`, which it does only when an exception could match in it. */
function mayReinclude(dir: string): boolean {
  const exceptions = PATTERNS.filter(pattern => pattern.exception)
  const withoutTrailingGlob = (text: string) => text.replace(/\/\*\*$/, '').replace(/\/\*$/, '')
  if (exceptions.some(pattern => /[*?[\\]/.test(withoutTrailingGlob(pattern.text)))) return true
  return exceptions.some(pattern => `${pattern.text}/`.startsWith(`${dir}/`))
}

/** Whether the build context holds `file`, a path relative to the repository root that need not exist. */
function inContext(file: string): boolean {
  const segments = file.split('/')
  let parent: boolean[] | undefined
  for (let depth = 1; depth < segments.length; depth++) {
    const dir = segments.slice(0, depth).join('/')
    const result = matchEntry(dir, parent)
    if (result.excluded && !mayReinclude(dir)) return false
    parent = result.matched
  }
  return !matchEntry(file, parent).excluded
}

/** Every file of the build context, walked the way BuildKit walks it. */
function contextFiles(dir = '', found: string[] = []): string[] {
  for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const file = dir === '' ? entry.name : `${dir}/${entry.name}`
    if (!entry.isDirectory()) {
      if (inContext(file)) found.push(file)
    } else if (inContext(file) || mayReinclude(file)) contextFiles(file, found)
  }
  return found
}

const CONTEXT = contextFiles()

function isFile(file: string): boolean {
  const absolute = path.join(ROOT, file)
  return existsSync(absolute) && statSync(absolute).isFile()
}

/** The suffixes tried on the path an import names to find its file; '' covers an import with its extension. */
const RESOLUTIONS = ['', '.ts', '.tsx', '.d.ts', '.js', '/index.ts', '/index.tsx', '/index.js']

/** The repository path that a relative or `@/` import names, or undefined for a package import. */
function importTarget(file: string, specifier: string): string | undefined {
  let base: string
  if (specifier.startsWith('@/')) base = path.posix.join('src', specifier.slice(2))
  else if (specifier.startsWith('.')) base = path.posix.join(path.posix.dirname(file), specifier)
  else return undefined
  return RESOLUTIONS.map(suffix => base + suffix).find(isFile) ?? base
}

function importSpecifiers(source: string): string[] {
  return [...source.matchAll(/(?:\bfrom|\bimport|\brequire)\s*\(?\s*['"]([^'"\n]+)['"]/g)].map(match => match[1])
}

describe('.dockerignore', () => {
  it('keeps tests, docs, CI, compose files, screenshots, local files and new top-level files out', () => {
    const outside = [
      'tests/fixtures/governance/lsb1-vectors.json',
      'src/shared/lib/sealing/lsb1.test.ts',
      'src/app/(auth)/login/page.test.tsx',
      'src/shared/lib/bridge/contract.db.test.ts',
      'src/shared/test-setup.ts',
      'prisma/seeds/production.db.test.ts',
      'e2e/smoke.spec.ts',
      '.github/workflows/ci.yml',
      'database-compose.yml',
      'docker/postgres/bootstrap.psql',
      'docker/migrator/versions.test.ts',
      'vitest.config.ts',
      'playwright.config.ts',
      'scripts/ci/docker-smoke.sh',
      'installer/package.json',
      'docs/product-map.md',
      'docs/libredb-platform-architecture.excalidraw',
      'screenshots/01-login-page.png',
      'README.md',
      'CLAUDE.md',
      'AGENTS.md',
      'test-results/.last-run.json',
      // Paths that need not exist: secrets, local and build outputs, editor files and files nobody added on purpose.
      '.env.local',
      '.git/config',
      'node_modules/next/package.json',
      '.next/BUILD_ID',
      'tsconfig.tsbuildinfo',
      'uploads/avatar.png',
      'docker/migrator/node_modules/prisma/package.json',
      'docker/migrator/dist/seed.cjs',
      'playwright-report/index.html',
      '.vscode/settings.json',
      'a-new-top-level-file.txt',
      'src/features/auth/README.md',
      'src/shared/lib/sealing/flow.excalidraw',
      'src/app/login.drawio',
      'src/.DS_Store',
    ]
    expect(outside.filter(inContext)).toEqual([])
  })

  it('keeps every file the Dockerfile copies or the build reads', () => {
    const inside = [
      'package.json',
      'package-lock.json',
      'tsconfig.json',
      'next.config.ts',
      'postcss.config.mjs',
      'prisma.config.ts',
      'LICENSE',
      'prisma/schema.prisma',
      'prisma/migrations/migration_lock.toml',
      'prisma/migrations/20261014224651_baseline/migration.sql',
      'prisma/seeds/run.ts',
      'scripts/maintain.ts',
      'src/app/layout.tsx',
      'src/app/favicon.ico',
      // public/ holds no file today, but a file added there is served as it is, so the image must receive it.
      'public/robots.txt',
      'docker/entrypoint.sh',
      'docker/migrator/package.json',
      'docker/migrator/preflight.mjs',
    ]
    expect(inside.filter(file => !inContext(file))).toEqual([])
  })

  it('keeps every source that a COPY of the Dockerfile reads from the context', () => {
    const dockerfile = readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8').replace(/\\\n/g, ' ')
    const sources = dockerfile.split('\n')
      .filter(line => /^COPY\s/.test(line) && !line.includes('--from='))
      .flatMap(line => line.trim().split(/\s+/).slice(1).filter(arg => !arg.startsWith('--')).slice(0, -1))
      .filter(source => source !== '.')
    expect(sources).toContain('docker/entrypoint.sh')
    const copied = (source: string) => CONTEXT.some(file => file === source || file.startsWith(`${source}/`))
    expect(sources.filter(source => !copied(source))).toEqual([])
  })

  it('leaves no relative or @/ import of a file in the context pointing outside it', () => {
    expect(CONTEXT).toContain('prisma/seeds/run.ts')
    const outside: string[] = []
    for (const file of CONTEXT.filter(file => /\.(?:[cm]?[jt]s|[jt]sx)$/.test(file))) {
      for (const specifier of importSpecifiers(readFileSync(path.join(ROOT, file), 'utf8'))) {
        const target = importTarget(file, specifier)
        if (target !== undefined && !inContext(target)) outside.push(`${file} -> ${target}`)
      }
    }
    expect(outside).toEqual([])
  })

  it('lets no image, diagram, design file or PDF into the context outside public/ and src/app/', () => {
    const media = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|pdf|excalidraw|drawio|dio|fig|sketch)$/i
    expect(CONTEXT.filter(file => media.test(file) && !/^(?:public|src\/app)\//.test(file))).toEqual([])
  })
})

interface Stage {
  /** The name after AS, or the index BuildKit names a stage by when it has none. */
  name: string
  /** The image or stage it starts from. */
  base: string
  /** Its instructions in order, each on one line. */
  instructions: string[]
}

/** The stages of the Dockerfile, read the way BuildKit reads them: a line that ends with a backslash continues. */
function readStages(): Stage[] {
  const stages: Stage[] = []
  for (const line of readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8').replace(/\\\n/g, ' ').split('\n')) {
    const instruction = line.trim()
    if (instruction === '' || instruction.startsWith('#')) continue
    const from = /^FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?$/i.exec(instruction)
    if (from) stages.push({ name: from[2] ?? String(stages.length), base: from[1], instructions: [] })
    // An ARG before the first FROM belongs to no stage.
    else stages.at(-1)?.instructions.push(instruction)
  }
  return stages
}

/** The stages that no other stage starts from or copies from: the images a build of the Dockerfile produces. */
function imageStages(stages: Stage[]): Stage[] {
  const used = new Set(stages.flatMap(stage => [
    stage.base,
    ...stage.instructions.flatMap(instruction => [...instruction.matchAll(/--from=(\S+)/g)].map(match => match[1])),
  ]))
  return stages.filter(stage => !used.has(stage.name))
}

/** The labels a stage sets, as key=value with the quotes of the value removed. */
function labelsOf(stage: Stage): string[] {
  return stage.instructions
    .filter(instruction => /^LABEL\s/i.test(instruction))
    .flatMap(instruction => [...instruction.matchAll(/([\w.-]+)=("[^"]*"|\S+)/g)])
    .map(([, key, value]) => `${key}=${value.replace(/^"(.*)"$/, '$1')}`)
}

/** The absolute paths in the image where the stage's COPY instructions put LICENSE from the build context. */
function licenseCopies(stage: Stage): string[] {
  let workdir = '/'
  const copies: string[] = []
  for (const instruction of stage.instructions) {
    const [keyword, ...args] = instruction.split(/\s+/)
    if (/^WORKDIR$/i.test(keyword)) workdir = path.posix.resolve(workdir, args[0])
    if (!/^COPY$/i.test(keyword) || args.some(arg => arg.startsWith('--from='))) continue
    const paths = args.filter(arg => !arg.startsWith('--'))
    if (!paths.slice(0, -1).includes('LICENSE')) continue
    const destination = paths[paths.length - 1]
    const resolved = path.posix.resolve(workdir, destination)
    copies.push(destination === '.' || destination.endsWith('/') ? path.posix.join(resolved, 'LICENSE') : resolved)
  }
  return copies
}

describe('Dockerfile', () => {
  it('gives every image it builds LICENSE at /app/LICENSE and the label org.opencontainers.image.licenses=Elastic-2.0', () => {
    const images = imageStages(readStages())
    expect(images.map(stage => stage.name)).toContain('runner')
    for (const image of images) {
      expect(labelsOf(image), image.name).toContain('org.opencontainers.image.licenses=Elastic-2.0')
      expect(licenseCopies(image), image.name).toContain('/app/LICENSE')
    }
  })

  // A tag moves to each new release, so every stage names its base image by digest, and a rebuild keeps the Node.js
  // whose node:crypto verifies license signatures with Ed25519. The runner runs what the other stages installed and
  // built, so they all start from one image.
  it('starts every stage from one node:24-bookworm-slim index pinned by digest', () => {
    const stages = readStages()
    const bases = stages.map(stage => stage.base).filter(base => !stages.some(stage => stage.name === base))
    expect(bases).not.toEqual([])
    expect(bases.filter(base => !/^node:24-bookworm-slim@sha256:[0-9a-f]{64}$/.test(base))).toEqual([])
    expect(new Set(bases).size).toBe(1)
  })
})
