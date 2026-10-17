'use client'

import { useState } from 'react'
import Form from 'next/form'
import Link from 'next/link'
import { ChevronLeftIcon, ChevronRightIcon, SearchIcon } from 'lucide-react'
import { Badge } from '@/shared/components/ui/badge'
import { Button, buttonVariants } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
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
import { revokeStudioSessions } from '../actions/revoke-studio-sessions'
import type { StudioUser, StudioUserRole, StudioUsersPage } from '../lib/studio-users'

const PAGE_PATH = '/studio-users'

const ROLE_LABELS: Record<StudioUserRole, string> = { admin: 'Admin', user: 'User' }

/** The URL of a page of the listing, which keeps the search. */
function pageHref(search: string, page: number): string {
  const params = new URLSearchParams()
  if (search !== '') params.set('q', search)
  params.set('page', String(page))
  return `${PAGE_PATH}?${params.toString()}`
}

function countOf(total: number): string {
  return total === 1 ? '1 user' : `${total} users`
}

interface StudioUsersTableProps {
  page: StudioUsersPage
  /** The search the page was listed with, which the search box and the page links keep. */
  search: string
}

/**
 * The members of the admin and user roles with their role badges and enabled flag, searchable and 20 per page through
 * the page URL, each with "Revoke Studio sessions" behind a confirmation.
 */
export function StudioUsersTable({ page, search }: StudioUsersTableProps) {
  // The user whose sessions the confirmation dialog is about to revoke.
  const [target, setTarget] = useState<StudioUser | null>(null)
  const { execute, isPending } = useAction(revokeStudioSessions, {
    successMessage: target ? `${target.username}'s Studio sessions are revoked` : undefined,
    onSuccess: () => setTarget(null),
  })

  return (
    <div className="space-y-4">
      <Form action={PAGE_PATH} role="search" className="flex max-w-md items-center gap-2">
        <Input
          type="search"
          name="q"
          aria-label="Search Studio users"
          placeholder="Username, email or name"
          defaultValue={search}
        />
        <Button type="submit" variant="outline">
          <SearchIcon />
          Search
        </Button>
      </Form>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Roles</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {page.users.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                  {search === '' ? 'No user holds the admin or user role.' : `No Studio user matches ${search}.`}
                </TableCell>
              </TableRow>
            ) : (
              page.users.map((user) => (
                <TableRow key={user.id}>
                  <TableCell>
                    <div className="font-medium">{user.username}</div>
                    {user.name !== null && <div className="text-xs text-muted-foreground">{user.name}</div>}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{user.email ?? '-'}</TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      {user.roles.map((role) => (
                        <Badge key={role} variant={role === 'admin' ? 'default' : 'secondary'}>
                          {ROLE_LABELS[role]}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={user.enabled ? 'success' : 'destructive'}>{user.enabled ? 'Enabled' : 'Disabled'}</Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button type="button" variant="outline" size="sm" onClick={() => setTarget(user)}>
                      Revoke Studio sessions
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
        <span>
          Page {page.page} of {page.pageCount}, {countOf(page.total)}
        </span>
        <div className="flex gap-2">
          {page.page > 1 && (
            <Link
              href={pageHref(search, page.page - 1)}
              aria-label="Previous page"
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              <ChevronLeftIcon />
              Previous
            </Link>
          )}
          {page.page < page.pageCount && (
            <Link
              href={pageHref(search, page.page + 1)}
              aria-label="Next page"
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              Next
              <ChevronRightIcon />
            </Link>
          )}
        </div>
      </div>

      <Dialog open={target !== null} onOpenChange={(open) => !open && setTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke the Studio sessions of {target?.username}?</DialogTitle>
            <DialogDescription>
              Studio ends every session and MCP token of {target?.username} issued until now. {target?.username} can
              sign in again while still holding a LibreDB role in Keycloak.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setTarget(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={isPending}
              onClick={() => target && execute({ subject: target.id })}
            >
              Revoke sessions
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
