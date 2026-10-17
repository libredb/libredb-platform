import Link from 'next/link'
import { KeyRound } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/shared/components/ui/alert'
import { FREE_TIER_LIMITS } from '@/shared/lib/license'
import type { LicenseAttention, LicenseNotice, SeatUse } from '@/shared/lib/license/notice'
import { cn } from '@/shared/lib/utils'

/** The URL of the License page, which every banner links to. */
const LICENSE_PAGE = '/admin/license'

/** The id of the banner's title, which names the banner; the layout renders one banner at most. */
const TITLE_ID = 'license-banner-title'

/** A time in UTC, so the text does not depend on where it renders. */
function formatTime(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`
}

function seatText(count: number, kind: 'user' | 'admin'): string {
  return count === 1 ? `1 ${kind} seat` : `${count} ${kind} seats`
}

function attentionTitle(attention: LicenseAttention): string {
  switch (attention.state) {
    case 'expiring':
      return `The license expires on ${formatTime(attention.expiresAt)}`
    case 'grace':
      return `The license expired on ${formatTime(attention.expiresAt)}`
    case 'expired':
      return 'The license has expired'
    case 'invalid':
      return 'The license is invalid'
  }
}

function attentionText(attention: LicenseAttention): string {
  switch (attention.state) {
    case 'expiring':
      return 'Renew it before then. After that date its seats apply for 14 more days, and then no user, connection or admin can be added.'
    case 'grace':
      return `Its seats apply until ${formatTime(attention.graceEndsAt)}. After that no user, connection or admin can be added, and existing access keeps working.`
    case 'expired':
      return 'No user, connection or admin can be added until a renewed license is installed. Existing access keeps working.'
    case 'invalid':
      return `Platform could not verify the installed license (${attention.code}), so the install runs on the free tier of ${seatText(FREE_TIER_LIMITS.adminSeats, 'admin')} and ${seatText(FREE_TIER_LIMITS.userSeats, 'user')}.`
  }
}

function overText(use: SeatUse, kind: 'user' | 'admin'): string {
  const consequence =
    kind === 'user'
      ? 'no user or connection can be added until seats are freed.'
      : 'no admin can sign in for the first time until seats are freed.'
  return `${seatText(use.inUse, kind)} ${use.inUse === 1 ? 'is' : 'are'} in use, and the license allows ${use.allowed}: ${consequence}`
}

interface LicenseBannerProps {
  /** The notice of the install for this session, or null when nothing needs an admin's attention. */
  notice: LicenseNotice | null
  className?: string
}

/**
 * Tells an admin of a self-hosted install that the license needs attention: it expires within 30 days, is in its grace
 * period, has expired or failed verification, or more seats are in use than it allows. It links to the License page,
 * and renders nothing for an active license or the free tier within their limits.
 */
export function LicenseBanner({ notice, className }: LicenseBannerProps) {
  if (notice === null) return null
  const { attention, userSeatsOver, adminSeatsOver } = notice
  return (
    <Alert
      role="status"
      aria-labelledby={TITLE_ID}
      className={cn('border-amber-500/50 bg-amber-500/5 text-amber-700 dark:text-amber-400', className)}
    >
      <KeyRound />
      <AlertTitle id={TITLE_ID}>
        {attention === null ? 'More seats are in use than the license allows' : attentionTitle(attention)}
      </AlertTitle>
      <AlertDescription>
        {attention !== null && <p>{attentionText(attention)}</p>}
        {userSeatsOver !== null && <p>{overText(userSeatsOver, 'user')}</p>}
        {adminSeatsOver !== null && <p>{overText(adminSeatsOver, 'admin')}</p>}
        {attention === null && <p>Existing access keeps working.</p>}
        <p>
          <Link href={LICENSE_PAGE}>Open the License page</Link>
        </p>
      </AlertDescription>
    </Alert>
  )
}
