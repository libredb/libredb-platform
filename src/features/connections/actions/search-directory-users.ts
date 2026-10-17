'use server'

import { safeAction } from '@/shared/lib/safe-action'
import { requirePermission } from '@/shared/lib/auth-utils'
import { PERMISSIONS } from '@/shared/lib/permissions'
import { requireDirectory } from '@/shared/lib/directory-guard'
import { getKeycloakDirectory } from '@/shared/lib/keycloak/directory'
import { getLicenseStatus } from '@/shared/lib/license/install-license'
import { getRuntimeConfig } from '@/shared/lib/runtime-config'
import { ConnectionGrantRepository } from '../lib/grant.repository'
import {
  DIRECTORY_PAGE_SIZE,
  searchDirectoryUsersSchema,
  studioRoleOf,
  type DirectoryUserPage,
} from '../lib/grant.schema'

/**
 * One page of the Keycloak users the grant picker offers, 20 per page, each with the badge of the Studio role their
 * effective roles give. Keycloak 26.8.1 matches a search against the start of the username, first name,
 * last name or email, so the typed text is wrapped in `*` to match anywhere in them. Disabled users are listed with
 * `enabled` false, because a grant to one is refused. Refused while the session cannot read the directory.
 * Where the license of a self-hosted install applies, each user who holds no user seat is marked, because a grant to
 * them takes one while its connection is active.
 */
export const searchDirectoryUsers = safeAction(
  'searchDirectoryUsers',
  searchDirectoryUsersSchema,
  async ({ search, page }, user): Promise<DirectoryUserPage> => {
    await requirePermission(user, PERMISSIONS.CONNECTION_EDIT)
    requireDirectory(user)

    const directory = getKeycloakDirectory()
    const { PLATFORM_ADMIN_ROLE, STUDIO_USER_ROLE } = getRuntimeConfig()
    const pattern = search === '' ? undefined : `*${search}*`
    const [found, total] = await Promise.all([
      directory.searchUsers({ search: pattern, first: (page - 1) * DIRECTORY_PAGE_SIZE, max: DIRECTORY_PAGE_SIZE }),
      directory.countUsers(pattern),
    ])
    const [roles, seatHolders] = await Promise.all([
      Promise.all(found.map((match) => directory.getEffectiveRoles(match.id))),
      getLicenseStatus() === null ? null : ConnectionGrantRepository.userSeatHolders(found.map((match) => match.id)),
    ])
    const users = found.map((match, index) => ({
      ...match,
      studioRole: studioRoleOf(roles[index], PLATFORM_ADMIN_ROLE, STUDIO_USER_ROLE),
      needsSeat: seatHolders !== null && !seatHolders.has(match.id),
    }))
    return { users, page, total }
  },
)
