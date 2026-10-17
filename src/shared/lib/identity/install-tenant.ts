import type { Tenant } from '@prisma/client'
import { db } from '@/shared/lib/db'
import { ConfigError } from '@/shared/lib/errors'

/**
 * The one tenant of a self-hosted install, which the self-hosted seed creates.
 * Throws ConfigError unless exactly one tenant exists, so a database seeded for another install is never used.
 */
export async function getInstallTenant(): Promise<Tenant> {
  const tenants = await db.tenant.findMany({ take: 2 })
  if (tenants.length !== 1) {
    const found = tenants.length === 0 ? 'none' : 'more than one'
    throw new ConfigError(`a self-hosted install needs exactly one tenant, and the database holds ${found}`)
  }
  return tenants[0]
}
