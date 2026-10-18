import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SMALL_LICENSE_ACTIVE } from '../../../../tests/license/statuses'
import {
  KeycloakAuthError,
  KeycloakConfigError,
  KeycloakPermissionError,
  KeycloakUnavailableError,
} from '../keycloak/errors'
import type { AdminSeatUsage } from './admin-seats'
import { licenseStatus, type LicenseStatus } from './state'
import type { LicensePayload } from './token'

// The license status, the user seats and the admin seats of the process, which each test sets.
const install = vi.hoisted(() => ({
  status: null as LicenseStatus | null,
  userSeats: 0,
  adminSeats: undefined as unknown as () => Promise<AdminSeatUsage | null>,
}))
const db = vi.hoisted(() => ({ $queryRaw: vi.fn() }))
const logger = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }))
const countUserSeatsInUse = vi.hoisted(() => vi.fn(async (_client: unknown) => install.userSeats))
const getAdminSeatUsage = vi.hoisted(() => vi.fn(() => install.adminSeats()))

vi.mock('../db', () => ({ db }))
vi.mock('../logger', () => ({ logger }))
vi.mock('./install-license', () => ({ getLicenseStatus: () => install.status }))
vi.mock('./install-admin-seats', () => ({ getAdminSeatUsage }))
vi.mock('./user-seats', () => ({ countUserSeatsInUse }))

import { getLicenseNotice, getNewConnectionRefusal } from './install-license-notice'

// A license for 2 admins and 25 users that expires 2027-10-16, in grace until 2027-10-30.
const LICENSE: LicensePayload = {
  v: 1,
  id: 'LIC-2026.0042',
  customer: 'Example Customer',
  adminSeats: 2,
  userSeats: 25,
  issuedAt: 1_792_108_800,
  expiresAt: 1_823_644_800,
}

const INVALID = licenseStatus({ ok: false, code: 'LICENSE_MALFORMED' }, new Date('2027-01-01T00:00:00Z'))
const EXPIRED = licenseStatus({ ok: true, license: LICENSE }, new Date('2027-11-01T00:00:00Z'))

const ADMIN = { id: 'user-alice', roles: ['PLATFORM_ADMIN'], directoryDegraded: false }

/** Admin seat usage with `admins` identities that Keycloak reports as admins. */
function adminUsage(admins: number): AdminSeatUsage {
  return {
    seatsInUse: admins,
    identities: Array.from({ length: admins }, (_, index) => ({
      userId: `user-${index}`,
      keycloakId: `kc-${index}`,
      email: `admin${index}@libredb.test`,
      name: null,
      state: 'admin' as const,
    })),
  }
}

