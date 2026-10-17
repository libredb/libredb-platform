'use client'

import { useState } from 'react'
import { UserPlusIcon } from 'lucide-react'
import { Badge } from '@/shared/components/ui/badge'
import { Button } from '@/shared/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/shared/components/ui/table'
import { useAction } from '@/shared/hooks/use-action'
import { revokeConnectionGrant } from '../actions/revoke-connection-grant'
import type { ConnectionAccess, ConnectionAccessGrant, GrantSubjectStatus } from '../lib/grant.schema'
import { GrantDialog, type GrantDialogTarget } from './grant-dialog'

/** A time in UTC, so the server and the browser render the same text. */
function formatTime(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`
}

function DirectoryBadge({ directory }: { directory: GrantSubjectStatus }) {
  switch (directory.status) {
    case 'missing':
      return <Badge variant="destructive">Not in directory</Badge>
    case 'unknown':
      return <Badge variant="outline">Unknown</Badge>
    case 'present':
      return (
        <div className="flex gap-1">
          {directory.studioRole === null ? (
            <Badge variant="outline">No role</Badge>
          ) : (
            <Badge variant={directory.studioRole === 'admin' ? 'default' : 'secondary'}>
              {directory.studioRole === 'admin' ? 'Admin' : 'User'}
            </Badge>
          )}
          {!directory.enabled && <Badge variant="destructive">Disabled</Badge>}
        </div>
      )
  }
}

interface ConnectionAccessPanelProps {
  connectionId: string
  hasWriteCredential: boolean
  access: ConnectionAccess
}

/**
 * The grants of a connection: each subject with the username and email kept with the grant, the live role
 * badge from the Keycloak directory, the level, the downgraded flag, the expiry, the granter and the grant time.
 * A subject Keycloak no longer knows is flagged "Not in directory". Granting and changing read the directory, so they
 * are disabled while it cannot be read; revoking is not, because it only narrows access.
 */
export function ConnectionAccessPanel({ connectionId, hasWriteCredential, access }: ConnectionAccessPanelProps) {
  const [editing, setEditing] = useState<GrantDialogTarget | null>(null)
  // The grant the revoke confirmation is about.
  const [revoking, setRevoking] = useState<ConnectionAccessGrant | null>(null)
  const { execute, isPending } = useAction(revokeConnectionGrant, {
    successMessage: revoking ? `${revoking.username}'s access is revoked` : undefined,
    onSuccess: () => setRevoking(null),
  })

  const canGrant = access.directory === 'available'

  return (
    <section className="space-y-4" aria-labelledby="connection-access-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id="connection-access-heading" className="text-lg font-semibold">
            Access
          </h2>
          <p className="text-sm text-muted-foreground">
            The Keycloak users who can open this connection in Studio
            {hasWriteCredential ? '.' : '. It has no write credential, so it can be granted read only.'}
          </p>
        </div>
        <Button type="button" disabled={!canGrant} onClick={() => setEditing({ kind: 'new' })}>
          <UserPlusIcon />
          Grant access
        </Button>
      </div>

      {access.directory === 'unreachable' && (
        <p role="status" className="text-sm text-amber-600 dark:text-amber-400">
          Keycloak did not answer, so the directory status of each user is unknown and granting is disabled.
        </p>
      )}

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Level</TableHead>
              <TableHead>Expires</TableHead>
              <TableHead>Granted by</TableHead>
              <TableHead>Granted</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {access.grants.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                  No user holds a grant on this connection.
                </TableCell>
              </TableRow>
            ) : (
              access.grants.map((grant) => (
                <TableRow key={grant.id}>
                  <TableCell>
                    <div className="font-medium">{grant.username}</div>
                    <div className="text-xs text-muted-foreground">{grant.email ?? '-'}</div>
                  </TableCell>
                  <TableCell>
                    <DirectoryBadge directory={grant.directory} />
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Badge variant={grant.level === 'write' ? 'warning' : 'secondary'}>
                        {grant.level === 'write' ? 'Write' : 'Read'}
                      </Badge>
                      {grant.downgraded && (
                        <Badge variant="outline" title="The connection has no write credential, so Studio serves read">
                          Downgraded
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {grant.expiresAt === null ? 'Never' : <time dateTime={grant.expiresAt}>{formatTime(grant.expiresAt)}</time>}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{grant.grantedBy}</TableCell>
                  <TableCell className="text-muted-foreground">
                    <time dateTime={grant.grantedAt}>{formatTime(grant.grantedAt)}</time>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={!canGrant}
                        onClick={() => setEditing({ kind: 'change', grant })}
                      >
                        Change
                      </Button>
                      <Button type="button" variant="outline" size="sm" onClick={() => setRevoking(grant)}>
                        Revoke
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {editing !== null && (
        <GrantDialog
          key={editing.kind === 'change' ? editing.grant.id : 'new'}
          connectionId={connectionId}
          hasWriteCredential={hasWriteCredential}
          target={editing}
          onClose={() => setEditing(null)}
        />
      )}

      <Dialog open={revoking !== null} onOpenChange={(open) => !open && setRevoking(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke the access of {revoking?.username}?</DialogTitle>
            <DialogDescription>
              Studio stops opening this connection for {revoking?.username} as soon as the grant is removed.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setRevoking(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={isPending}
              onClick={() => revoking && execute({ grantId: revoking.id })}
            >
              Revoke access
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
