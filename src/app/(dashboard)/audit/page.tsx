import { requireAuth } from '@/shared/lib/auth-utils'
import { FeatureGate } from '@/shared/components/composed/feature-gate'
import { PermissionGate } from '@/shared/components/composed/permission-gate'
import { AuditRepository } from '@/features/audit/lib/audit.repository'
import { AuditLogTable } from '@/features/audit/components/audit-log-table'
import { PageHeader } from '@/shared/components/composed/page-header'

export default async function AuditPage() {
  const user = await requireAuth()

  if (!user.currentTenantId) {
    return (
      <div className="p-6 space-y-6">
        <PageHeader title="Audit Log" description="No tenant selected. Please select a tenant first." />
      </div>
    )
  }

  return (
    <FeatureGate feature="auditLog">
      <PermissionGate
        permission="audit.view"
        fallback={
          <div className="p-6 space-y-6">
            <PageHeader title="Audit Log" description="You do not have permission to view audit logs." />
          </div>
        }
      >
        <AuditPageContent tenantId={user.currentTenantId} />
      </PermissionGate>
    </FeatureGate>
  )
}

async function AuditPageContent({ tenantId }: { tenantId: string }) {
  const [{ events, total }, stats, subjects, connections] = await Promise.all([
    AuditRepository.findAll({ tenantId, limit: 50, offset: 0 }),
    AuditRepository.getStats(tenantId),
    AuditRepository.getDistinctSubjects(tenantId),
    AuditRepository.getConnections(tenantId),
  ])

  // Serialize dates for client component
  const serializedEvents = events.map(({ startedAt, finishedAt: _finishedAt, ...event }) => ({
    ...event,
    startedAt: startedAt.toISOString(),
  }))

  return (
    <div className="p-6 space-y-6">
      <PageHeader title="Audit Log" description="Every query that users ran through Studio." />
      <AuditLogTable
        initialEvents={serializedEvents}
        initialTotal={total}
        subjects={subjects}
        connections={connections}
        stats={stats}
      />
    </div>
  )
}
