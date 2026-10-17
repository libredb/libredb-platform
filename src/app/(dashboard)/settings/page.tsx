import { requireAuth, requirePermission } from '@/shared/lib/auth-utils'
import { PERMISSIONS } from '@/shared/lib/permissions'
import { db } from '@/shared/lib/db'
import { NotFoundError } from '@/shared/lib/errors'
import { TenantSettingsForm } from '@/features/tenants/components/tenant-settings-form'
import { PageHeader } from '@/shared/components/composed/page-header'

export default async function SettingsPage() {
  const user = await requireAuth()
  await requirePermission(user, PERMISSIONS.SETTINGS_VIEW)

  const tenantId = user.currentTenantId
  if (!tenantId) {
    return (
      <div className="p-6 space-y-6">
        <PageHeader title="Settings" description="Please select a tenant first." />
      </div>
    )
  }

  const tenant = await db.tenant.findUnique({
    where: { id: tenantId },
    select: {
      name: true,
      logoUrl: true,
      settings: true,
    },
  })

  if (!tenant) throw new NotFoundError('Tenant')

  const canEdit = user.permissions.includes(PERMISSIONS.SETTINGS_EDIT)

  return (
    <div className="p-6 space-y-6">
      <PageHeader title="Settings" description="Manage your organization settings." />
      {canEdit ? (
        <TenantSettingsForm
          tenant={{
            name: tenant.name,
            logoUrl: tenant.logoUrl,
            settings: tenant.settings as Record<string, unknown> | null,
          }}
        />
      ) : (
        <div className="max-w-lg space-y-4">
          <div>
            <p className="text-sm font-medium text-muted-foreground">Tenant Name</p>
            <p className="text-sm">{tenant.name}</p>
          </div>
          <div>
            <p className="text-sm font-medium text-muted-foreground">Logo URL</p>
            <p className="text-sm">{tenant.logoUrl ?? 'Not set'}</p>
          </div>
          <div>
            <p className="text-sm font-medium text-muted-foreground">Default Locale</p>
            <p className="text-sm">
              {(tenant.settings as any)?.locale === 'tr' ? 'Turkish' : 'English'}
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
