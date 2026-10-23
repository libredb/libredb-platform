import NextAuth from 'next-auth'
import { cookies } from 'next/headers'
import { db } from './db'
import { getAuthSecrets } from './auth-secrets'
import { getRuntimeConfig } from './runtime-config'
import { authorizeCredentials } from './identity/authorize-credentials'
import { buildAuthCallbacks } from './identity/auth-callbacks'
import { loadCredentialsAccess } from './identity/credentials-session'
import { admitInstallAdmin } from './identity/install-admin'
import { getInstallTenant } from './identity/install-tenant'
import { provisionKeycloakUser } from './identity/keycloak-provisioning'
import { buildProviders } from './identity/providers'
import { getKeycloakDirectory } from './keycloak/directory'
import { refreshKeycloakSession } from './keycloak/token-refresh'

// The configuration is built on each use rather than at import, because `next build` imports this module without the
// runtime variables; getRuntimeConfig() then reads the validated variables once and caches them.
export const { handlers, auth, signIn, signOut } = NextAuth(() => {
  const config = getRuntimeConfig()
  return {
    secret: getAuthSecrets(config),
    // Keycloak alone in self-hosted mode, the Credentials provider alone in cloud mode.
    providers: buildProviders(config, {
      authorizeCredentials: credentials => authorizeCredentials(db, credentials),
    }),
    callbacks: buildAuthCallbacks({
      deploymentMode: config.DEPLOYMENT_MODE,
      roleClaim: config.PLATFORM_ROLE_CLAIM,
      adminRole: config.PLATFORM_ADMIN_ROLE,
      // The first sign-in of an admin takes an admin seat of the license, as the first call of the bearer API does.
      admitKeycloakAdmin: admitInstallAdmin,
      provisionKeycloakUser: identity => provisionKeycloakUser(db, identity),
      getInstallTenant,
      loadCredentialsAccess: (userId, tenantId) => loadCredentialsAccess(db, userId, tenantId),
      // switchTenantAction writes this cookie in cloud mode.
      readTenantCookie: async () => (await cookies()).get('libredb-current-tenant')?.value,
      // A Keycloak session asks the directory of this process whether it still stands.
      keycloakDirectory: getKeycloakDirectory,
      // Each due recheck first refreshes the Keycloak session at the issuer, which keeps an active admin's session alive.
      refreshKeycloakSession: refreshToken => refreshKeycloakSession(refreshToken),
      sessionRecheck: {
        intervalSeconds: config.PLATFORM_SESSION_RECHECK_SECONDS,
        graceSeconds: config.PLATFORM_RECHECK_GRACE_SECONDS,
      },
      now: () => Date.now(),
    }),
    // A refused sign-in, such as AccessDenied from the signIn callback, lands on /login?error=<code>, which the login
    // page explains, instead of the default error page of Auth.js.
    pages: {
      signIn: '/login',
      error: '/login',
    },
    session: {
      strategy: 'jwt',
      maxAge: 8 * 24 * 60 * 60,
    },
  }
})
