import bcrypt from 'bcryptjs'
import { randomUUID } from 'crypto'
import type { Client } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigError } from '../../src/shared/lib/errors'
import { connectSuperuser, fixtureUrl } from '../../tests/db/connect'
import { createFreshDatabase } from '../../tests/db/fresh-database'

// The migrate job runs the seed with DATABASE_URL, the libredb_platform URL in pg syntax with schema=platform.
const DATABASE_URL = `${fixtureUrl('platform')}?schema=platform`

function marker(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12)
}

describe('seedProduction', () => {
  let seedProduction: typeof import('./production').seedProduction
  let superuser: Client

  async function identityCounts() {
    const result = await superuser.query<{ users: string; credentials: string; platform_admins: string }>(
      `SELECT (SELECT count(*) FROM platform.users) AS users,
              (SELECT count(*) FROM platform.password_credentials) AS credentials,
              (SELECT count(*) FROM platform.user_roles ur JOIN platform.roles r ON r.id = ur."roleId"
                WHERE r.code = 'PLATFORM_ADMIN') AS platform_admins`,
    )
    return result.rows[0]
  }

  async function credentialOf(email: string) {
    const result = await superuser.query<{ userId: string; passwordHash: string }>(
      `SELECT "userId", "passwordHash" FROM platform.password_credentials WHERE email = $1`,
      [email],
    )
    return result.rows
  }

  function bootstrapAdmin(email: string | undefined, password: string | undefined) {
    vi.stubEnv('BOOTSTRAP_ADMIN_EMAIL', email)
    vi.stubEnv('BOOTSTRAP_ADMIN_PASSWORD', password)
  }

  beforeAll(async () => {
    // The seed's Prisma client reads DATABASE_URL when its module loads.
    vi.stubEnv('DATABASE_URL', DATABASE_URL)
    ;({ seedProduction } = await import('./production'))
    superuser = await connectSuperuser()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  afterAll(async () => {
    await superuser.end()
  })

  it('cloud: no admin user without BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD', async () => {
    vi.stubEnv('DEPLOYMENT_MODE', 'cloud')
    bootstrapAdmin(undefined, undefined)
    // The removed ADMIN_EMAIL and the development SEED_USER_PASSWORD create no admin either.
    const legacyEmail = `legacy-${marker()}@example.com`
    vi.stubEnv('ADMIN_EMAIL', legacyEmail)
    vi.stubEnv('SEED_USER_PASSWORD', 'legacy-seed-password')
    const before = await identityCounts()

    await seedProduction()

    expect(await identityCounts()).toEqual(before)
    const legacy = await superuser.query('SELECT 1 FROM platform.users WHERE email = $1', [legacyEmail])
    expect(legacy.rows).toEqual([])
  })

  it('seeds no translation of a reference value, because the UI is English only', async () => {
    vi.stubEnv('DEPLOYMENT_MODE', 'cloud')
    bootstrapAdmin(undefined, undefined)

    await seedProduction()

    const translated = await superuser.query<{ code: string }>(
      `SELECT code FROM platform.reference_values WHERE translations IS NOT NULL ORDER BY code`,
    )
    expect(translated.rows).toEqual([])
  })

  it('cloud: seeds no plan price, so an admin sets every price', async () => {
    vi.stubEnv('DEPLOYMENT_MODE', 'cloud')
    bootstrapAdmin(undefined, undefined)

    await seedProduction()

    const prices = await superuser.query<{ code: string; price: string | null }>(
      `SELECT code, "pricePerUserMonthly"::text AS price FROM platform.plan_configs ORDER BY "sortOrder"`,
    )
    expect(prices.rows).toEqual([
      { code: 'FREE', price: null },
      { code: 'TEAM', price: null },
      { code: 'BUSINESS', price: null },
      { code: 'ENTERPRISE', price: null },
    ])
  })

  it('cloud: creates the bootstrap admin as PLATFORM_ADMIN of the libredb-platform tenant', async () => {
    vi.stubEnv('DEPLOYMENT_MODE', 'cloud')
    const id = marker()
    bootstrapAdmin(` Bootstrap.${id}@Example.com `, 'first bootstrap password')

    await seedProduction()

    const [credential] = await credentialOf(`bootstrap.${id}@example.com`)
    expect(await bcrypt.compare('first bootstrap password', credential.passwordHash)).toBe(true)
    const admin = await superuser.query(
      `SELECT u.email, u.active, u."keycloakId", m."isDefault", m.active AS member_active, t.slug, r.code, r."isSystem"
         FROM platform.users u
         JOIN platform.tenant_members m ON m."userId" = u.id
         JOIN platform.tenants t ON t.id = m."tenantId"
         JOIN platform.user_roles ur ON ur."membershipId" = m.id
         JOIN platform.roles r ON r.id = ur."roleId"
        WHERE u.id = $1`,
      [credential.userId],
    )
    expect(admin.rows).toEqual([{
      email: `bootstrap.${id}@example.com`,
      active: true,
      keycloakId: null,
      isDefault: true,
      member_active: true,
      slug: 'libredb-platform',
      code: 'PLATFORM_ADMIN',
      isSystem: true,
    }])
  })

  it('cloud: a second run keeps the existing password hash', async () => {
    vi.stubEnv('DEPLOYMENT_MODE', 'cloud')
    const email = `second-run-${marker()}@example.com`
    bootstrapAdmin(email, 'the first password')
    await seedProduction()
    const first = await credentialOf(email)
    expect(first).toHaveLength(1)

    bootstrapAdmin(email, 'a different password')
    const before = await identityCounts()
    await seedProduction()

    expect(await credentialOf(email)).toEqual(first)
    expect(await bcrypt.compare('the first password', first[0].passwordHash)).toBe(true)
    expect(await identityCounts()).toEqual(before)
  })

  it('cloud: only one of the two bootstrap variables throws ConfigError', async () => {
    vi.stubEnv('DEPLOYMENT_MODE', 'cloud')
    const email = `half-${marker()}@example.com`
    const password = `half-password-${marker()}`
    const before = await identityCounts()

    for (const [onlyEmail, onlyPassword] of [[email, undefined], [undefined, password]]) {
      bootstrapAdmin(onlyEmail, onlyPassword)
      const failure = await seedProduction().then(() => null, (error: unknown) => error)

      expect(failure).toBeInstanceOf(ConfigError)
      const message = (failure as ConfigError).message
      expect(message).toContain('BOOTSTRAP_ADMIN_EMAIL')
      expect(message).toContain('BOOTSTRAP_ADMIN_PASSWORD')
      expect(message).not.toContain(email)
      expect(message).not.toContain(password)
    }
    expect(await identityCounts()).toEqual(before)
  })

  it('cloud: an invalid bootstrap email or a bootstrap password under 8 characters throws ConfigError', async () => {
    vi.stubEnv('DEPLOYMENT_MODE', 'cloud')
    const before = await identityCounts()
    const cases = [
      { email: 'not-an-email', password: 'a long enough password', variable: 'BOOTSTRAP_ADMIN_EMAIL' },
      { email: `short-${marker()}@example.com`, password: 'Short7!', variable: 'BOOTSTRAP_ADMIN_PASSWORD' },
    ]

    for (const { email, password, variable } of cases) {
      bootstrapAdmin(email, password)
      const failure = await seedProduction().then(() => null, (error: unknown) => error)

      expect(failure).toBeInstanceOf(ConfigError)
      const message = (failure as ConfigError).message
      expect(message).toContain(variable)
      expect(message).not.toContain(email)
      expect(message).not.toContain(password)
    }
    expect(await identityCounts()).toEqual(before)
  })

  it('cloud: every role that sees the Dashboard menu holds platform.dashboard, which the dashboard page requires', async () => {
    vi.stubEnv('DEPLOYMENT_MODE', 'cloud')
    bootstrapAdmin(undefined, undefined)

    await seedProduction()

    const roles = await superuser.query<{ code: string; holds: boolean }>(
      `SELECT r.code, EXISTS (
                SELECT 1 FROM platform.role_permissions rp JOIN platform.permissions p ON p.id = rp."permissionId"
                 WHERE rp."roleId" = r.id AND p.code = 'platform.dashboard') AS holds
         FROM platform.menu_roles mr
         JOIN platform.menus m ON m.id = mr."menuId"
         JOIN platform.roles r ON r.id = mr."roleId"
        WHERE m.code = 'ADMIN_DASHBOARD'
        ORDER BY r.code`,
    )
    expect(roles.rows).toEqual([
      { code: 'PLATFORM_ADMIN', holds: true },
      { code: 'PLATFORM_TECH', holds: true },
    ])
  })
})

// A self-hosted install starts from an empty database, so these tests use one of their own that no other test writes to.
describe('seedProduction in self-hosted mode', () => {
  const DATABASE = 'libredb_seed_self_hosted'
  let seedProduction: typeof import('./production').seedProduction
  let ConfigErrorClass: typeof ConfigError
  let superuser: Client

  async function rows<T extends Record<string, unknown>>(sql: string): Promise<T[]> {
    return (await superuser.query<T>(sql)).rows
  }

  async function snapshot() {
    return {
      tenants: await rows('SELECT id, name, slug, active, "planConfigId", "updatedAt" FROM platform.tenants ORDER BY id'),
      users: await rows('SELECT id FROM platform.users ORDER BY id'),
      // The seed rewrites the platform-wide tags' colors and descriptions on every run, so their updatedAt moves.
      tags: await rows('SELECT id, name, "colorCode", description, "createdByUserId" FROM platform.support_tags ORDER BY id'),
    }
  }

  beforeAll(async () => {
    await createFreshDatabase(DATABASE)
    // A fresh module graph, so the seed's Prisma client reads this database's DATABASE_URL when it loads.
    vi.stubEnv('DATABASE_URL', `${fixtureUrl('platform', DATABASE)}?schema=platform`)
    vi.resetModules()
    ;({ seedProduction } = await import('./production'))
    ;({ ConfigError: ConfigErrorClass } = await import('../../src/shared/lib/errors'))
    superuser = await connectSuperuser(DATABASE)
  })

  beforeEach(() => {
    vi.stubEnv('DEPLOYMENT_MODE', 'self-hosted')
    vi.stubEnv('PLATFORM_ORGANIZATION_NAME', 'Acme Corporation')
    vi.stubEnv('BOOTSTRAP_ADMIN_EMAIL', undefined)
    vi.stubEnv('BOOTSTRAP_ADMIN_PASSWORD', undefined)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  afterAll(async () => {
    await superuser.end()
  })

  it('self-hosted: a missing PLATFORM_ORGANIZATION_NAME throws ConfigError', async () => {
    const before = await snapshot()

    for (const name of [undefined, '', '   ']) {
      vi.stubEnv('PLATFORM_ORGANIZATION_NAME', name)
      const failure = await seedProduction().then(() => null, (error: unknown) => error)

      expect(failure).toBeInstanceOf(ConfigErrorClass)
      expect((failure as Error).message).toContain('PLATFORM_ORGANIZATION_NAME')
    }
    expect(await snapshot()).toEqual(before)
  })

  it('self-hosted: exactly one tenant, slug default, plan ENTERPRISE, named from PLATFORM_ORGANIZATION_NAME', async () => {
    await seedProduction()

    expect(await rows(
      `SELECT t.slug, t.name, t.active, p.code AS plan
         FROM platform.tenants t JOIN platform.plan_configs p ON p.id = t."planConfigId"`,
    )).toEqual([{ slug: 'default', name: 'Acme Corporation', active: true, plan: 'ENTERPRISE' }])
  })

  it('self-hosted: zero users and zero password credentials', async () => {
    vi.stubEnv('SEED_USER_PASSWORD', 'a development password')
    await seedProduction()

    expect(await rows(
      `SELECT (SELECT count(*)::int FROM platform.users) AS users,
              (SELECT count(*)::int FROM platform.password_credentials) AS credentials,
              (SELECT count(*)::int FROM platform.tenant_members) AS members`,
    )).toEqual([{ users: 0, credentials: 0, members: 0 }])
  })

  it('self-hosted: no libredb-platform tenant', async () => {
    await seedProduction()

    expect(await rows(`SELECT slug FROM platform.tenants WHERE slug <> 'default'`)).toEqual([])
  })

  it('self-hosted: the License menu sits under Admin at /admin/license, for PLATFORM_ADMIN only', async () => {
    await seedProduction()

    expect(await rows(
      `SELECT m.name, m.url, m.icon, m.level, p.code AS parent
         FROM platform.menus m JOIN platform.menus p ON p.id = m."parentId"
        WHERE m.code = 'ADMIN_LICENSE'`,
    )).toEqual([{ name: 'License', url: '/admin/license', icon: 'key-round', level: 1, parent: 'ADMIN' }])
    expect(await rows(
      `SELECT r.code FROM platform.menu_roles mr
         JOIN platform.menus m ON m.id = mr."menuId" JOIN platform.roles r ON r.id = mr."roleId"
        WHERE m.code = 'ADMIN_LICENSE' ORDER BY r.code`,
    )).toEqual([{ code: 'PLATFORM_ADMIN' }])
  })

  it('self-hosted: support tags are created by system', async () => {
    await seedProduction()

    const tags = await rows<{ name: string; createdByUserId: string }>(
      `SELECT name, "createdByUserId" FROM platform.support_tags WHERE "tenantId" IS NULL ORDER BY name`,
    )
    expect(tags.map((tag) => tag.name)).toEqual(['billing', 'bug', 'feature-request', 'infra', 'question', 'security'])
    expect(new Set(tags.map((tag) => tag.createdByUserId))).toEqual(new Set(['system']))
  })

  it('self-hosted: the first run sets queryLog.statementCapture to redacted', async () => {
    // A fresh install has no value, so this test removes one an earlier test seeded.
    await superuser.query(`DELETE FROM platform.studio_settings WHERE key = 'queryLog.statementCapture'`)

    await seedProduction()

    expect(await rows(
      `SELECT key, value FROM bridge.settings_v1 WHERE key = 'queryLog.statementCapture'`,
    )).toEqual([{ key: 'queryLog.statementCapture', value: 'redacted' }])
    expect(await rows(
      `SELECT "updatedBy" FROM platform.studio_settings WHERE key = 'queryLog.statementCapture'`,
    )).toEqual([{ updatedBy: 'system:seed' }])
  })

  it('self-hosted: a second run keeps a value the admin changed', async () => {
    await seedProduction()
    const adminId = `admin_${marker()}`
    await superuser.query(
      `UPDATE platform.studio_settings SET value = '"full"', "updatedBy" = $1 WHERE key = 'queryLog.statementCapture'`,
      [adminId],
    )
    const changed = await rows(
      `SELECT key, value, "updatedAt", "updatedBy" FROM platform.studio_settings WHERE key = 'queryLog.statementCapture'`,
    )
    expect(changed).toEqual([expect.objectContaining({ value: 'full', updatedBy: adminId })])

    await seedProduction()

    expect(await rows(
      `SELECT key, value, "updatedAt", "updatedBy" FROM platform.studio_settings WHERE key = 'queryLog.statementCapture'`,
    )).toEqual(changed)
  })

  it('self-hosted: a second run changes nothing', async () => {
    await seedProduction()
    const before = await snapshot()

    // A changed organization name never renames the install tenant.
    vi.stubEnv('PLATFORM_ORGANIZATION_NAME', 'Renamed Organization')
    await seedProduction()

    expect(await snapshot()).toEqual(before)
    expect(before.tenants).toEqual([expect.objectContaining({ slug: 'default', name: 'Acme Corporation' })])
  })

  it('self-hosted: another tenant throws ConfigError and changes nothing', async () => {
    await seedProduction()
    const id = `other_${marker()}`
    await superuser.query(
      `INSERT INTO platform.tenants (id, name, slug, "planConfigId", "updatedAt")
       SELECT $1, 'Other', $1, id, now() FROM platform.plan_configs WHERE code = 'FREE'`,
      [id],
    )
    try {
      const before = await snapshot()
      const failure = await seedProduction().then(() => null, (error: unknown) => error)

      expect(failure).toBeInstanceOf(ConfigErrorClass)
      expect(await snapshot()).toEqual(before)
    } finally {
      await superuser.query('DELETE FROM platform.tenants WHERE id = $1', [id])
    }
  })
})
