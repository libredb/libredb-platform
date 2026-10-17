import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { fakeAdminDirectory, type KeycloakAccount } from '../../../../../tests/license/admin-directory'
import {
  KeycloakAuthError,
  KeycloakConfigError,
  KeycloakPermissionError,
  KeycloakUnavailableError,
} from '@/shared/lib/keycloak/errors'
import { licenseStatus, type LicensePayload, type LicenseStatus } from '@/shared/lib/license'
import type { AdminSeatUsage } from '@/shared/lib/license/admin-seats'
import type { UserSeatHolder } from '@/shared/lib/license/user-seats'

// The session that auth() returns: a Keycloak admin of the install tenant.
const session = vi.hoisted(() => ({
  user: { id: 'user-alice', email: 'alice@libredb.test', name: 'Alice' },
  authProvider: 'keycloak',
  currentTenantId: 'tenant-install',
  membershipId: null,
  roles: ['PLATFORM_ADMIN'],
  permissions: [],
  accessibleTenants: [],
  directoryDegraded: false,
}))

// The license status, the seats and the Keycloak accounts of the install, which each test sets.
const install = vi.hoisted(() => ({
  status: null as unknown,
  holders: [] as unknown[],
  adminSeats: undefined as unknown as () => Promise<unknown>,
  directory: undefined as unknown,
}))
const getAdminSeatUsage = vi.hoisted(() => vi.fn(() => install.adminSeats()))
const countUserSeatsInUse = vi.hoisted(() => vi.fn(async () => install.holders.length))
const listUserSeatHolders = vi.hoisted(() =>
  vi.fn(async (_client: unknown, range: { first: number; max: number }) =>
    install.holders.slice(range.first, range.first + range.max)),
)
const logger = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }))

vi.mock('@/shared/lib/auth', () => ({ auth: vi.fn(async () => session) }))
vi.mock('@/shared/lib/db', () => ({ db: {} }))
vi.mock('@/shared/lib/license/install-license', () => ({ getLicenseStatus: () => install.status }))
vi.mock('@/shared/lib/license/install-admin-seats', () => ({ getAdminSeatUsage }))
vi.mock('@/shared/lib/license/user-seats', () => ({ countUserSeatsInUse, listUserSeatHolders }))
vi.mock('@/shared/lib/keycloak/directory', () => ({ getKeycloakDirectory: () => install.directory }))
vi.mock('@/shared/lib/runtime-config', () => ({
  getRuntimeConfig: () => ({ PLATFORM_ADMIN_ROLE: 'admin', STUDIO_USER_ROLE: 'user' }),
}))
vi.mock('@/shared/lib/logger', () => ({ logger }))
vi.mock('next/server', () => ({ connection: vi.fn(async () => undefined) }))
vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_HTTP_ERROR_FALLBACK;404')
  }),
  redirect: vi.fn(),
}))

import LicensePage from './page'

// A license issued 2026-10-16 for 2 admins and 25 users on one host, which expires 2027-10-16 and is in grace until
// 2027-10-30.
const LICENSE: LicensePayload = {
  v: 1,
  id: 'LIC-2026.0042',
  customer: 'Example Customer',
  adminSeats: 2,
  userSeats: 25,
  issuedAt: 1_792_108_800,
  expiresAt: 1_823_644_800,
  hosts: ['platform.example.test'],
}

const ACTIVE = licenseStatus({ ok: true, license: LICENSE }, new Date('2027-01-01T00:00:00Z'))
const EXPIRED = licenseStatus({ ok: true, license: LICENSE }, new Date('2027-11-01T00:00:00Z'))
const FREE = licenseStatus(null, new Date('2027-01-01T00:00:00Z'))
const INVALID = licenseStatus({ ok: false, code: 'LICENSE_MALFORMED' }, new Date('2027-01-01T00:00:00Z'))

