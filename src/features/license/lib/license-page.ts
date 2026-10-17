import { db } from '@/shared/lib/db'
import { isDirectoryFailure } from '@/shared/lib/identity/session-recheck'
import { getKeycloakDirectory, type KeycloakDirectory } from '@/shared/lib/keycloak/directory'
import { KeycloakNotFoundError, KeycloakUnavailableError } from '@/shared/lib/keycloak/errors'
import type { LicenseErrorCode, LicenseStatus } from '@/shared/lib/license'
import type { AdminSeatState, AdminSeatUsage } from '@/shared/lib/license/admin-seats'
import { getAdminSeatUsage } from '@/shared/lib/license/install-admin-seats'
import { getLicenseStatus } from '@/shared/lib/license/install-license'
import { countUserSeatsInUse, listUserSeatHolders, type UserSeatHolder } from '@/shared/lib/license/user-seats'
import { logger } from '@/shared/lib/logger'
import { getRuntimeConfig } from '@/shared/lib/runtime-config'
import type { CurrentUser } from '@/shared/types'

/** The holders of user seats on one page of the License page, each of whom Keycloak is asked about. */
export const LICENSE_HOLDERS_PAGE_SIZE = 20

/** The license of the install as the page shows it, with its times as ISO strings. */
export type LicenseSummary =
  | { readonly state: 'free' }
  | { readonly state: 'invalid'; readonly code: LicenseErrorCode }
  | {
      readonly state: 'active' | 'expiring' | 'grace' | 'expired'
      readonly id: string
      readonly customer: string
      readonly issuedAt: string
      readonly expiresAt: string
      readonly graceEndsAt: string
      /** The hosts the license is bound to, or null for a license that any host may run. */
      readonly hosts: readonly string[] | null
    }

/** How Keycloak reports a holder of a user seat now, or `unknown` when it could not be asked. */
export type HolderAccount = 'admin' | 'user' | 'no-role' | 'disabled' | 'missing' | 'unknown'

export interface UserSeatHolderRow extends UserSeatHolder {
  readonly account: HolderAccount
}

/** An admin identity with how Keycloak reports it; only `admin` holds an admin seat. */
export interface AdminSeatHolderRow {
  readonly keycloakId: string
  readonly email: string
  readonly name: string | null
  readonly state: AdminSeatState
}

/**
 * Whether the page could ask Keycloak: not while the session is degraded, not when Keycloak did not answer, and not
 * when it refused Platform's client credentials or the rights of its service account.
 */
export type DirectoryReading = 'available' | 'degraded' | 'unreachable' | 'refused'

export interface LicensePageData {
  readonly license: LicenseSummary
  readonly adminSeats: {
    readonly allowed: number
    /** Null when Keycloak could not be asked. */
    readonly inUse: number | null
    /** Every admin identity by email, or null when Keycloak could not be asked. */
    readonly holders: readonly AdminSeatHolderRow[] | null
  }
  readonly userSeats: {
    readonly allowed: number
    readonly inUse: number
    /** The holders of the page shown, by username. */
    readonly holders: readonly UserSeatHolderRow[]
    /** The page shown, from 1: the last page when the query asked for one past it. */
    readonly page: number
    /** The number of pages, at least 1. */
    readonly pageCount: number
  }
  readonly directory: DirectoryReading
}

/** The page of holders that the query asks for: `page`, a whole number from 1, or else the first page. */
export function parseHoldersPage(query: Record<string, string | string[] | undefined>): number {
  return typeof query.page === 'string' && /^[1-9][0-9]{0,5}$/.test(query.page) ? Number(query.page) : 1
}

function summaryOf(status: LicenseStatus): LicenseSummary {
  if (status.state === 'free') return { state: 'free' }
  if (status.state === 'invalid') return { state: 'invalid', code: status.code }
  const iso = (seconds: number) => new Date(seconds * 1000).toISOString()
  return {
    state: status.state,
    id: status.license.id,
    customer: status.license.customer,
    issuedAt: iso(status.license.issuedAt),
    expiresAt: iso(status.boundaries.expiresAt),
    graceEndsAt: iso(status.boundaries.graceEndsAt),
    hosts: status.license.hosts === undefined ? null : [...status.license.hosts],
  }
}

/**
 * How Keycloak reports the account now, in the order of the session recheck: missing, disabled, and then its roles.
 * A user deleted between the two reads counts as missing.
 */
