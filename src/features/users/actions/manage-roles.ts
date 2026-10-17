'use server'

import { safeAction } from '@/shared/lib/safe-action'
import { assertCloudOnly } from '@/shared/lib/deployment'
import { z } from 'zod'
import { db } from '@/shared/lib/db'
import { requirePermission } from '@/shared/lib/auth-utils'
import { ForbiddenError, NotFoundError } from '@/shared/lib/errors'
import { isReservedRoleCode, TENANT_ASSIGNABLE_PERMISSIONS } from '@/shared/lib/permissions'
import { revalidatePath } from 'next/cache'

const createRoleSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters'),
  code: z.string().min(2, 'Code must be at least 2 characters').regex(/^[A-Z_]+$/, 'Code must be uppercase letters and underscores only'),
})

export const createCustomRole = safeAction(
  'createCustomRole',
  createRoleSchema,
  async (data, user) => {
    assertCloudOnly()
    await requirePermission(user, 'settings.edit')

    const tenantId = user.currentTenantId
    if (!tenantId) throw new Error('No tenant selected')

    // System role codes and PLATFORM_* codes belong to the platform's own roles
    if (isReservedRoleCode(data.code)) {
      throw new ForbiddenError(`role code ${data.code} is reserved`)
    }

    const role = await db.role.create({
      data: {
        name: data.name,
        code: data.code,
        tenantId,
        isSystem: false,
      },
    })

    revalidatePath('/team')
    return role
  },
)

const updatePermissionsSchema = z.object({
  roleId: z.string().min(1, 'Role ID is required'),
  permissionIds: z.array(z.string()),
})

export const updateRolePermissions = safeAction(
  'updateRolePermissions',
  updatePermissionsSchema,
  async (data, user) => {
    assertCloudOnly()
    await requirePermission(user, 'settings.edit')

    const tenantId = user.currentTenantId
    if (!tenantId) throw new Error('No tenant selected')

    // Only a role of the caller's tenant: a role of another tenant answers NotFound
    const role = await db.role.findFirst({ where: { id: data.roleId, tenantId } })
    if (!role) throw new NotFoundError('Role')

    // Only allow editing non-system roles
    if (role.isSystem) {
      throw new ForbiddenError('system role permissions are read-only')
    }

    // A custom role can hold only permissions that a TENANT_ADMIN holds
    const permissions = await db.permission.findMany({
      where: { id: { in: data.permissionIds } },
      select: { id: true, code: true },
    })
    const knownIds = new Set(permissions.map((permission) => permission.id))
    if (data.permissionIds.some((permissionId) => !knownIds.has(permissionId))) {
      throw new NotFoundError('Permission')
    }
    const refusedCodes = permissions
      .map((permission) => permission.code)
      .filter((code) => !TENANT_ASSIGNABLE_PERMISSIONS.includes(code))
    if (refusedCodes.length > 0) {
      throw new ForbiddenError(refusedCodes.join(', '))
    }

    // Delete existing permissions for this role
    await db.rolePermission.deleteMany({ where: { roleId: data.roleId } })

    // Create new permissions
    if (data.permissionIds.length > 0) {
      await db.rolePermission.createMany({
        data: data.permissionIds.map((permissionId) => ({
          roleId: data.roleId,
          permissionId,
        })),
      })
    }

    revalidatePath('/team')
    return { success: true }
  },
)
