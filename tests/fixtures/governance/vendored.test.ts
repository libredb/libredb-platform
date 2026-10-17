import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

// The three conformance files Studio publishes at a release tag, vendored by scripts/vendor-studio-governance.mjs and
// never edited by hand.
const DIR = __dirname
const VENDORED = ['GOVERNANCE.md', 'contract-v1.json', 'lsb1-vectors.json']
// Where Studio publishes them, in the order of the manifest's conformanceFiles.
const STUDIO_PATHS = ['docs/GOVERNANCE.md', 'tests/fixtures/governance/contract-v1.json', 'tests/fixtures/governance/lsb1-vectors.json']
const SCRIPT = path.join(DIR, '..', '..', '..', 'scripts', 'vendor-studio-governance.mjs')
// A Studio release tag such as 1.2.3 or v1.2.3, or git:<sha> for a build from a Studio commit before the release is cut.
const STUDIO_TAG_LINE = /^(v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?|git:[0-9a-f]{40})\n$/

function read(name: string): string {
  return readFileSync(path.join(DIR, name), 'utf8')
}

interface VendorRun {
  status: number | null
  stderr: string
  /** The URLs the script fetched, in order. */
  fetched: string[]
  /** What the script wrote into tests/fixtures/governance/, by file name. */
  written: Record<string, string>
}

/**
 * Runs a copy of the vendoring script in an empty checkout under the system temp directory, where a module loaded
 * first answers each fetch from `published`, file contents by URL, and 404 for any other URL. No request leaves this
 * host, and the vendored files of this repository are never written.
 */
