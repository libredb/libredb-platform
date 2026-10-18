import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { SMALL_LICENSE_ACTIVE } from '../../../../tests/license/statuses'
import { licenseStatus, type LicensePayload, type LicenseStatus } from '@/shared/lib/license'
import { licenseNotice, type SeatsInUse } from '@/shared/lib/license/notice'
import { LicenseBanner } from './license-banner'

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

const AT = {
  active: new Date('2027-01-01T00:00:00Z'),
  expiring: new Date('2027-10-01T00:00:00Z'),
  grace: new Date('2027-10-20T00:00:00Z'),
  expired: new Date('2027-11-01T00:00:00Z'),
}

function valid(state: keyof typeof AT): LicenseStatus {
  return licenseStatus({ ok: true, license: LICENSE }, AT[state])
}

const INVALID = licenseStatus({ ok: false, code: 'LICENSE_MALFORMED' }, AT.active)
const WITHIN: SeatsInUse = { userSeats: 3, adminSeats: 1 }

function renderBanner(status: LicenseStatus, inUse: SeatsInUse = WITHIN) {
  return render(<LicenseBanner notice={licenseNotice(status, inUse)} />)
}

/** The banner, found by its title. */
function banner(title: string): HTMLElement {
  const found = screen.getByRole('status', { name: title })
  expect(within(found).getByRole('link', { name: 'Open the License page' })).toHaveAttribute('href', '/admin/license')
  return found
}

describe('LicenseBanner', () => {
  it('renders nothing for an active license within its limits', () => {
    for (const status of [valid('active'), SMALL_LICENSE_ACTIVE]) {
      const { container, unmount } = renderBanner(status)
      expect(container, status.state).toBeEmptyDOMElement()
      unmount()
    }
  })

  it('warns of an expiring license with its expiry date', () => {
    renderBanner(valid('expiring'))

    expect(banner('The license expires on 2027-10-16 00:00 UTC')).toHaveTextContent(
      'Renew it before then. After that date its seats apply for 14 more days, and then no user, connection or admin can be added.',
    )
  })

  it('tells an admin in the grace period when the seats stop applying', () => {
    renderBanner(valid('grace'))

    expect(banner('The license expired on 2027-10-16 00:00 UTC')).toHaveTextContent(
      'Its seats apply until 2027-10-30 00:00 UTC. After that no user, connection or admin can be added, and existing access keeps working.',
    )
  })

  it('tells an admin of an expired license that additions stop and access stays', () => {
    renderBanner(valid('expired'))

    expect(banner('The license has expired')).toHaveTextContent(
      'No user, connection or admin can be added until a renewed license is installed. Existing access keeps working.',
    )
  })

  it('names an invalid license with its code, and that nothing can be added until a valid one is installed', () => {
    renderBanner(INVALID)

    const invalid = banner('The license is invalid')
    expect(invalid).toHaveTextContent(
      'Platform could not verify the installed license (LICENSE_MALFORMED). No user, connection or admin can be added until a valid license is installed. Existing access keeps working.',
    )
    expect(invalid).not.toHaveTextContent(/free tier/i)
  })

  it('reports user and admin seats over the limit of a valid license, in any of its states', () => {
    const { unmount } = renderBanner(SMALL_LICENSE_ACTIVE, { userSeats: 5, adminSeats: 2 })

    const over = banner('More seats are in use than the license allows')
    expect(over).toHaveTextContent('5 user seats are in use, and the license allows 3: no user or connection can be added until seats are freed.')
    expect(over).toHaveTextContent('2 admin seats are in use, and the license allows 1: no admin can sign in for the first time until seats are freed.')
    expect(over).toHaveTextContent('Existing access keeps working.')
    unmount()

    // An expired license over the user limit keeps its own title and adds the seats.
    renderBanner(valid('expired'), { userSeats: 30, adminSeats: 1 })
    const expired = banner('The license has expired')
    expect(expired).toHaveTextContent('30 user seats are in use, and the license allows 25')
    expect(expired).not.toHaveTextContent('admin seats are in use')
  })

  it('reports no seats over a limit for an invalid license, which grants none', () => {
    renderBanner(INVALID, { userSeats: 40, adminSeats: 5 })

    expect(banner('The license is invalid')).not.toHaveTextContent('seats are in use')
  })

  it('counts one seat in the singular', () => {
    const noUserSeats = licenseStatus({ ok: true, license: { ...LICENSE, userSeats: 0 } }, AT.active)
    renderBanner(noUserSeats, { userSeats: 1, adminSeats: 1 })

    expect(banner('More seats are in use than the license allows')).toHaveTextContent(
      '1 user seat is in use, and the license allows 0: no user or connection can be added until seats are freed.',
    )
  })
})
