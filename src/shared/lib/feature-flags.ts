import { cache } from 'react'
import { db } from './db'

interface TenantPlan {
  maxUsers: number
  maxConnections: number
  queryHistoryDays: number
  [key: string]: unknown
}

export const getTenantPlan = cache(async (tenantId: string): Promise<TenantPlan> => {
  const tenant = await db.tenant.findUnique({
    where: { id: tenantId },
    include: { planConfig: true },
  })
  if (!tenant) throw new Error(`Tenant ${tenantId} not found`)
  return tenant.planConfig as unknown as TenantPlan
})

export async function hasFeature(tenantId: string, feature: string): Promise<boolean> {
  const plan = await getTenantPlan(tenantId)
  const key = `feature${feature.charAt(0).toUpperCase()}${feature.slice(1)}`
  return plan[key] === true
}

export async function getLimit(tenantId: string, field: string): Promise<number> {
  const plan = await getTenantPlan(tenantId)
  const value = plan[field]
  return typeof value === 'number' ? value : 0
}

export async function checkLimit(
  tenantId: string,
  field: string,
  currentCount: number,
): Promise<boolean> {
  const limit = await getLimit(tenantId, field)
  if (limit === -1) return true
  return currentCount < limit
}
