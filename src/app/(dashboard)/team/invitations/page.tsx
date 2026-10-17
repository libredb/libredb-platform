import { requireAuth, requirePermission } from '@/shared/lib/auth-utils'
import { UserRepository } from '@/features/users/lib/user.repository'
import { Badge } from '@/shared/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/shared/components/ui/table'
import { InvitationCopyLink } from './invitation-copy-link'
import { notFoundInSelfHosted } from '@/shared/lib/deployment'

export default async function InvitationsPage() {
  await notFoundInSelfHosted()
  const user = await requireAuth()
  await requirePermission(user, 'user.invite')

  const tenantId = user.currentTenantId
  if (!tenantId) {
    return (
      <div className="p-6 flex h-48 items-center justify-center text-muted-foreground">
        No tenant selected. Please select a tenant first.
      </div>
    )
  }

  const invitations = await UserRepository.findInvitations(tenantId)

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Invitations</h1>
        <p className="text-sm text-muted-foreground">
          View and manage pending invitations for your team.
        </p>
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Email</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Expires</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {invitations.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="h-24 text-center text-muted-foreground"
                >
                  No invitations yet.
                </TableCell>
              </TableRow>
            ) : (
              invitations.map((inv) => {
                const isAccepted = !!inv.acceptedAt
                const isExpired = !isAccepted && inv.expiresAt < new Date()
                const status = isAccepted
                  ? 'Accepted'
                  : isExpired
                    ? 'Expired'
                    : 'Pending'
                const variant = isAccepted
                  ? 'default'
                  : isExpired
                    ? 'destructive'
                    : ('secondary' as const)

                return (
                  <TableRow key={inv.id}>
                    <TableCell className="font-medium">{inv.email}</TableCell>
                    <TableCell>
                      <Badge variant={variant}>{status}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {inv.expiresAt.toLocaleDateString()}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {inv.createdAt.toLocaleDateString()}
                    </TableCell>
                    <TableCell>
                      {!isAccepted && !isExpired && (
                        <InvitationCopyLink token={inv.token} />
                      )}
                    </TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
