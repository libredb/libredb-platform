import type { CurrentUser } from '../../types'
import { db } from '../db'
import { AppError, ConfigError } from '../errors'
import { admitInstallAdmin } from '../identity/install-admin'
import { getInstallTenant } from '../identity/install-tenant'
import { provisionKeycloakUser } from '../identity/keycloak-provisioning'
import { logger } from '../logger'
import { PERMISSIONS, SYSTEM_ROLES } from '../permissions'
import { getRuntimeConfig } from '../runtime-config'
import { apiV1ErrorResponse } from './api-v1-response'
import { ApiDisabledError, BearerInvalidError } from './errors'
import { getIssuerKeys } from './issuer-keys'
import { verifyAccessToken } from './verify-access-token'

// The credentials of an Authorization header in the Bearer scheme, whose name is case-insensitive (RFC 9110).
const BEARER = /^Bearer +([^ ]+)$/i

function readBearerToken(request: Request): string {
  const match = BEARER.exec(request.headers.get('authorization') ?? '')
  if (match === null) throw new BearerInvalidError('The request carries no bearer token')
  return match[1]
}

/**
 * The Platform user of the bearer token of a /api/v1 request, in the shape of a Keycloak web session: a Platform admin
 * of the install tenant with every permission and no membership, so the feature functions see the same user as a web
 * session.
 * The first call of an account provisions its Platform user and takes an admin seat exactly as the web sign-in does
 * (admitInstallAdmin). Unlike a web session, no call rechecks the account against the Keycloak directory: that recheck
 * exists to end a long-lived cookie session, and the short lifetime of the access token ends a bearer's access instead.
 * Throws ApiDisabledError in cloud mode and without PLATFORM_API_AUDIENCE, and the refusals of verifyAccessToken.
 */
export async function authenticateBearer(request: Request): Promise<CurrentUser> {
  const config = getRuntimeConfig()
  if (
    config.DEPLOYMENT_MODE !== 'self-hosted' ||
    config.PLATFORM_API_AUDIENCE === undefined ||
    config.PLATFORM_API_CLIENT_IDS === undefined
  ) {
    throw new ApiDisabledError()
  }
  // readRuntimeConfig requires the issuer in self-hosted mode; this guards any other caller.
  if (config.AUTH_KEYCLOAK_ISSUER === undefined) throw new ConfigError('AUTH_KEYCLOAK_ISSUER is required in self-hosted mode')

  const token = readBearerToken(request)
  const identity = await verifyAccessToken(
    token,
    {
      issuer: config.AUTH_KEYCLOAK_ISSUER,
      audience: config.PLATFORM_API_AUDIENCE,
      clientIds: config.PLATFORM_API_CLIENT_IDS,
      roleClaim: config.PLATFORM_ROLE_CLAIM,
      adminRole: config.PLATFORM_ADMIN_ROLE,
    },
    getIssuerKeys(config.AUTH_KEYCLOAK_ISSUER),
  )
  await admitInstallAdmin(identity)
  const tenant = await getInstallTenant()
  const user = await provisionKeycloakUser(db, identity)
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    authProvider: 'keycloak',
    currentTenantId: tenant.id,
    membershipId: null,
    roles: [SYSTEM_ROLES.PLATFORM_ADMIN],
    permissions: Object.values(PERMISSIONS),
    accessibleTenants: [{ id: tenant.id, name: tenant.name, slug: tenant.slug }],
    directoryDegraded: false,
  }
}

/**
 * Wraps a route handler of the bearer API: the handler runs with the user of the request's bearer token
 * (authenticateBearer), and every error it or the authentication raises answers with the /api/v1 error contract
 * (api-v1-response.ts).
 */
export function withBearer<Context>(
  handler: (user: CurrentUser, request: Request, context: Context) => Promise<Response>,
) {
  return async (request: Request, context: Context): Promise<Response> => {
    try {
      const user = await authenticateBearer(request)
      return await handler(user, request, context)
    } catch (error) {
      if (error instanceof AppError) logger.warn('Bearer API request refused', { code: error.code, status: error.statusCode })
      return apiV1ErrorResponse(error)
    }
  }
}
