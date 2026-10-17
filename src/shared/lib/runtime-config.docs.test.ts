import { readFileSync } from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { LICENSE_LIMIT_CODES, licenseLimitMessage, type LicenseLimitCode } from './errors'
import { ADMIN_SEAT_CHECK_FAILED_URL } from './identity/auth-callbacks'
import { LICENSE_ERROR_CODES } from './license'
import { runtimeVariableNames } from './runtime-config'

const DOC_PATH = path.resolve(__dirname, '../../../docs/deploy/platform-runtime.md')

// The break-glass statements that withdraw a user's access while Keycloak is down, which
// tests/db/bridge-grants.db.test.ts and tests/db/bridge-revocations.db.test.ts run as libredb_platform.
const BREAK_GLASS = [
  "DELETE FROM platform.connection_grants WHERE subject = '<id>'",
  "INSERT INTO platform.session_revocations (subject, reason) VALUES ('<id>', 'admin')",
]

// The only variables the migrate container receives.
const MIGRATE_ENVIRONMENT = [
  'MIGRATE_DATABASE_URL',
  'DATABASE_URL',
  'DEPLOYMENT_MODE',
  'PLATFORM_ORGANIZATION_NAME',
  'NODE_EXTRA_CA_CERTS',
]

function readDoc(): string {
  return readFileSync(DOC_PATH, 'utf8')
}

/** The body of the `## <heading>` section, up to the next heading of level 2. */
function section(doc: string, heading: string): string {
  const lines = doc.split('\n')
  const start = lines.indexOf(`## ${heading}`)
  if (start === -1) throw new Error(`docs/deploy/platform-runtime.md has no section "## ${heading}"`)
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '))
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n')
}

/** The backticked names in the first column of every table row of `text`. */
function firstColumnNames(text: string): string[] {
  return text
    .split('\n')
    .filter(line => line.startsWith('| `'))
    .flatMap(line => [...line.split('|')[1].matchAll(/`([A-Z0-9_]+)`/g)].map(match => match[1]))
}

/** The lines of every ```sql block of `text`. */
function sqlLines(text: string): string[] {
  return [...text.matchAll(/```sql\n([\s\S]*?)```/g)].flatMap(match => match[1].split('\n')).map(line => line.trim())
}

describe('docs/deploy/platform-runtime.md', () => {
  it('every variable of the runtime schema appears in docs/deploy/platform-runtime.md', () => {
    const inventory = firstColumnNames(section(readDoc(), 'Environment inventory'))
    const names = runtimeVariableNames()
    expect(names.length).toBeGreaterThan(0)
    expect(names.filter(name => !inventory.includes(name))).toEqual([])
  })

  it('the migrate environment lists MIGRATE_DATABASE_URL, DATABASE_URL, DEPLOYMENT_MODE, PLATFORM_ORGANIZATION_NAME and NODE_EXTRA_CA_CERTS', () => {
    const listed = firstColumnNames(section(readDoc(), 'Migrate container'))
    expect([...listed].sort()).toEqual([...MIGRATE_ENVIRONMENT].sort())
  })

  it('the break-glass section carries both break-glass statements verbatim', () => {
    const statements = sqlLines(section(readDoc(), 'Break-glass'))
    for (const statement of BREAK_GLASS) {
      expect(statements).toContain(`${statement};`)
    }
  })

  it('the license section names every state, every verification failure and the exact text of every refusal', () => {
    const license = section(readDoc(), 'License')
    const lines = license.split('\n')
    for (const state of ['free', 'invalid', 'active', 'expiring', 'grace', 'expired']) {
      expect(lines.some(line => line.startsWith(`| \`${state}\` |`)), state).toBe(true)
    }
    for (const code of LICENSE_ERROR_CODES) {
      expect(license).toContain(`\`${code}\``)
    }
    expect(LICENSE_LIMIT_CODES.length).toBeGreaterThan(0)
    for (const code of LICENSE_LIMIT_CODES) {
      expect(lines).toContain(`- \`${code}\`: ${licenseLimitMessage(code)}`)
    }
  })

  it('the license section names where a refused or failed first sign-in of an admin lands, and the Keycloak rights it needs', () => {
    const license = section(readDoc(), 'License')
    // The codes the admin-seat gate refuses a first sign-in with.
    const refusals: LicenseLimitCode[] = ['LICENSE_ADMIN_SEATS', 'LICENSE_EXPIRED']
    for (const landing of [...refusals.map(code => `/login?error=${code}`), ADMIN_SEAT_CHECK_FAILED_URL]) {
      expect(license, landing).toContain(`\`${landing}\``)
    }
    // Keycloak reports each admin's account with view-users, and the roles of the libredb client after its lookup with
    // view-clients.
    for (const right of ['view-users', 'view-clients']) {
      expect(license, right).toContain(`\`${right}\``)
    }
  })
})
