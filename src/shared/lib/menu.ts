import { db } from './db'
import { cache } from 'react'
import { resolveMenuLinks } from './menu-links'
import { getRuntimeConfig } from './runtime-config'
import { getDeploymentMode, type DeploymentMode } from './deployment'

export interface MenuItem {
  id: string
  code: string
  name: string
  url: string | null
  icon: string | null
  sortOrder: number
  level: number
  parentId: string | null
  external: boolean
  children: MenuItem[]
}

/**
 * Menu codes of features that exist only in cloud mode. ADMIN_USERS lists tenant memberships, which a self-hosted
 * sign-in never writes; STUDIO_USERS lists the users of a self-hosted install instead.
 */
export const CLOUD_ONLY_MENU_CODES: readonly string[] = ['BILLING', 'TEAM', 'ADMIN_TENANTS', 'ADMIN_USERS', 'ADMIN_PLANS']

/** Menu codes of features that exist only in self-hosted mode; a slice adds its code with a failing test. */
export const SELF_HOSTED_ONLY_MENU_CODES: readonly string[] = ['STUDIO_SETTINGS', 'STUDIO_USERS', 'ADMIN_LICENSE']

/** The menu codes that exist only in each mode, so every other mode hides them. */
export type ModeOnlyMenuCodes = Readonly<Record<DeploymentMode, readonly string[]>>

const MODE_ONLY_MENU_CODES: ModeOnlyMenuCodes = {
  cloud: CLOUD_ONLY_MENU_CODES,
  'self-hosted': SELF_HOSTED_ONLY_MENU_CODES,
}

/** Drops the menus that exist only in a mode other than `mode`. */
export function menusForMode<T extends { code: string }>(
  menus: T[],
  mode: DeploymentMode,
  modeOnly: ModeOnlyMenuCodes = MODE_ONLY_MENU_CODES,
): T[] {
  const hidden = new Set(
    (Object.keys(modeOnly) as DeploymentMode[]).filter(other => other !== mode).flatMap(other => modeOnly[other]),
  )
  return menus.filter(menu => !hidden.has(menu.code))
}

export const getAuthorizedMenus = cache(async (roles: string[]): Promise<MenuItem[]> => {
  const mode = getDeploymentMode()
  const isPlatformAdmin = roles.includes('PLATFORM_ADMIN')

  let menus
  if (isPlatformAdmin) {
    // Platform admins see all active menus
    menus = menusForMode(await db.menu.findMany({
      where: { active: true },
      orderBy: { sortOrder: 'asc' },
    }), mode)
  } else {
    // Others see menus linked to their roles via MenuRole
    const systemRoles = await db.role.findMany({
      where: { code: { in: roles }, isSystem: true },
      select: { id: true },
    })
    const roleIds = systemRoles.map(r => r.id)

    const menuRoles = await db.menuRole.findMany({
      where: { roleId: { in: roleIds } },
      include: { menu: true },
    })

    // Filtered before parents are added, so a menu of another mode never pulls in its parent.
    const menuMap = new Map(menusForMode(menuRoles.map(mr => mr.menu), mode).map(menu => [menu.id, menu]))

    // Auto-include parent menus when child is authorized
    for (const menu of menuMap.values()) {
      if (menu.parentId && !menuMap.has(menu.parentId)) {
        const parent = await db.menu.findUnique({ where: { id: menu.parentId } })
        if (parent) menuMap.set(parent.id, parent)
      }
    }

    menus = Array.from(menuMap.values()).sort((a, b) => a.sortOrder - b.sortOrder)
  }

  // Build tree
  const menuItems: MenuItem[] = menus.map(m => ({
    id: m.id,
    code: m.code,
    name: m.name,
    url: m.url,
    icon: m.icon,
    sortOrder: m.sortOrder,
    level: m.level,
    parentId: m.parentId,
    external: false,
    children: [],
  }))

  const itemMap = new Map(menuItems.map(m => [m.id, m]))
  const roots: MenuItem[] = []

  for (const item of menuItems) {
    if (item.parentId && itemMap.has(item.parentId)) {
      itemMap.get(item.parentId)!.children.push(item)
    } else {
      roots.push(item)
    }
  }

  return resolveMenuLinks(roots, getRuntimeConfig())
})
