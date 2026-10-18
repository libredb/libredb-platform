import Link from 'next/link'
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react'
import { Badge } from '@/shared/components/ui/badge'
import { buttonVariants } from '@/shared/components/ui/button'
import { UsageBar } from '@/shared/components/composed/usage-bar'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/shared/components/ui/table'
import type { LicenseErrorCode } from '@/shared/lib/license'
import type { AdminSeatState } from '@/shared/lib/license/admin-seats'
import type { HolderAccount, LicensePageData, LicenseSummary } from '../lib/license-page'

const PAGE_PATH = '/admin/license'

/** Where license keys come from: SEKOYA GRUP BİLİŞİM VE TEKNOLOJİ LİMİTED ŞİRKETİ, the licensor. */
const LICENSE_CONTACT = 'info@libredb.org'

/** A time in UTC, so the server and the browser render the same text. */
function formatTime(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`
}

const STATE_LABELS: Record<LicenseSummary['state'], string> = {
  invalid: 'Invalid',
  active: 'Active',
  expiring: 'Expiring',
  grace: 'Grace period',
  expired: 'Expired',
}

const STATE_VARIANTS = {
  invalid: 'destructive',
  active: 'success',
  expiring: 'warning',
  grace: 'warning',
  expired: 'destructive',
} as const satisfies Record<LicenseSummary['state'], string>

/** Why a token failed verification, by the code the server logged at start. */
const FAILURE_REASONS: Record<LicenseErrorCode, string> = {
  LICENSE_MALFORMED: 'the token is not a well-formed LibreDB license',
  LICENSE_UNKNOWN_KID: 'the token is signed by a key that this build of Platform does not hold',
  LICENSE_BAD_SIGNATURE: 'the signature of the token does not verify',
  LICENSE_PAYLOAD_INVALID: 'the token does not carry a valid license',
  LICENSE_HOST_MISMATCH: 'the license does not list the host of AUTH_URL',
}

function stateText(license: LicenseSummary): string {
  switch (license.state) {
    case 'invalid':
      return `The installed license could not be verified (${license.code}): ${FAILURE_REASONS[license.code]}. No user, connection or admin can be added until a valid license is installed, and existing access keeps working.`
    case 'active':
      return `The license is valid until ${formatTime(license.expiresAt)}.`
    case 'expiring':
      return `The license expires on ${formatTime(license.expiresAt)}. Renew it before then: after that date its seats apply for 14 more days.`
    case 'grace':
      return `The license expired on ${formatTime(license.expiresAt)}, and its seats apply until ${formatTime(license.graceEndsAt)}. Renew it before then.`
    case 'expired':
      return `The license expired on ${formatTime(license.expiresAt)}, and its grace period ended on ${formatTime(license.graceEndsAt)}. No user, connection or admin can be added until a renewed license is installed, and existing access keeps working.`
  }
}

const ADMIN_STATES: Record<AdminSeatState, { label: string; variant: 'default' | 'outline' | 'destructive' }> = {
  admin: { label: 'Admin', variant: 'default' },
  'role-removed': { label: 'Admin role removed', variant: 'outline' },
  disabled: { label: 'Disabled', variant: 'destructive' },
  missing: { label: 'Not in directory', variant: 'destructive' },
}

const HOLDER_ACCOUNTS: Record<HolderAccount, { label: string; variant: 'default' | 'secondary' | 'outline' | 'destructive' }> = {
  admin: { label: 'Admin', variant: 'default' },
  user: { label: 'User', variant: 'secondary' },
  'no-role': { label: 'No role', variant: 'outline' },
  disabled: { label: 'Disabled', variant: 'destructive' },
  missing: { label: 'Not in directory', variant: 'destructive' },
  unknown: { label: 'Unknown', variant: 'outline' },
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-3">
      <h2 id={id} className="text-lg font-semibold">
        {title}
      </h2>
      {children}
    </section>
  )
}

/** A link that writes to the licensor, where license keys come from. */
function ContactLink() {
  return (
    <a href={`mailto:${LICENSE_CONTACT}`} className="font-medium underline underline-offset-2">
      {LICENSE_CONTACT}
    </a>
  )
}

function StatusSection({ license }: { license: LicenseSummary }) {
  return (
    <Section id="license-status-heading" title="Status">
      <Badge variant={STATE_VARIANTS[license.state]}>{STATE_LABELS[license.state]}</Badge>
      <p className="text-sm text-muted-foreground">{stateText(license)}</p>
      {license.state === 'invalid' && (
        <p className="text-sm text-muted-foreground">
          Write to <ContactLink /> for a license that this install can verify.
        </p>
      )}
      {license.state !== 'invalid' && (
        <dl className="grid max-w-2xl grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-muted-foreground">Customer</dt>
          <dd>{license.customer}</dd>
          <dt className="text-muted-foreground">License id</dt>
          <dd className="font-mono">{license.id}</dd>
          <dt className="text-muted-foreground">Issued</dt>
          <dd>{formatTime(license.issuedAt)}</dd>
          <dt className="text-muted-foreground">Expires</dt>
          <dd>{formatTime(license.expiresAt)}</dd>
          <dt className="text-muted-foreground">Grace period ends</dt>
          <dd>{formatTime(license.graceEndsAt)}</dd>
          <dt className="text-muted-foreground">Hosts</dt>
          <dd>{license.hosts === null ? 'Any host' : license.hosts.join(', ')}</dd>
        </dl>
      )}
    </Section>
  )
}

/** A count of seats without a bar: the seats in use of a license that allows none, or Unknown. */
function SeatCount({ label, text }: { label: string; text: string }) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="font-medium uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className="tabular-nums">{text}</span>
    </div>
  )
}

/**
 * The seats in use against the seats allowed, or only the seats in use when the license allows none, so that no count
 * reads as a limit of 0; Unknown when Keycloak could not be asked how many are in use.
 */
function SeatUse({ label, inUse, allowed }: { label: string; inUse: number | null; allowed: number | null }) {
  if (inUse === null) return <SeatCount label={label} text="Unknown" />
  if (allowed === null) return <SeatCount label={label} text={`${inUse} in use`} />
  return <UsageBar label={label} used={inUse} limit={allowed} />
}

function SeatsSection({ data }: { data: LicensePageData }) {
  const { adminSeats, userSeats } = data
  return (
    <Section id="license-seats-heading" title="Seats">
      <div className="grid max-w-2xl gap-6 sm:grid-cols-2">
        <SeatUse label="Admin seats" inUse={adminSeats.inUse} allowed={adminSeats.allowed} />
        <SeatUse label="User seats" inUse={userSeats.inUse} allowed={userSeats.allowed} />
      </div>
      {data.license.state === 'invalid' && (
        <p className="text-sm text-muted-foreground">
          An invalid license grants no seat, so only the seats in use are shown.
        </p>
      )}
    </Section>
  )
}

function AdminsSection({ holders }: { holders: LicensePageData['adminSeats']['holders'] }) {
  return (
    <Section id="license-admins-heading" title="Admins">
      <p className="text-sm text-muted-foreground">
        Each Platform user of a Keycloak account that Keycloak still reports as an enabled admin holds an admin seat.
        Keycloak is asked about each admin at most once a minute.
      </p>
      {holders === null ? (
        <p className="text-sm text-muted-foreground">How Keycloak reports each admin is unknown.</p>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Admin</TableHead>
                <TableHead>Keycloak</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {holders.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={2} className="h-16 text-center text-muted-foreground">
                    No admin has signed in yet.
                  </TableCell>
                </TableRow>
              ) : (
                holders.map((admin) => (
                  <TableRow key={admin.keycloakId}>
                    <TableCell>
                      <div className="font-medium">{admin.email}</div>
                      {admin.name !== null && <div className="text-xs text-muted-foreground">{admin.name}</div>}
                    </TableCell>
                    <TableCell>
                      <Badge variant={ADMIN_STATES[admin.state].variant}>{ADMIN_STATES[admin.state].label}</Badge>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </Section>
  )
}

function countOf(total: number): string {
  return total === 1 ? '1 user' : `${total} users`
}

function UsersSection({ userSeats }: { userSeats: LicensePageData['userSeats'] }) {
  const { holders, page, pageCount, inUse } = userSeats
  return (
    <Section id="license-users-heading" title="Users with a seat">
      <p className="text-sm text-muted-foreground">
        A user holds a user seat while a grant of theirs is in effect on an active connection, admins included, and
        keeps it while Keycloak disables the account or removes its role. Revoking every grant of a user frees the seat.
      </p>
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead>Connections</TableHead>
              <TableHead>Keycloak</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {holders.length === 0 ? (
              <TableRow>
                <TableCell colSpan={3} className="h-16 text-center text-muted-foreground">
                  No user holds a user seat.
                </TableCell>
              </TableRow>
            ) : (
              holders.map((holder) => (
                <TableRow key={holder.subject}>
                  <TableCell>
                    <div className="font-medium">{holder.username}</div>
                    <div className="text-xs text-muted-foreground">{holder.email ?? '-'}</div>
                  </TableCell>
                  <TableCell className="tabular-nums">{holder.connections}</TableCell>
                  <TableCell>
                    <Badge variant={HOLDER_ACCOUNTS[holder.account].variant}>{HOLDER_ACCOUNTS[holder.account].label}</Badge>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
        <span>
          Page {page} of {pageCount}, {countOf(inUse)}
        </span>
        <div className="flex gap-2">
          {page > 1 && (
            <Link
              href={`${PAGE_PATH}?page=${page - 1}`}
              aria-label="Previous page"
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              <ChevronLeftIcon />
              Previous
            </Link>
          )}
          {page < pageCount && (
            <Link
              href={`${PAGE_PATH}?page=${page + 1}`}
              aria-label="Next page"
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              Next
              <ChevronRightIcon />
            </Link>
          )}
        </div>
      </div>
    </Section>
  )
}

/**
 * The license of a self-hosted install: its state and dates, the seats in use against the seats it allows, the admins
 * and the holders of user seats with how Keycloak reports them, where license keys come from, and how to install one
 * with the installer.
 */
export function LicenseOverview({ data }: { data: LicensePageData }) {
  return (
    <div className="space-y-8">
      {data.directory === 'unreachable' && (
        <p role="status" className="text-sm text-amber-600 dark:text-amber-400">
          Keycloak did not answer, so how it reports each account is unknown.
        </p>
      )}
      {data.directory === 'refused' && (
        <p role="status" className="text-sm text-amber-600 dark:text-amber-400">
          Keycloak refused Platform&apos;s service account, so how it reports each account is unknown.
        </p>
      )}
      <StatusSection license={data.license} />
      <SeatsSection data={data} />
      <AdminsSection holders={data.adminSeats.holders} />
      <UsersSection userSeats={data.userSeats} />
      <Section id="license-renew-heading" title="Renew">
        <p className="max-w-3xl text-sm text-muted-foreground">
          License keys come from SEKOYA GRUP BİLİŞİM VE TEKNOLOJİ LİMİTED ŞİRKETİ: write to <ContactLink /> for a new
          license or a renewal.
        </p>
        <p className="max-w-3xl text-sm text-muted-foreground">
          To install or renew a license, save the license file you receive at the path that{' '}
          <code>platform.licenseFile</code> names in the installer configuration and run{' '}
          <code>libredb-installer apply -c &lt;libredb.yaml&gt;</code> as root, which recreates Platform with it.
          Without the installer, set <code>PLATFORM_LICENSE</code> to the token the file holds and restart Platform,
          which verifies the license as it starts.
        </p>
      </Section>
    </div>
  )
}
