import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const db = vi.hoisted(() => ({
  menu: { findMany: vi.fn(), findUnique: vi.fn() },
  role: { findMany: vi.fn() },
  menuRole: { findMany: vi.fn() },
}))

vi.mock('./db', () => ({ db }))
// Menu links read the validated runtime configuration; these tests cover the mode filter, not the links.
vi.mock('./runtime-config', () => ({ getRuntimeConfig: () => ({}) }))

import {
  CLOUD_ONLY_MENU_CODES,
  SELF_HOSTED_ONLY_MENU_CODES,
  getAuthorizedMenus,
  menusForMode,
} from './menu'

interface MenuRow {
  id: string
  code: string
  name: string
  url: string | null
  icon: string | null
  sortOrder: number
  level: number
  parentId: string | null
}

function row(code: string, sortOrder: number, parentId: string | null = null): MenuRow {
  return {
    id: code.toLowerCase(),
    code,
    name: code,
    url: `/${code.toLowerCase()}`,
    icon: null,
    sortOrder,
    level: parentId ? 1 : 0,
    parentId,
  }
}

// The seeded menu of the production seed, with the cloud-only items among the others.
const MENU_ROWS = [
  row('CONNECTIONS', 0),
  row('TEAM', 2),
  row('BILLING', 4),
  row('ADMIN', 9),
  row('ADMIN_DASHBOARD', 10, 'admin'),
  row('ADMIN_TENANTS', 11, 'admin'),
  row('ADMIN_USERS', 12, 'admin'),
  row('ADMIN_PLANS', 13, 'admin'),
]

/** The codes of the menu tree, depth first. */
function codes(items: { code: string; children: { code: string }[] }[]): string[] {
  return items.flatMap(item => [item.code, ...codes(item.children as typeof items)])
}

describe('getAuthorizedMenus', () => {
  beforeEach(() => {
    db.menu.findMany.mockResolvedValue(MENU_ROWS)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.clearAllMocks()
  })

  it('self-hosted hides BILLING, TEAM, ADMIN_TENANTS, ADMIN_USERS and ADMIN_PLANS from PLATFORM_ADMIN', async () => {
    vi.stubEnv('DEPLOYMENT_MODE', 'self-hosted')

    const menus = await getAuthorizedMenus(['PLATFORM_ADMIN'])

    expect(codes(menus)).toEqual(['CONNECTIONS', 'ADMIN', 'ADMIN_DASHBOARD'])
  })

  it('cloud mode keeps BILLING, TEAM, ADMIN_TENANTS, ADMIN_USERS and ADMIN_PLANS for PLATFORM_ADMIN', async () => {
    vi.stubEnv('DEPLOYMENT_MODE', 'cloud')

    const menus = await getAuthorizedMenus(['PLATFORM_ADMIN'])

    expect(codes(menus)).toEqual([
      'CONNECTIONS', 'TEAM', 'BILLING', 'ADMIN', 'ADMIN_DASHBOARD', 'ADMIN_TENANTS', 'ADMIN_USERS', 'ADMIN_PLANS',
    ])
  })

  it('self-hosted hides a cloud-only child from a role that holds it, and the parent it would pull in', async () => {
    vi.stubEnv('DEPLOYMENT_MODE', 'self-hosted')
    db.role.findMany.mockResolvedValue([{ id: 'role-tech' }])
    db.menuRole.findMany.mockResolvedValue([
      { menu: row('CONNECTIONS', 0) },
      { menu: row('ADMIN_TENANTS', 11, 'admin') },
    ])
    db.menu.findUnique.mockResolvedValue(row('ADMIN', 9))

    const menus = await getAuthorizedMenus(['PLATFORM_TECH'])

    expect(codes(menus)).toEqual(['CONNECTIONS'])
    expect(db.menu.findUnique).not.toHaveBeenCalled()
  })

  it('throws when DEPLOYMENT_MODE is unset', async () => {
    vi.stubEnv('DEPLOYMENT_MODE', undefined)

    await expect(getAuthorizedMenus(['PLATFORM_ADMIN'])).rejects.toThrow('DEPLOYMENT_MODE is required')
  })
})

describe('menusForMode', () => {
  it('lists BILLING, TEAM, ADMIN_TENANTS, ADMIN_USERS and ADMIN_PLANS as cloud-only', () => {
    expect([...CLOUD_ONLY_MENU_CODES].sort()).toEqual(['ADMIN_PLANS', 'ADMIN_TENANTS', 'ADMIN_USERS', 'BILLING', 'TEAM'])
  })

  it('cloud mode hides a code listed in SELF_HOSTED_ONLY_MENU_CODES', () => {
    const rows = [row('CONNECTIONS', 0), row('STUDIO_USERS', 1), row('BILLING', 2)]
    const modeOnly = { cloud: CLOUD_ONLY_MENU_CODES, 'self-hosted': [...SELF_HOSTED_ONLY_MENU_CODES, 'STUDIO_USERS'] }

    expect(menusForMode(rows, 'cloud', modeOnly).map(m => m.code)).toEqual(['CONNECTIONS', 'BILLING'])
    expect(menusForMode(rows, 'self-hosted', modeOnly).map(m => m.code)).toEqual(['CONNECTIONS', 'STUDIO_USERS'])
  })

  it('cloud mode hides STUDIO_SETTINGS', () => {
    const rows = [row('CONNECTIONS', 0), row('STUDIO_SETTINGS', 7)]

    expect(SELF_HOSTED_ONLY_MENU_CODES).toContain('STUDIO_SETTINGS')
    expect(menusForMode(rows, 'cloud').map(m => m.code)).toEqual(['CONNECTIONS'])
    expect(menusForMode(rows, 'self-hosted').map(m => m.code)).toEqual(['CONNECTIONS', 'STUDIO_SETTINGS'])
  })

  it('cloud mode hides STUDIO_USERS', () => {
    const rows = [row('CONNECTIONS', 0), row('STUDIO_USERS', 8)]

    expect(SELF_HOSTED_ONLY_MENU_CODES).toContain('STUDIO_USERS')
    expect(menusForMode(rows, 'cloud').map(m => m.code)).toEqual(['CONNECTIONS'])
    expect(menusForMode(rows, 'self-hosted').map(m => m.code)).toEqual(['CONNECTIONS', 'STUDIO_USERS'])
  })

  it('cloud mode hides ADMIN_LICENSE, because licensing applies only to a self-hosted install', () => {
    const rows = [row('ADMIN', 9), row('ADMIN_USERS', 12, 'admin'), row('ADMIN_LICENSE', 16, 'admin')]

    expect(SELF_HOSTED_ONLY_MENU_CODES).toContain('ADMIN_LICENSE')
    expect(menusForMode(rows, 'cloud').map(m => m.code)).toEqual(['ADMIN', 'ADMIN_USERS'])
    expect(menusForMode(rows, 'self-hosted').map(m => m.code)).toEqual(['ADMIN', 'ADMIN_LICENSE'])
  })

  it('cloud mode hides every code of SELF_HOSTED_ONLY_MENU_CODES with the default lists', () => {
    const rows = SELF_HOSTED_ONLY_MENU_CODES.map((code, index) => row(code, index))

    expect(menusForMode(rows, 'cloud')).toEqual([])
  })
})
