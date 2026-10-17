import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { PLAINTEXT_KEYS } from '@/shared/lib/sealing/lsb1'
import { ENGINE_IDS, ENGINES, isEngineId, type EngineId } from './engines'

// Studio's contract manifest, vendored by scripts/vendor-studio-governance.mjs.
const MANIFEST_FILE = path.resolve(__dirname, '../../../../tests/fixtures/governance/contract-v1.json')

type Domain =
  | { type: 'string'; enum?: string[] }
  | { type: 'integer'; minimum: number; maximum: number }
  | { type: 'boolean' }

interface Manifest {
  definitionAllowlist: { path: string; domain: Domain }[]
  plaintext: { keys: string[] }
}

const manifest: Manifest = JSON.parse(readFileSync(MANIFEST_FILE, 'utf8'))
const ALLOWLIST = new Map(manifest.definitionAllowlist.map((entry) => [entry.path, entry.domain]))

// The six engines Platform offers, written out so that no test passes over an empty registry.
const OFFERED: readonly EngineId[] = ['postgres', 'mysql', 'mssql', 'oracle', 'mongodb', 'redis']

const PEM = '-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUQ2E=\n-----END CERTIFICATE-----\n'

// The smallest definition each engine accepts: its required keys and nothing else.
const MINIMAL: Record<EngineId, Record<string, unknown>> = {
  postgres: { host: 'db.internal', database: 'orders' },
  mysql: { host: 'db.internal', database: 'orders' },
  mssql: { host: 'db.internal', database: 'orders' },
  oracle: { host: 'db.internal', serviceName: 'ORCLPDB1' },
  mongodb: { host: 'db.internal' },
  redis: { host: 'cache.internal' },
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function inDomain(domain: Domain, value: unknown): boolean {
  switch (domain.type) {
    case 'string':
      return typeof value === 'string' && (domain.enum === undefined || domain.enum.includes(value))
    case 'integer':
      return Number.isSafeInteger(value) && (value as number) >= domain.minimum && (value as number) <= domain.maximum
    case 'boolean':
      return typeof value === 'boolean'
  }
}

// Whether Studio's row admission admits a definition: every key, at any depth, is a path of the
// allowlist with a value in its domain, and an object stands only where the allowlist has dotted keys below it.
function admitted(definition: Record<string, unknown>, prefix = ''): boolean {
  return Object.entries(definition).every(([key, value]) => {
    const keyPath = `${prefix}${key}`
    if (isObject(value)) {
      const nested = [...ALLOWLIST.keys()].some((allowed) => allowed.startsWith(`${keyPath}.`))
      return nested && admitted(value, `${keyPath}.`)
    }
    const domain = ALLOWLIST.get(keyPath)
    return domain !== undefined && inDomain(domain, value)
  })
}

// A copy of `base` with `value` at the dotted path; a key below ssl comes with an explicit mode.
function withPath(base: Record<string, unknown>, keyPath: string, value: unknown): Record<string, unknown> {
  const [head, ...rest] = keyPath.split('.')
  if (rest.length === 0) return { ...base, [head]: value }
  const nested = isObject(base[head]) ? base[head] : head === 'ssl' ? { mode: 'verify-full' } : {}
  return { ...base, [head]: withPath(nested, rest.join('.'), value) }
}

type JsonSchemaNode = {
  type?: string
  enum?: unknown[]
  minimum?: number
  maximum?: number
  properties?: Record<string, JsonSchemaNode>
  additionalProperties?: unknown
}

// The leaves of an object's JSON Schema by dotted path, after checking that every object in it is closed, so the
// schema can emit no key it does not list.
function leaves(node: JsonSchemaNode, prefix = ''): [string, JsonSchemaNode][] {
  expect(node.type, prefix || 'the definition').toBe('object')
  expect(node.additionalProperties, `${prefix || 'the definition'} admits other keys`).toBe(false)
  return Object.entries(node.properties ?? {}).flatMap(([key, child]): [string, JsonSchemaNode][] =>
    child.type === 'object' ? leaves(child, `${prefix}${key}.`) : [[`${prefix}${key}`, child]],
  )
}

// Whether every value a JSON Schema leaf admits lies in the allowlist domain of its path.
function narrowerThan(domain: Domain, node: JsonSchemaNode): boolean {
  switch (domain.type) {
    case 'string':
      if (node.type !== 'string') return false
      if (domain.enum === undefined) return true
      return node.enum !== undefined && node.enum.every((value) => domain.enum!.includes(value as string))
    case 'integer':
      return (
        node.type === 'integer' &&
        node.minimum !== undefined &&
        node.maximum !== undefined &&
        node.minimum >= domain.minimum &&
        node.maximum <= domain.maximum
      )
    case 'boolean':
      return node.type === 'boolean'
  }
}

describe('engines', () => {
  it('a postgres or mysql definition without database is refused', () => {
    for (const engine of ['postgres', 'mysql'] as const) {
      const schema = ENGINES[engine].definition
      expect(schema.safeParse(MINIMAL[engine]).success, engine).toBe(true)

      const missing = schema.safeParse({ host: 'db.internal', port: 5432 })
      expect(missing.success, engine).toBe(false)
      expect(missing.error?.issues.map((issue) => issue.path.join('.')), engine).toEqual(['database'])

      const blank = schema.safeParse({ ...MINIMAL[engine], database: '   ' })
      expect(blank.error?.issues.map((issue) => issue.path.join('.')), engine).toEqual(['database'])
    }
  })

  it('an oracle definition without serviceName is refused', () => {
    const schema = ENGINES.oracle.definition
    expect(schema.safeParse(MINIMAL.oracle).success).toBe(true)

    const missing = schema.safeParse({ host: 'db.internal', port: 1521 })
    expect(missing.success).toBe(false)
    expect(missing.error?.issues.map((issue) => issue.path.join('.'))).toEqual(['serviceName'])

    // A database is no stand-in for the service name, because Studio would fall back to the service ORCL.
    const withDatabase = schema.safeParse({ host: 'db.internal', database: 'ORCLPDB1' })
    expect(withDatabase.success).toBe(false)
  })

  it('a definition carrying user, password, connectionString or sshTunnel is refused', () => {
    const credentials: [string, unknown][] = [
      ...PLAINTEXT_KEYS.map((key): [string, unknown] => [key, 'secret-value']),
      ['agentUser', 'agent'],
      ['agentPassword', 'secret-value'],
      ['sshTunnel', { host: 'bastion.internal', user: 'tunnel' }],
      ['ssl.clientKey', '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n'],
      ['ssl.clientCert', PEM],
    ]
    for (const engine of OFFERED) {
      for (const [keyPath, value] of credentials) {
        const result = ENGINES[engine].definition.safeParse(withPath(MINIMAL[engine], keyPath, value))
        expect(result.success, `${engine} ${keyPath}`).toBe(false)
      }
    }
  })

  it('sqlite, duckdb and libredb are not offered', () => {
    expect([...ENGINE_IDS]).toEqual(OFFERED)
    expect(Object.keys(ENGINES).sort()).toEqual([...OFFERED].sort())
    for (const engine of ['sqlite', 'duckdb', 'libredb']) {
      expect(isEngineId(engine), engine).toBe(false)
    }
    for (const engine of OFFERED) {
      expect(isEngineId(engine), engine).toBe(true)
    }
  })

  it('every key and value type each engine schema can emit is in the vendored definition allowlist, and the credential schema keys are lsb1 plaintext keys', () => {
    expect(manifest.plaintext.keys).toEqual([...PLAINTEXT_KEYS])

    for (const engine of OFFERED) {
      for (const [keyPath, node] of leaves(z.toJSONSchema(ENGINES[engine].definition) as JsonSchemaNode)) {
        const domain = ALLOWLIST.get(keyPath)
        expect(domain, `${engine} emits ${keyPath}, which the allowlist does not hold`).toBeDefined()
        expect(narrowerThan(domain!, node), `${engine} ${keyPath}: ${JSON.stringify(node)}`).toBe(true)
      }

      const credential = leaves(z.toJSONSchema(ENGINES[engine].credential) as JsonSchemaNode)
      expect(credential.map(([key]) => key), engine).toEqual(expect.arrayContaining(['user', 'password']))
      for (const [key, node] of credential) {
        expect(manifest.plaintext.keys, `${engine} credential key ${key}`).toContain(key)
        expect(node.type, `${engine} credential key ${key}`).toBe('string')
        // Studio refuses the API key pair outside Elasticsearch and reads the private key pair for Snowflake only, and a
        // connection string would carry the address inside the envelope, past the host the definition binds.
        expect(['connectionString', 'privateKey', 'privateKeyPassphrase', 'apiKeyId', 'apiKeySecret']).not.toContain(key)
      }
    }
  })

  it('every engine definition schema accepts only keys and values that the vendored contract-v1.json definition allowlist admits', () => {
    // Values inside and outside each domain of the allowlist, and keys the allowlist does not hold.
    const samples: Record<Domain['type'], unknown[]> = {
      string: ['db.internal', 'orders', 'ORCLPDB1', 'SQLEXPRESS', 'admin', '2', PEM, '', 42, true, null, {}],
      integer: [1, 5432, 65535, 0, 65536, -1, 5432.5, '5432', null],
      boolean: [true, false, 'true', 1, null],
    }
    const enumSamples = ['disable', 'require', 'verify-system', 'verify-ca', 'verify-full', 'prefer', 'REQUIRE', 42]
    const foreignKeys = ['queryTimeout', 'readOnly', 'options', 'ssl.verify', 'ssl.ca', 'host.name', 'schema.name']

    for (const engine of OFFERED) {
      const schema = ENGINES[engine].definition
      const candidates: Record<string, unknown>[] = [MINIMAL[engine]]
      for (const [keyPath, domain] of ALLOWLIST) {
        const values = domain.type === 'string' && domain.enum ? enumSamples : samples[domain.type]
        for (const value of values) candidates.push(withPath(MINIMAL[engine], keyPath, value))
      }
      for (const keyPath of foreignKeys) candidates.push(withPath(MINIMAL[engine], keyPath, 'x'))
      candidates.push({ ...MINIMAL[engine], ssl: 'require' }, { ...MINIMAL[engine], ssl: {} })

      let accepted = 0
      for (const candidate of candidates) {
        const result = schema.safeParse(candidate)
        if (!result.success) continue
        accepted += 1
        expect(admitted(result.data as Record<string, unknown>), `${engine} accepted ${JSON.stringify(candidate)}`).toBe(true)
      }
      // Each engine accepts its minimal definition, a port, an SSL mode and skipObjectScan at least.
      expect(accepted, engine).toBeGreaterThan(4)
    }
  })
})
