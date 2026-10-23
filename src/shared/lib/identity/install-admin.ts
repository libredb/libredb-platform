import { db } from '../db'
import { getKeycloakDirectory } from '../keycloak/directory'
import { getLicenseStatus } from '../license/install-license'
import { getRuntimeConfig } from '../runtime-config'
import { getInstallTenant } from './install-tenant'
import { admitKeycloakAdmin } from './keycloak-provisioning'
import type { KeycloakIdentity } from './keycloak-claims'

/**
 * Admits a Keycloak admin identity under the license of this install, the one admission of both the web sign-in
 * (auth.ts) and the bearer API (bearer/with-bearer.ts). The first admission of an identity takes an admin seat, which
 * Keycloak's report of the other admins decides before the transaction that creates the user; throws
 * LicenseLimitError when the license refuses it.
 */
export function admitInstallAdmin(identity: KeycloakIdentity): Promise<void> {
  return admitKeycloakAdmin(db, identity, {
    getLicenseStatus,
    getInstallTenant,
    directory: getKeycloakDirectory,
    adminRole: getRuntimeConfig().PLATFORM_ADMIN_ROLE,
  })
}
