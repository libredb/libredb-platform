import { requireAuth, requirePermission } from '@/shared/lib/auth-utils'
import { UserRepository } from '@/features/users/lib/user.repository'
import { UserList } from '@/features/users/components/user-list'
import { InviteUserForm } from '@/features/users/components/invite-user-form'
import { RoleManager } from '@/features/users/components/role-manager'
import { getLimit, hasFeature } from '@/shared/lib/feature-flags'
import { Badge } from '@/shared/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/shared/components/ui/tabs'
import { db } from '@/shared/lib/db'
import { isTenantAssignableRole, TENANT_ASSIGNABLE_SYSTEM_ROLES } from '@/shared/lib/permissions'
import { PageHeader } from '@/shared/components/composed/page-header'
import { notFoundInSelfHosted } from '@/shared/lib/deployment'

export default async function TeamPage() {
  await notFoundInSelfHosted()
  const user = await requireAuth()
  await requirePermission(user, 'user.view')

  const tenantId = user.currentTenantId
  if (!tenantId) {
    return (
      <div className="p-6 space-y-6">
        <PageHeader title="Team" description="No tenant selected. Please select a tenant first." />
      </div>
    )
  }

  const [members, roles, maxUsers, canCreateCustomRoles] = await Promise.all([
    UserRepository.findByTenant(tenantId),
    UserRepository.findTenantRoles(tenantId),
    getLimit(tenantId, 'maxUsers'),
    hasFeature(tenantId, 'advancedRbac'),
  ])

  const canEdit = user.permissions.includes('user.edit') || user.roles.includes('PLATFORM_ADMIN')
  const canInvite = user.permissions.includes('user.invite') || user.roles.includes('PLATFORM_ADMIN')
  const canManageSettings = user.permissions.includes('settings.edit') || user.roles.includes('PLATFORM_ADMIN')

  // Serialize dates for client component
  const serializedMembers = members.map((m) => ({
    id: m.id,
    user: {
      id: m.user.id,
      email: m.user.email,
      name: m.user.name,
      active: m.user.active,
      lastLoginAt: m.user.lastLoginAt?.toISOString() ?? null,
    },
    roles: m.roles.map((r) => ({
      role: { id: r.role.id, code: r.role.code, name: r.role.name },
    })),
  }))

  // Fetch the tenant's roles and the tenant-assignable system roles with their
  // permissions, and all permissions, for the role manager
  const [rolesWithPermissions, allPermissions] = await Promise.all([
    db.role.findMany({
      where: {
        OR: [
          { tenantId },
          { isSystem: true, code: { in: [...TENANT_ASSIGNABLE_SYSTEM_ROLES] } },
        ],
      },
      include: {
        permissions: {
          include: {
            permission: {
              select: { id: true, code: true, name: true, category: true },
            },
          },
        },
      },
      orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
    }),
    db.permission.findMany({
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
    }),
  ])

  const assignableRoles = rolesWithPermissions.filter((r) => isTenantAssignableRole(r, tenantId))
  const serializedRoles = assignableRoles.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    isSystem: r.isSystem,
    permissions: r.permissions.map((rp) => ({
      permissionId: rp.permissionId,
      permission: rp.permission,
    })),
  }))

  const serializedPermissions = allPermissions.map((p) => ({
    id: p.id,
    code: p.code,
    name: p.name,
    category: p.category,
  }))

  return (
    <div className="p-6 space-y-6">
      <PageHeader title="Team" description="Manage your team members and their roles.">
        <Badge variant="secondary">
          {members.length} / {maxUsers === -1 ? 'Unlimited' : maxUsers} users
        </Badge>
        {canInvite && <InviteUserForm roles={roles} />}
      </PageHeader>

      <Tabs defaultValue="members">
        <TabsList>
          <TabsTrigger value="members">Members</TabsTrigger>
          {canManageSettings && <TabsTrigger value="roles">Roles & Permissions</TabsTrigger>}
        </TabsList>
        <TabsContent value="members">
          <UserList members={serializedMembers} roles={roles} canEdit={canEdit} />
        </TabsContent>
        {canManageSettings && (
          <TabsContent value="roles">
            <RoleManager
              roles={serializedRoles}
              permissions={serializedPermissions}
              canCreateCustomRoles={canCreateCustomRoles}
            />
          </TabsContent>
        )}
      </Tabs>
    </div>
  )
}