// alice is an admin, and Keycloak removed carol's admin role.
const ADMIN_SEATS: AdminSeatUsage = {
  seatsInUse: 1,
  identities: [
    { userId: 'user-alice', keycloakId: 'kc-alice', email: 'alice@libredb.test', name: 'Alice', state: 'admin' },
    { userId: 'user-carol', keycloakId: 'kc-carol', email: 'carol@libredb.test', name: null, state: 'role-removed' },
  ],
}

function holder(subject: string, username: string, connections = 1): UserSeatHolder {
  return { subject, username, email: `${username}@libredb.test`, connections }
}

// bob is a user, dave is disabled, erin lost her role, frank is gone from Keycloak and alice holds a grant as an admin.
const ACCOUNTS: Record<string, KeycloakAccount> = {
  'kc-alice': { enabled: true, roles: ['admin', 'offline_access'] },
  'kc-bob': { enabled: true, roles: ['user'] },
  'kc-dave': { enabled: false, roles: ['user'] },
  'kc-erin': { enabled: true, roles: ['offline_access'] },
}

const HOLDERS = [
  holder('kc-alice', 'alice'),
  holder('kc-bob', 'bob', 2),
  holder('kc-dave', 'dave'),
  holder('kc-erin', 'erin'),
  holder('kc-frank', 'frank'),
]

function setInstall(status: LicenseStatus, holders: UserSeatHolder[] = HOLDERS, accounts = ACCOUNTS) {
  install.status = status
  install.holders = holders
  install.directory = fakeAdminDirectory(accounts)
}

async function renderPage(query: Record<string, string> = {}) {
  render(await LicensePage({ searchParams: Promise.resolve(query) }))
}

/** The row of a table in the section with this heading. */
function rowIn(sectionName: string, text: string): HTMLElement {
  const section = screen.getByRole('region', { name: sectionName })
  return within(section).getByRole('row', { name: new RegExp(`\\b${text}\\b`) })
}

