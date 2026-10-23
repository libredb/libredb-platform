import type { CurrentUser } from '../../src/shared/types'
import { apiV1ErrorResponse } from '../../src/shared/lib/bearer/api-v1-response'
import { ForbiddenError } from '../../src/shared/lib/errors'
import { PERMISSIONS, SYSTEM_ROLES } from '../../src/shared/lib/permissions'

// A stand-in for the module of withBearer, for the route tests of /api/v1 endpoints: the token check has its own tests
// (src/shared/lib/bearer), so a route test starts from the user that withBearer gives a valid admin token.

export const INSTALL_TENANT = { id: 'tenant-install', name: 'Acme', slug: 'default' }

/** The user of a Platform admin's bearer token, as authenticateBearer builds it. */
export function bearerAdmin(): CurrentUser {
  return {
    id: 'user-alice',
    email: 'alice@libredb.test',
    name: 'Alice',
    authProvider: 'keycloak',
    currentTenantId: INSTALL_TENANT.id,
    membershipId: null,
    roles: [SYSTEM_ROLES.PLATFORM_ADMIN],
    permissions: Object.values(PERMISSIONS),
    accessibleTenants: [INSTALL_TENANT],
    directoryDegraded: false,
  }
}

/** withBearer without the token check: the handler runs as bearerAdmin, and its errors answer the /api/v1 contract. */
export function fakeBearerModule() {
  return {
    withBearer<Context>(handler: (user: CurrentUser, request: Request, context: Context) => Promise<Response>) {
      return async (request: Request, context: Context): Promise<Response> => {
        try {
          return await handler(bearerAdmin(), request, context)
        } catch (error) {
          return apiV1ErrorResponse(error)
        }
      }
    },
  }
}

/**
 * The permission checks of auth-utils without its session reader, whose Auth.js import needs the Next.js runtime: the
 * rule of requirePermission, under which a Platform admin holds every permission.
 */
export function fakeAuthUtilsModule() {
  return {
    async requirePermission(user: CurrentUser, permission: string): Promise<void> {
      if (user.roles.includes(SYSTEM_ROLES.PLATFORM_ADMIN)) return
      if (!user.permissions.includes(permission)) throw new ForbiddenError(permission)
    },
  }
}
