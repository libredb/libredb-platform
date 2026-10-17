import { describe, it, expect } from 'vitest'
import { landingPathFor } from './landing'
import { ROLE_PERMISSIONS } from './permissions'

describe('landingPathFor', () => {
  it('PLATFORM_ADMIN and connection.view land on /connections', () => {
    expect(landingPathFor({ roles: ['PLATFORM_ADMIN'], permissions: [] })).toBe('/connections')
    expect(landingPathFor({ roles: ['TENANT_ADMIN'], permissions: ['connection.view'] })).toBe('/connections')
  })

  it('a user without connection.view lands on /support', () => {
    expect(landingPathFor({ roles: ['PLATFORM_SUPPORT'], permissions: ['ticket.view'] })).toBe('/support')
    expect(landingPathFor({ roles: [], permissions: [] })).toBe('/support')
  })

  it('a TENANT_VIEWER lands on /support', () => {
    expect(landingPathFor({ roles: ['TENANT_VIEWER'], permissions: [...ROLE_PERMISSIONS.TENANT_VIEWER] })).toBe('/support')
    expect(landingPathFor({ roles: ['TENANT_EDITOR'], permissions: [...ROLE_PERMISSIONS.TENANT_EDITOR] })).toBe('/support')
  })
})