beforeEach(() => {
  // An active license of 1 admin seat and 3 user seats.
  install.status = SMALL_LICENSE_ACTIVE
  install.userSeats = 2
  install.adminSeats = async () => adminUsage(1)
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('getLicenseNotice', () => {
  it('is null in cloud mode and for a session without PLATFORM_ADMIN, without reading any seat', async () => {
    install.status = null
    expect(await getLicenseNotice(ADMIN)).toBeNull()

    install.status = INVALID
    expect(await getLicenseNotice({ ...ADMIN, roles: ['TENANT_ADMIN'] })).toBeNull()

    expect(countUserSeatsInUse).not.toHaveBeenCalled()
    expect(getAdminSeatUsage).not.toHaveBeenCalled()
  })

  it('is null for an active license within its limits, and names an invalid license', async () => {
    expect(await getLicenseNotice(ADMIN)).toBeNull()
    expect(countUserSeatsInUse).toHaveBeenCalledWith(db)

    install.status = INVALID
    expect(await getLicenseNotice(ADMIN)).toEqual({
      attention: { state: 'invalid', code: 'LICENSE_MALFORMED' },
      userSeatsOver: null,
      adminSeatsOver: null,
    })
  })

  it('names an invalid license alone without reading any seat, because it grants none', async () => {
    install.status = INVALID
    install.userSeats = 40
    // A Keycloak that does not answer, which the banner of an invalid license neither waits for nor logs.
    install.adminSeats = async () => {
      throw new KeycloakUnavailableError('Keycloak Admin API GET /users/{id} did not answer within 5 s')
    }

    expect(await getLicenseNotice(ADMIN)).toEqual({
      attention: { state: 'invalid', code: 'LICENSE_MALFORMED' },
      userSeatsOver: null,
      adminSeatsOver: null,
    })
    expect(countUserSeatsInUse).not.toHaveBeenCalled()
    expect(getAdminSeatUsage).not.toHaveBeenCalled()
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('counts the user seats in the database and the admin seats through Keycloak', async () => {
    install.userSeats = 4
    install.adminSeats = async () => adminUsage(3)

    expect(await getLicenseNotice(ADMIN)).toEqual({
      attention: null,
      userSeatsOver: { inUse: 4, allowed: 3 },
      adminSeatsOver: { inUse: 3, allowed: 1 },
    })
  })

  it('asks Keycloak nothing while the session is degraded, and still reports the user seats', async () => {
    install.userSeats = 4
    install.adminSeats = async () => adminUsage(3)

    expect(await getLicenseNotice({ ...ADMIN, directoryDegraded: true })).toEqual({
      attention: null,
      userSeatsOver: { inUse: 4, allowed: 3 },
      adminSeatsOver: null,
    })
    expect(getAdminSeatUsage).not.toHaveBeenCalled()
  })

  it('leaves the admin seats out when Keycloak does not answer, and throws a KeycloakConfigError', async () => {
    install.userSeats = 4
    install.adminSeats = async () => {
      throw new KeycloakUnavailableError('Keycloak Admin API GET /users/{id} did not answer within 5 s')
    }

    expect(await getLicenseNotice(ADMIN)).toEqual({
      attention: null,
      userSeatsOver: { inUse: 4, allowed: 3 },
      adminSeatsOver: null,
    })
    expect(logger.warn).toHaveBeenCalledWith('License notice: the Keycloak directory is unreachable', {
      userId: 'user-alice',
      error: 'Keycloak Admin API GET /users/{id} did not answer within 5 s',
    })

    install.adminSeats = async () => {
      throw new KeycloakConfigError('The Keycloak realm has no client libredb, which must hold the LibreDB roles as client roles')
    }
    await expect(getLicenseNotice(ADMIN)).rejects.toThrow(KeycloakConfigError)
  })

  // The session recheck keeps a session on its grace for these failures too, so the banner must not fail every
  // dashboard page until the next recheck marks the session degraded.
  it.each([
    new KeycloakPermissionError(
      'Keycloak Admin API GET /users/{id} answered 403: the service account of client libredb-platform needs the ' +
        'realm-management roles view-users and view-clients',
    ),
    new KeycloakAuthError(
      'Keycloak Admin API GET /users/{id} answered 401 to a new service-account token of client libredb-platform',
    ),
  ])('leaves the admin seats out and logs once when Keycloak refuses with a $name', async (refusal) => {
    install.userSeats = 4
    install.adminSeats = async () => {
      throw refusal
    }

    expect(await getLicenseNotice(ADMIN)).toEqual({
      attention: null,
      userSeatsOver: { inUse: 4, allowed: 3 },
      adminSeatsOver: null,
    })
    expect(logger.error).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledWith(
      "License notice: Keycloak refused Platform's service account, a configuration error",
      refusal,
      { userId: 'user-alice' },
    )
    expect(logger.warn).not.toHaveBeenCalled()
  })
})

describe('getNewConnectionRefusal', () => {
  it('is null in cloud mode, without counting seats', async () => {
    install.status = null
    expect(await getNewConnectionRefusal()).toBeNull()
    expect(countUserSeatsInUse).not.toHaveBeenCalled()
  })

  it('gives the refusal text of an invalid license and of an expired one whatever the seats in use, and of user seats above the limit', async () => {
    install.userSeats = 0
    install.status = INVALID
    expect(await getNewConnectionRefusal()).toBe(
      'The license could not be verified. Existing access keeps working, and adding users, connections or admins needs a valid license.',
    )

    install.status = EXPIRED
    expect(await getNewConnectionRefusal()).toBe(
      'The license has expired. Existing access keeps working, and adding users, connections or admins needs a renewed license.',
    )

    install.status = SMALL_LICENSE_ACTIVE
    install.userSeats = 4
    expect(await getNewConnectionRefusal()).toBe(
      'Not enough user seats. Free a seat by revoking all grants of a user, or install a license with more user seats.',
    )
    expect(countUserSeatsInUse).toHaveBeenLastCalledWith(db)
  })

  it('is null at the user-seat limit, where a new connection takes no seat', async () => {
    install.userSeats = 3
    expect(await getNewConnectionRefusal()).toBeNull()
  })
})