async function holderAccount(
  directory: Pick<KeycloakDirectory, 'getUser' | 'getEffectiveRoles'>,
  roles: { adminRole: string; userRole: string },
  subject: string,
): Promise<HolderAccount> {
  const user = await directory.getUser(subject)
  if (user === null) return 'missing'
  if (!user.enabled) return 'disabled'
  let effective: string[]
  try {
    effective = await directory.getEffectiveRoles(subject)
  } catch (error) {
    if (error instanceof KeycloakNotFoundError) return 'missing'
    throw error
  }
  if (effective.includes(roles.adminRole)) return 'admin'
  if (effective.includes(roles.userRole)) return 'user'
  return 'no-role'
}

/** The admin seats of the process's reading, which exists in self-hosted mode, the only mode of the page. */
async function adminSeatUsage(): Promise<AdminSeatUsage> {
  const usage = await getAdminSeatUsage()
  if (usage === null) throw new Error('The admin seats are read only in self-hosted mode')
  return usage
}

/**
 * What Keycloak reports of the admins and of the holders shown. A degraded session reads nothing from Keycloak, and a
 * directory that cannot be read, which the session recheck also survives, is logged and shown as unknown, not thrown;
 * every other failure, such as a KeycloakConfigError, is thrown.
 */
async function readAccounts(
  user: Pick<CurrentUser, 'id' | 'directoryDegraded'>,
  holders: readonly UserSeatHolder[],
): Promise<{ directory: DirectoryReading; admins: AdminSeatUsage | null; accounts: HolderAccount[] }> {
  const unknown = (directory: DirectoryReading) => ({
    directory,
    admins: null,
    accounts: holders.map((): HolderAccount => 'unknown'),
  })
  if (user.directoryDegraded) return unknown('degraded')

  const config = getRuntimeConfig()
  const roles = { adminRole: config.PLATFORM_ADMIN_ROLE, userRole: config.STUDIO_USER_ROLE }
  const directory = getKeycloakDirectory()
  try {
    const [admins, accounts] = await Promise.all([
      adminSeatUsage(),
      Promise.all(holders.map((holder) => holderAccount(directory, roles, holder.subject))),
    ])
    return { directory: 'available', admins, accounts }
  } catch (error) {
    if (!isDirectoryFailure(error)) throw error
    if (error instanceof KeycloakUnavailableError) {
      logger.warn('License page: the Keycloak directory is unreachable', { userId: user.id, error: error.message })
      return unknown('unreachable')
    }
    // Keycloak refused the client credentials or the service account's rights: no retry fixes that.
    logger.error("License page: Keycloak refused Platform's service account, a configuration error", error, {
      userId: user.id,
    })
    return unknown('refused')
  }
}

/**
 * The License page of this self-hosted install: the license, the seats in use against the seats it allows, every
 * admin identity, and one page of the holders of user seats, each with how Keycloak reports them now. The seats in use
 * are counted in the database without a lock, as the gates count them, and the admin seats come from a reading of
 * Keycloak at most 60 seconds old.
 */
export async function loadLicensePage(
  user: Pick<CurrentUser, 'id' | 'directoryDegraded'>,
  requestedPage: number,
): Promise<LicensePageData> {
  const status = getLicenseStatus()
  if (status === null) throw new Error('The License page exists only in self-hosted mode, where the install has a license status')

  const inUse = await countUserSeatsInUse(db)
  const pageCount = Math.max(1, Math.ceil(inUse / LICENSE_HOLDERS_PAGE_SIZE))
  const page = Math.min(Math.max(1, requestedPage), pageCount)
  const holders = await listUserSeatHolders(db, {
    first: (page - 1) * LICENSE_HOLDERS_PAGE_SIZE,
    max: LICENSE_HOLDERS_PAGE_SIZE,
  })
  const { directory, admins, accounts } = await readAccounts(user, holders)

  return {
    license: summaryOf(status),
    adminSeats: {
      allowed: status.limits.adminSeats,
      inUse: admins === null ? null : admins.seatsInUse,
      holders:
        admins === null
          ? null
          : admins.identities.map(({ keycloakId, email, name, state }) => ({ keycloakId, email, name, state })),
    },
    userSeats: {
      allowed: status.limits.userSeats,
      inUse,
      holders: holders.map((holder, index) => ({ ...holder, account: accounts[index] })),
      page,
      pageCount,
    },
    directory,
  }
}
