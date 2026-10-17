import type { Client } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigError } from '../errors'
import { connectSuperuser, fixtureUrl } from '../../../../tests/db/connect'
import { createFreshDatabase } from '../../../../tests/db/fresh-database'

// getInstallTenant counts every tenant, so it reads a database of its own that no other test writes to.
const DATABASE = 'libredb_install_tenant'

describe('getInstallTenant', () => {
  let getInstallTenant: typeof import('./install-tenant').getInstallTenant
  let superuser: Client

  async function insertTenant(slug: string) {
    await superuser.query(
      `INSERT INTO platform.tenants (id, name, slug, "planConfigId", "updatedAt") VALUES ($1, $2, $1, 'plan_enterprise', now())`,
      [slug, `Tenant ${slug}`],
    )
  }

  beforeAll(async () => {
    await createFreshDatabase(DATABASE)
    // The shared Prisma client reads DATABASE_URL when its module loads.
    vi.stubEnv('DATABASE_URL', `${fixtureUrl('platform', DATABASE)}?schema=platform`)
    ;({ getInstallTenant } = await import('./install-tenant'))
    superuser = await connectSuperuser(DATABASE)
    await superuser.query(
      `INSERT INTO platform.plan_configs (id, code, name, "updatedAt") VALUES ('plan_enterprise', 'ENTERPRISE', 'Enterprise', now())`,
    )
  })

  beforeEach(async () => {
    await superuser.query('DELETE FROM platform.tenants')
  })

  afterAll(async () => {
    vi.unstubAllEnvs()
    await superuser.end()
  })

  it('throws ConfigError unless exactly one tenant exists', async () => {
    await expect(getInstallTenant()).rejects.toBeInstanceOf(ConfigError)

    await insertTenant('default')
    await expect(getInstallTenant()).resolves.toMatchObject({ id: 'default', slug: 'default', name: 'Tenant default' })

    await insertTenant('second')
    await expect(getInstallTenant()).rejects.toBeInstanceOf(ConfigError)
  })
})
