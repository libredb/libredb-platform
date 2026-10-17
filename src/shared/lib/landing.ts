import { PERMISSIONS, SYSTEM_ROLES } from './permissions'
import type { CurrentUser } from '../types'

export function landingPathFor(user: Pick<CurrentUser, 'roles' | 'permissions'>): string {
  if (user.roles.includes(SYSTEM_ROLES.PLATFORM_ADMIN)) return '/connections'
  if (user.permissions.includes(PERMISSIONS.CONNECTION_VIEW)) return '/connections'
  return '/support'
}