function vendorInSandbox(argument: string, published: Record<string, string>): VendorRun {
  const root = mkdtempSync(path.join(tmpdir(), 'vendor-studio-governance-'))
  try {
    const script = path.join(root, 'scripts', 'vendor-studio-governance.mjs')
    const target = path.join(root, 'tests', 'fixtures', 'governance')
    const fetchLog = path.join(root, 'fetched.log')
    const stub = path.join(root, 'fetch-stub.mjs')
    mkdirSync(path.dirname(script))
    mkdirSync(target, { recursive: true })
    copyFileSync(SCRIPT, script)
    writeFileSync(stub, [
      "import { appendFileSync } from 'node:fs'",
      'const published = JSON.parse(process.env.PUBLISHED)',
      'globalThis.fetch = async (url) => {',
      '  appendFileSync(process.env.FETCH_LOG, `${url}\\n`)',
      '  const body = published[url]',
      "  return body === undefined ? new Response('', { status: 404, statusText: 'Not Found' }) : new Response(body)",
      '}',
      '',
    ].join('\n'))
    const run = spawnSync(process.execPath, ['--import', pathToFileURL(stub).href, script, argument], {
      encoding: 'utf8',
      env: { NODE_ENV: 'test', PATH: process.env.PATH, PUBLISHED: JSON.stringify(published), FETCH_LOG: fetchLog },
    })
    return {
      status: run.status,
      stderr: run.stderr,
      fetched: existsSync(fetchLog) ? readFileSync(fetchLog, 'utf8').trimEnd().split('\n') : [],
      written: Object.fromEntries(readdirSync(target).map(name => [name, readFileSync(path.join(target, name), 'utf8')])),
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

type Statement = { id: string; sql: string; params: unknown[] }
type JsonShape = { schema: Record<string, unknown>; example: unknown }

const contract = () => JSON.parse(read('contract-v1.json'))

describe('vendored Studio governance contract', () => {
  it('each vendored file matches its .sha256 pin', () => {
    for (const name of VENDORED) {
      const pin = read(`${name}.sha256`)
      expect(pin, `${name}.sha256`).toMatch(new RegExp(`^[0-9a-f]{64}  ${name.replace('.', '\\.')}\n$`))
      const digest = createHash('sha256').update(readFileSync(path.join(DIR, name))).digest('hex')
      expect(pin.slice(0, 64), name).toBe(digest)
    }
  })

  it('STUDIO_TAG holds one release tag', () => {
    expect(read('STUDIO_TAG')).toMatch(STUDIO_TAG_LINE)
  })

  it('scripts/vendor-studio-governance.mjs vendors a Studio release tag such as 1.0.0 or v1.0.0 and records it in STUDIO_TAG as given', () => {
    // Studio tags its releases with bare semver, such as 0.18.3.
    for (const tag of ['1.0.0', '1.1.0-rc.1', 'v1.0.0']) {
      const urls = STUDIO_PATHS.map(file => `https://raw.githubusercontent.com/libredb/libredb-studio/refs/tags/${tag}/${file}`)
      const contents = [
        `# Governance of Studio ${tag}\n`,
        `${JSON.stringify({ contractVersion: 1, conformanceFiles: STUDIO_PATHS })}\n`,
        `${JSON.stringify({ format: 'lsb1', tag })}\n`,
      ]
      const run = vendorInSandbox(tag, Object.fromEntries(urls.map((url, index) => [url, contents[index]])))
      expect({ status: run.status, stderr: run.stderr }, tag).toEqual({ status: 0, stderr: '' })
      expect(run.fetched, tag).toEqual(urls)
      expect(run.written.STUDIO_TAG, tag).toBe(`${tag}\n`)
      expect(run.written.STUDIO_TAG, tag).toMatch(STUDIO_TAG_LINE)
      for (const [index, name] of VENDORED.entries()) {
        expect(run.written[name], `${tag} ${name}`).toBe(contents[index])
        const digest = createHash('sha256').update(contents[index]).digest('hex')
        expect(run.written[`${name}.sha256`], `${tag} ${name}.sha256`).toBe(`${digest}  ${name}\n`)
      }
    }
  })

  it('scripts/vendor-studio-governance.mjs refuses an argument that is neither a release tag nor git:<ref>, before it downloads or writes anything', () => {
    for (const argument of ['1.0', 'v1', 'latest', 'studio-1.0.0']) {
      const run = vendorInSandbox(argument, {})
      expect(run.status, argument).toBe(1)
      expect(run.stderr, argument).toContain(`"${argument}" is neither a release tag X.Y.Z or vX.Y.Z nor git:<ref>.`)
      expect(run.stderr, argument).toContain('Usage: node scripts/vendor-studio-governance.mjs <X.Y.Z | vX.Y.Z | git:<ref>>')
      expect({ fetched: run.fetched, written: run.written }, argument).toEqual({ fetched: [], written: {} })
    }
  })

  it('contract-v1.json declares contract version 1', () => {
    const manifest = contract()
    expect(manifest.contractVersion).toBe(1)
    expect(manifest.supportedContractVersions).toContain(1)
    expect(manifest.conformanceFiles).toEqual([
      'docs/GOVERNANCE.md',
      'tests/fixtures/governance/contract-v1.json',
      'tests/fixtures/governance/lsb1-vectors.json',
    ])
    expect(JSON.parse(read('lsb1-vectors.json')).format).toBe('lsb1')
  })

  it('contract-v1.json carries the settings registry, the definition key allowlist with value domains, the heartbeat JSON shapes with examples, the /api/ready body and the statements with sample parameters', () => {
    const manifest = contract()

    expect(manifest.settings.length).toBeGreaterThan(0)
    for (const setting of manifest.settings) {
      expect(setting, JSON.stringify(setting)).toEqual(
        expect.objectContaining({ key: expect.any(String), type: expect.any(String), description: expect.any(String) }),
      )
      expect(setting, setting.key).toHaveProperty('default')
      expect(setting, setting.key).toHaveProperty('min')
      expect(setting, setting.key).toHaveProperty('max')
      expect(setting, setting.key).toHaveProperty('allowedValues')
    }

    expect(manifest.definitionAllowlist.length).toBeGreaterThan(0)
    for (const entry of manifest.definitionAllowlist) {
      expect(entry.path, JSON.stringify(entry)).toEqual(expect.any(String))
      expect(entry.domain.type, entry.path).toEqual(expect.any(String))
    }

    for (const column of ['skipped', 'sink', 'canary']) {
      const shape: JsonShape = manifest.heartbeat[column]
      expect(shape.schema, column).toEqual(expect.objectContaining({ type: expect.any(String) }))
      expect(shape.example, column).toBeDefined()
    }

    expect(manifest.readiness.path).toBe('/api/ready')
    expect(manifest.readiness.schema).toEqual(expect.objectContaining({ type: 'object' }))
    expect(manifest.readiness.examples.length).toBeGreaterThan(0)

    expect(manifest.statements.length).toBeGreaterThan(0)
    for (const statement of manifest.statements as Statement[]) {
      expect(statement.sql, statement.id).toEqual(expect.any(String))
      const placeholders = [...statement.sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]))
      expect(statement.params.length, statement.id).toBe(placeholders.length === 0 ? 0 : Math.max(...placeholders))
    }
  })
})
