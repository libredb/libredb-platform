/**
 * What the pages of this install show about its license before any write: the notice of the dashboard banner and the
 * refusal of a new connection, read through the database and, for the admin seats, through the Keycloak directory of
 * this process. Licensing applies only in self-hosted mode, so cloud mode shows neither.
 *
 * Server code only, because it reads the runtime configuration, the database and Keycloak.
 */
import { db } from '../db'
import { licenseLimitMessage } from '../errors'
import { isDirectoryFailure } from '../identity/session-recheck'
import { KeycloakUnavailableError } from '../keycloak/errors'
import { logger } from '../logger'
import type { CurrentUser } from '../../types'
import { getAdminSeatUsage } from './install-admin-seats'
import { getLicenseStatus } from './install-license'
import { licenseNotice, type LicenseNotice } from './notice'
import { newConnectionRefusal } from './refusals'
import { countUserSeatsInUse } from './user-seats'

/**
 * The admin seats in use as Keycloak reports them, from a reading at most 60 seconds old, or null when Keycloak cannot
 * be asked: a degraded session reads nothing from it, and a directory that cannot be read, which the session recheck
 * also survives, is logged, not thrown, so the banner still shows the rest and the page renders. Every other failure,
 * such as a KeycloakConfigError, is thrown.
 */
async function adminSeatsInUse(user: Pick<CurrentUser, 'id' | 'directoryDegraded'>): Promise<number | null> {
  if (user.directoryDegraded) return null
  try {
    const usage = await getAdminSeatUsage()
    return usage === null ? null : usage.seatsInUse
  } catch (error) {
    if (!isDirectoryFailure(error)) throw error
    if (error instanceof KeycloakUnavailableError) {
      logger.warn('License notice: the Keycloak directory is unreachable', { userId: user.id, error: error.message })
    } else {
      // Keycloak refused the client credentials or the service account's rights: no retry fixes that.
      logger.error("License notice: Keycloak refused Platform's service account, a configuration error", error, {
        userId: user.id,
      })
    }
    return null
  }
}

/**
 * The notice of the dashboard banner for this session, or null when there is none: in cloud mode, for a session
 * without PLATFORM_ADMIN, and for an active license or the free tier with no more seats in use than they allow.
 */
export async function getLicenseNotice(
  user: Pick<CurrentUser, 'id' | 'roles' | 'directoryDegraded'>,
): Promise<LicenseNotice | null> {
  if (!user.roles.includes('PLATFORM_ADMIN')) return null
  const status = getLicenseStatus()
  if (status === null) return null
  const [userSeats, adminSeats] = await Promise.all([countUserSeatsInUse(db), adminSeatsInUse(user)])
  return licenseNotice(status, { userSeats, adminSeats })
}

/**
 * The text the gate of a new connection would refuse with now, or null when it would allow one, which is always so in
 * cloud mode. The connections page shows it on a disabled New Connection; the gate decides when the connection is
 * created.
 */
export async function getNewConnectionRefusal(): Promise<string | null> {
  const status = getLicenseStatus()
  if (status === null) return null
  const code = newConnectionRefusal(status, await countUserSeatsInUse(db))
  return code === null ? null : licenseLimitMessage(code)
}
