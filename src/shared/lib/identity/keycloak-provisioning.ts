import type { PrismaClient } from '@prisma/client'
import {
  adminIdentities,
  identitiesWithoutAdminSeat,
  requireAdminSeat,
  type AdminSeatDirectory,
} from '../license/admin-seats'
import type { LicenseStatus } from '../license/state'
import type { KeycloakIdentity } from './keycloak-claims'

/** The Prisma delegate that just-in-time provisioning uses, injected so that it runs without the shared client. */
export type KeycloakProvisioningClient = Pick<PrismaClient, 'user'>

/** The Platform user of a Keycloak account. */
export interface ProvisionedUser {
  id: string
  email: string
  name: string | null
}

/**
 * Creates the Platform user of a Keycloak account on its first sign-in and refreshes it on every later one.
 * The row is found by keycloakId, the Keycloak `sub`, and never by email, which is only a label that two users may share:
 * an account whose email changes keeps its row, and a row of another account or of a cloud password user
 * with the same email is never touched.
 * Email, name and lastLoginAt follow the ID token of this sign-in.
 */
export async function provisionKeycloakUser(
  client: KeycloakProvisioningClient,
  identity: Pick<KeycloakIdentity, 'sub' | 'email' | 'name'>,
  signedInAt: Date = new Date(),
): Promise<ProvisionedUser> {
  const profile = { email: identity.email, name: identity.name, lastLoginAt: signedInAt }
  // keycloakId is unique and the only field of `where`, so Prisma sends one INSERT ... ON CONFLICT ("keycloakId"), and
  // concurrent first sign-ins of one account share one row instead of failing on the unique index.
  return client.user.upsert({
    where: { keycloakId: identity.sub },
    create: { keycloakId: identity.sub, ...profile },
    update: profile,
    select: { id: true, email: true, name: true },
  })
}

/** What the first sign-in of an admin reads besides the database. */
export interface AdminAdmission {
  /** The license status of the install now, or null in cloud mode, where licensing does not apply (install-license). */
  getLicenseStatus(): LicenseStatus | null
  /** The one tenant of a self-hosted install, whose row the admin-seat gate locks (install-tenant). */
  getInstallTenant(): Promise<{ id: string }>
  /** The Keycloak directory, which reports whether each admin identity still holds its seat. */
  directory(): AdminSeatDirectory
  /** PLATFORM_ADMIN_ROLE. */
  adminRole: string
}

/**
 * The Prisma client of the admission: the read of the identity's own user, the reads of the admin seats, and the
 * transaction that creates the user of a new admin.
 */
export type AdminAdmissionClient = Pick<PrismaClient, 'user' | '$queryRaw' | '$transaction'>

/**
 * Lets a Keycloak admin identity sign in under the license of the install, before the jwt callback refreshes its
 * Platform user. An identity that has a Platform user signs in in every state, after one read of that user by its unique
 * keycloakId, without reading the license, locking or asking Keycloak. The first sign-in of one without takes an admin
 * seat (license/admin-seats): Keycloak reports which admin identities still hold a seat before any transaction begins,
 * and one transaction then locks the install tenant, counts the seats and creates the user, so two first sign-ins
 * cannot both take the last seat.
 * Throws LicenseLimitError when the license refuses the seat, and leaves the first sign-in to the jwt callback in cloud
 * mode.
 */
export async function admitKeycloakAdmin(
  client: AdminAdmissionClient,
  identity: Pick<KeycloakIdentity, 'sub' | 'email' | 'name'>,
  admission: AdminAdmission,
  signedInAt: Date = new Date(),
): Promise<void> {
  const user = await client.user.findUnique({ where: { keycloakId: identity.sub }, select: { id: true } })
  if (user !== null) return
  const license = admission.getLicenseStatus()
  if (license === null) return
  // The tenant comes first, so that an install without exactly one tenant fails before Keycloak is asked.
  const tenant = await admission.getInstallTenant()
  // An invalid or expired license refuses every new admin whatever the seats, so Keycloak is not asked.
  const withoutSeat =
    license.state === 'invalid' || license.state === 'expired'
      ? new Set<string>()
      : await identitiesWithoutAdminSeat(
          admission.directory(),
          admission.adminRole,
          (await adminIdentities(client)).map((admin) => admin.keycloakId),
        )
  await client.$transaction(async (tx) => {
    await requireAdminSeat(tx, license, tenant.id, identity.sub, withoutSeat)
    await provisionKeycloakUser(tx, identity, signedInAt)
  })
}
