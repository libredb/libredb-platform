import { describe, it, expect } from 'vitest'
import {
  PERMISSIONS,
  ROLE_PERMISSIONS,
  SYSTEM_ROLES,
  RESERVED_ROLE_CODES,
  TENANT_ASSIGNABLE_PERMISSIONS,
  TENANT_ASSIGNABLE_SYSTEM_ROLES,
  isReservedRoleCode,
  isTenantAssignableRole,
  sessionRoleCodes,
} from './permissions'

function userRole(code: string, isSystem: boolean) {
  return { role: { code, isSystem } }
}

describe('sessionRoleCodes', () => {
  it('sessionRoleCodes drops PLATFORM_ADMIN from a custom role and keeps it for the system role', () => {
    expect(sessionRoleCodes([userRole('PLATFORM_ADMIN', false)])).toEqual([])
    expect(sessionRoleCodes([userRole('PLATFORM_ADMIN', true)])).toEqual(['PLATFORM_ADMIN'])
  })

  it('drops every reserved code of a custom role and keeps the other codes', () => {
    const roles = [
      userRole('TENANT_ADMIN', false),
      userRole('PLATFORM_X', false),
      userRole('DATA_ANALYST', false),
      userRole('TENANT_EDITOR', true),
    ]

    expect(sessionRoleCodes(roles)).toEqual(['DATA_ANALYST', 'TENANT_EDITOR'])
  })
})

describe('reserved role codes', () => {
  it('reserves the six system role codes and every code starting with PLATFORM_', () => {
    expect([...RESERVED_ROLE_CODES].sort()).toEqual(Object.values(SYSTEM_ROLES).sort())
    for (const code of [...Object.values(SYSTEM_ROLES), 'PLATFORM_X']) {
      expect(isReservedRoleCode(code), code).toBe(true)
    }
    expect(isReservedRoleCode('DATA_ANALYST')).toBe(false)
  })
})

describe('tenant-assignable roles and permissions', () => {
  it('assigns the three TENANT_ system roles and the unreserved custom roles of the same tenant only', () => {
    expect(TENANT_ASSIGNABLE_SYSTEM_ROLES).toEqual(['TENANT_ADMIN', 'TENANT_EDITOR', 'TENANT_VIEWER'])

    const systemRole = (code: string) => ({ code, isSystem: true, tenantId: null })
    const customRole = (code: string, tenantId: string | null) => ({ code, isSystem: false, tenantId })

    for (const code of TENANT_ASSIGNABLE_SYSTEM_ROLES) {
      expect(isTenantAssignableRole(systemRole(code), 'tenant-1'), code).toBe(true)
    }
    for (const code of ['PLATFORM_ADMIN', 'PLATFORM_TECH', 'PLATFORM_SUPPORT']) {
      expect(isTenantAssignableRole(systemRole(code), 'tenant-1'), code).toBe(false)
    }
    expect(isTenantAssignableRole(customRole('DATA_ANALYST', 'tenant-1'), 'tenant-1')).toBe(true)
    expect(isTenantAssignableRole(customRole('DATA_ANALYST', 'tenant-2'), 'tenant-1')).toBe(false)
    expect(isTenantAssignableRole(customRole('DATA_ANALYST', null), 'tenant-1')).toBe(false)
    expect(isTenantAssignableRole(customRole('PLATFORM_ADMIN', 'tenant-1'), 'tenant-1')).toBe(false)
  })

  it('limits the tenant-assignable permissions to the TENANT_ADMIN set', () => {
    expect([...TENANT_ASSIGNABLE_PERMISSIONS]).toEqual(ROLE_PERMISSIONS.TENANT_ADMIN)
    expect(TENANT_ASSIGNABLE_PERMISSIONS).not.toContain(PERMISSIONS.PLATFORM_DASHBOARD)
    expect(TENANT_ASSIGNABLE_PERMISSIONS).not.toContain(PERMISSIONS.TENANT_MANAGE)
  })
})

describe('default role permissions', () => {
  it('TENANT_EDITOR and TENANT_VIEWER do not hold connection.view', () => {
    expect(ROLE_PERMISSIONS.TENANT_EDITOR).not.toContain(PERMISSIONS.CONNECTION_VIEW)
    expect(ROLE_PERMISSIONS.TENANT_VIEWER).not.toContain(PERMISSIONS.CONNECTION_VIEW)
    expect(ROLE_PERMISSIONS.TENANT_ADMIN).toContain(PERMISSIONS.CONNECTION_VIEW)
  })
})
