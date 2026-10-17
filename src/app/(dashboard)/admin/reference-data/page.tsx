import { requireAuth, requireRole } from '@/shared/lib/auth-utils'
import { db } from '@/shared/lib/db'
import { ReferenceDataManager } from '@/features/tenants/components/reference-data-manager'

export default async function ReferenceDataPage() {
  const user = await requireAuth()
  await requireRole(user, 'PLATFORM_ADMIN')

  const types = await db.referenceType.findMany({
    orderBy: { sortOrder: 'asc' },
    include: {
      values: {
        orderBy: { sortOrder: 'asc' },
      },
    },
  })

  const serialized = types.map((t) => ({
    id: t.id,
    code: t.code,
    name: t.name,
    description: t.description,
    category: t.category,
    isSystem: t.isSystem,
    isActive: t.isActive,
    values: t.values.map((v) => ({
      id: v.id,
      code: v.code,
      name: v.name,
      description: v.description,
      translations: v.translations as Record<string, unknown> | null,
      colorCode: v.colorCode,
      icon: v.icon,
      isActive: v.isActive,
      sortOrder: v.sortOrder,
    })),
  }))

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Reference Data</h1>
        <p className="text-sm text-muted-foreground">
          Manage reference types and their values (LOV).
        </p>
      </div>
      <ReferenceDataManager types={serialized} />
    </div>
  )
}
