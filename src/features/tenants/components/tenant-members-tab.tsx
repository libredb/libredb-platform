import { ExternalLinkIcon, UsersIcon } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { Badge } from '@/shared/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/shared/components/ui/table'
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from '@/shared/components/ui/avatar'
import { EmptyState } from '@/shared/components/composed/empty-state'

export interface MemberView {
  id: string
  isDefault: boolean
  active: boolean
  user: {
    id: string
    name: string | null
    email: string
    avatarUrl: string | null
    lastLoginAt: string | null
    active: boolean
  }
  roles: { role: { code: string; name: string } }[]
}

export function TenantMembersTab({ members }: { members: MemberView[] }) {
  if (members.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card p-6">
        <EmptyState
          icon={UsersIcon}
          title="No members"
          description="This tenant has no members yet."
        />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <InfoBanner />
      <div className="rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Member</TableHead>
              <TableHead>Roles</TableHead>
              <TableHead>Last Login</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((m) => (
              <TableRow key={m.id}>
                <TableCell>
                  <div className="flex items-center gap-3">
                    <Avatar size="sm">
                      {m.user.avatarUrl && (
                        <AvatarImage src={m.user.avatarUrl} alt="" />
                      )}
                      <AvatarFallback>
                        {getInitials(m.user.name, m.user.email)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex flex-col">
                      <span className="text-sm font-medium">
                        {m.user.name ?? m.user.email}
                      </span>
                      {m.user.name && (
                        <span className="text-xs text-muted-foreground">
                          {m.user.email}
                        </span>
                      )}
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  {m.roles.length === 0 ? (
                    <span className="text-sm text-muted-foreground">
                      No role
                    </span>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {m.roles.map((r) => (
                        <Badge
                          key={r.role.code}
                          variant={
                            r.role.code.includes('ADMIN')
                              ? 'default'
                              : 'secondary'
                          }
                        >
                          {r.role.name}
                        </Badge>
                      ))}
                    </div>
                  )}
                </TableCell>
                <TableCell>
                  <span className="text-sm text-muted-foreground">
                    {m.user.lastLoginAt
                      ? formatDistanceToNow(new Date(m.user.lastLoginAt), {
                          addSuffix: true,
                        })
                      : 'Never'}
                  </span>
                </TableCell>
                <TableCell>
                  {m.active && m.user.active ? (
                    <span className="inline-flex items-center gap-1.5 text-sm text-emerald-500 dark:text-emerald-400">
                      <span className="inline-block size-1.5 rounded-full bg-current" />
                      Active
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
                      <span className="inline-block size-1.5 rounded-full border border-current" />
                      Inactive
                    </span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

function InfoBanner() {
  return (
    <div className="flex items-center justify-between rounded-md border border-border bg-muted/30 px-4 py-2.5 text-xs">
      <span className="text-muted-foreground">
        Read-only view. Member management lives inside each tenant&apos;s Team page.
      </span>
      <span className="inline-flex items-center gap-1 text-muted-foreground/60">
        <ExternalLinkIcon className="size-3" />
        Sign in as a tenant admin to manage roles
      </span>
    </div>
  )
}

function getInitials(name: string | null, email: string) {
  if (name) {
    return name
      .split(' ')
      .map((p) => p[0])
      .slice(0, 2)
      .join('')
      .toUpperCase()
  }
  return email.slice(0, 2).toUpperCase()
}