beforeEach(() => {
  vi.stubEnv('DEPLOYMENT_MODE', 'self-hosted')
  session.roles = ['PLATFORM_ADMIN']
  session.directoryDegraded = false
  install.adminSeats = async () => ADMIN_SEATS
  setInstall(ACTIVE)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('LicensePage', () => {
  it('shows the customer, the state, the dates, the seats used against allowed and the seat holders', async () => {
    await renderPage()

    const status = screen.getByRole('region', { name: 'Status' })
    expect(within(status).getByText('Active')).toBeInTheDocument()
    expect(status).toHaveTextContent('Example Customer')
    expect(status).toHaveTextContent('LIC-2026.0042')
    expect(status).toHaveTextContent('Issued2026-10-16 00:00 UTC')
    expect(status).toHaveTextContent('Expires2027-10-16 00:00 UTC')
    expect(status).toHaveTextContent('Grace period ends2027-10-30 00:00 UTC')
    expect(status).toHaveTextContent('Hostsplatform.example.test')

    const seats = screen.getByRole('region', { name: 'Seats' })
    expect(seats).toHaveTextContent('Admin seats1 / 2')
    expect(seats).toHaveTextContent('User seats5 / 25')

    expect(rowIn('Admins', 'alice@libredb.test')).toHaveTextContent('Admin')
    expect(rowIn('Admins', 'carol@libredb.test')).toHaveTextContent('Admin role removed')

    expect(rowIn('Users with a seat', 'alice')).toHaveTextContent('Admin')
    expect(rowIn('Users with a seat', 'bob')).toHaveTextContent('bob@libredb.test')
    expect(rowIn('Users with a seat', 'bob')).toHaveTextContent('2')
    expect(rowIn('Users with a seat', 'bob')).toHaveTextContent('User')
    expect(rowIn('Users with a seat', 'dave')).toHaveTextContent('Disabled')
    expect(rowIn('Users with a seat', 'erin')).toHaveTextContent('No role')
    expect(rowIn('Users with a seat', 'frank')).toHaveTextContent('Not in directory')

    expect(screen.getByRole('region', { name: 'Renew' })).toHaveTextContent('platform.licenseFile')
  })

  it('tells an admin where license keys come from: Sekoya Tech at info@libredb.org', async () => {
    setInstall(FREE, [holder('kc-bob', 'bob')])

    await renderPage()

    const renew = screen.getByRole('region', { name: 'Renew' })
    expect(renew).toHaveTextContent(
      'License keys come from Sekoya Tech: write to info@libredb.org for a new license or a renewal.',
    )
    expect(within(renew).getByRole('link', { name: 'info@libredb.org' }))
      .toHaveAttribute('href', 'mailto:info@libredb.org')
  })

  it('tells an admin to save the license file at the path platform.licenseFile names and run apply as root, or to set PLATFORM_LICENSE', async () => {
    setInstall(FREE, [holder('kc-bob', 'bob')])

    await renderPage()

    const renew = screen.getByRole('region', { name: 'Renew' })
    expect(renew).toHaveTextContent(
      'To install or renew a license, save the license file you receive at the path that platform.licenseFile names in the installer configuration and run libredb-installer apply -c <libredb.yaml> as root, which recreates Platform with it.',
    )
    expect(renew).toHaveTextContent(
      'Without the installer, set PLATFORM_LICENSE to the token the file holds and restart Platform, which verifies the license as it starts.',
    )
  })

  it('shows the free tier without a license', async () => {
    setInstall(FREE, [holder('kc-bob', 'bob')])

    await renderPage()

    const status = screen.getByRole('region', { name: 'Status' })
    expect(within(status).getByText('Free tier')).toBeInTheDocument()
    expect(status).toHaveTextContent('No license is installed, so the install runs on the free tier of 1 admin seat and 3 user seats.')
    expect(status).not.toHaveTextContent('Customer')
    const seats = screen.getByRole('region', { name: 'Seats' })
    expect(seats).toHaveTextContent('Admin seats1 / 1')
    expect(seats).toHaveTextContent('User seats1 / 3')
  })

  it('names the failure of an invalid license and the free tier it runs on', async () => {
    setInstall(INVALID)

    await renderPage()

    const status = screen.getByRole('region', { name: 'Status' })
    expect(within(status).getByText('Invalid')).toBeInTheDocument()
    expect(status).toHaveTextContent(
      'The installed license could not be verified (LICENSE_MALFORMED): the token is not a well-formed LibreDB license. The install runs on the free tier of 1 admin seat and 3 user seats.',
    )
    expect(screen.getByRole('region', { name: 'Seats' })).toHaveTextContent('User seats5 / 3')
  })

  it('tells an admin of an expired license that no seat can be added', async () => {
    setInstall(EXPIRED)

    await renderPage()

    const status = screen.getByRole('region', { name: 'Status' })
    expect(within(status).getByText('Expired')).toBeInTheDocument()
    expect(status).toHaveTextContent('No user, connection or admin can be added until a renewed license is installed')
  })

  it('pages the user seat holders 20 at a time and asks Keycloak only about the page shown', async () => {
    const many = Array.from({ length: 25 }, (_, index) => holder(`kc-user${index}`, `user${String(index).padStart(2, '0')}`))
    const accounts = Object.fromEntries(many.map((one): [string, KeycloakAccount] => [one.subject, { enabled: true, roles: ['user'] }]))
    setInstall(ACTIVE, many, accounts)

    await renderPage({ page: '2' })

    const users = screen.getByRole('region', { name: 'Users with a seat' })
    expect(within(users).getAllByRole('row')).toHaveLength(1 + 5)
    expect(users).toHaveTextContent('Page 2 of 2, 25 users')
    expect(within(users).getByRole('link', { name: 'Previous page' })).toHaveAttribute('href', '/admin/license?page=1')
    expect(within(users).queryByRole('link', { name: 'Next page' })).not.toBeInTheDocument()
    expect(listUserSeatHolders).toHaveBeenCalledWith({}, { first: 20, max: 20 })
    const directory = install.directory as ReturnType<typeof fakeAdminDirectory>
    expect(directory.getUser).toHaveBeenCalledTimes(5)
  })

  it('reads nothing from Keycloak while the session is degraded, and shows the accounts as unknown', async () => {
    session.directoryDegraded = true

    await renderPage()

    expect(getAdminSeatUsage).not.toHaveBeenCalled()
    expect((install.directory as ReturnType<typeof fakeAdminDirectory>).calls).toEqual([])
    expect(screen.getByRole('region', { name: 'Seats' })).toHaveTextContent('Admin seatsUnknown')
    expect(rowIn('Users with a seat', 'bob')).toHaveTextContent('Unknown')
  })

  it('shows the accounts as unknown when Keycloak does not answer', async () => {
    install.adminSeats = async () => {
      throw new KeycloakUnavailableError('Keycloak Admin API GET /users/{id} did not answer within 5 s')
    }

    await renderPage()

    expect(screen.getByRole('status')).toHaveTextContent('Keycloak did not answer')
    expect(screen.getByRole('region', { name: 'Seats' })).toHaveTextContent('Admin seatsUnknown')
    expect(screen.getByRole('region', { name: 'Seats' })).toHaveTextContent('User seats5 / 25')
    expect(rowIn('Users with a seat', 'bob')).toHaveTextContent('Unknown')
  })

  // The session recheck keeps a session on its grace for these failures too, so the page must not fail before the
  // next recheck marks the session degraded.
  it.each([
    new KeycloakPermissionError(
      'Keycloak Admin API GET /users/{id} answered 403: the service account of client libredb-platform needs the ' +
        'realm-management roles view-users and view-clients',
    ),
    new KeycloakAuthError(
      'Keycloak Admin API GET /users/{id} answered 401 to a new service-account token of client libredb-platform',
    ),
  ])('shows the accounts as unknown and logs once when Keycloak refuses with a $name', async (refusal) => {
    const refuse = async () => {
      throw refusal
    }
    install.adminSeats = refuse
    install.directory = { getUser: vi.fn(refuse), getEffectiveRoles: vi.fn(refuse) }

    await renderPage()

    expect(screen.getByRole('status')).toHaveTextContent(
      "Keycloak refused Platform's service account, so how it reports each account is unknown.",
    )
    const seats = screen.getByRole('region', { name: 'Seats' })
    expect(seats).toHaveTextContent('Admin seatsUnknown')
    expect(seats).toHaveTextContent('User seats5 / 25')
    expect(screen.getByRole('region', { name: 'Admins' })).toHaveTextContent('How Keycloak reports each admin is unknown.')
    expect(rowIn('Users with a seat', 'bob')).toHaveTextContent('Unknown')
    expect(logger.error).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledWith(
      "License page: Keycloak refused Platform's service account, a configuration error",
      refusal,
      { userId: 'user-alice' },
    )
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('throws a KeycloakConfigError, as the session recheck does', async () => {
    install.adminSeats = async () => {
      throw new KeycloakConfigError('The Keycloak realm has no client libredb, which must hold the LibreDB roles as client roles')
    }

    await expect(renderPage()).rejects.toThrow(KeycloakConfigError)
  })

  it('answers 404 in cloud mode', async () => {
    vi.stubEnv('DEPLOYMENT_MODE', 'cloud')

    await expect(renderPage()).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404')
    expect(countUserSeatsInUse).not.toHaveBeenCalled()
  })

  it('a caller without PLATFORM_ADMIN is forbidden', async () => {
    session.roles = ['TENANT_ADMIN']

    await expect(renderPage()).rejects.toThrow('Permission denied')
    expect(countUserSeatsInUse).not.toHaveBeenCalled()
  })
})
