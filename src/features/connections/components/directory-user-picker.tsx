'use client'

import { useEffect, useState, useTransition } from 'react'
import { ChevronLeftIcon, ChevronRightIcon, SearchIcon } from 'lucide-react'
import { Badge } from '@/shared/components/ui/badge'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { searchDirectoryUsers } from '../actions/search-directory-users'
import { DIRECTORY_PAGE_SIZE, type DirectoryUserMatch, type DirectoryUserPage, type StudioRole } from '../lib/grant.schema'

const ROLE_LABELS: Record<StudioRole, string> = { admin: 'Admin', user: 'User' }

function displayName(user: DirectoryUserMatch): string | null {
  const name = [user.firstName, user.lastName].filter((part) => part !== null && part !== '').join(' ')
  return name === '' ? null : name
}

interface DirectoryUserPickerProps {
  /** The user picked so far. */
  selected: DirectoryUserMatch | null
  onSelect: (user: DirectoryUserMatch) => void
}

/**
 * Searches the Keycloak directory through searchDirectoryUsers, 20 users per page with their effective role badges,
 * and lets the admin pick one. A disabled user is listed but cannot be picked, because a grant to one is
 * refused. A user who holds no user seat of the license is marked and can still be picked; the seat gate decides.
 */
export function DirectoryUserPicker({ selected, onSelect }: DirectoryUserPickerProps) {
  const [text, setText] = useState('')
  // The search of the page shown, which the page buttons keep while the admin edits the text.
  const [searched, setSearched] = useState('')
  const [result, setResult] = useState<DirectoryUserPage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  function load(search: string, page: number) {
    startTransition(async () => {
      const answer = await searchDirectoryUsers({ search, page })
      if (answer.success) {
        setSearched(search)
        setResult(answer.data)
        setError(null)
      } else {
        setResult(null)
        setError(answer.error)
      }
    })
  }

  // The first page of every user, so the admin can pick without typing.
  useEffect(() => {
    load('', 1)
  }, [])

  const search = text.trim()
  const pageCount = result === null ? 1 : Math.max(1, Math.ceil(result.total / DIRECTORY_PAGE_SIZE))

  return (
    <div className="space-y-3">
      <div role="search" className="flex items-center gap-2">
        <Input
          type="search"
          aria-label="Search the directory"
          placeholder="Username, name or email"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              load(search, 1)
            }
          }}
        />
        <Button type="button" variant="outline" disabled={isPending} onClick={() => load(search, 1)}>
          <SearchIcon />
          Search
        </Button>
      </div>

      {error !== null && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <fieldset className="max-h-64 space-y-1 overflow-y-auto rounded-md border p-2" aria-busy={isPending}>
        <legend className="sr-only">Directory users</legend>
        {result !== null && result.users.length === 0 && (
          <p className="p-2 text-sm text-muted-foreground">{searched === '' ? 'The directory has no user.' : `No Keycloak user matches ${searched}.`}</p>
        )}
        {result?.users.map((user) => {
          const name = displayName(user)
          return (
            <label
              key={user.id}
              className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-muted has-disabled:cursor-not-allowed has-disabled:opacity-60"
            >
              <input
                type="radio"
                name="directory-user"
                className="size-4 accent-primary"
                value={user.id}
                checked={selected?.id === user.id}
                disabled={!user.enabled}
                onChange={() => onSelect(user)}
              />
              <span className="min-w-0 flex-1">
                <span className="font-medium">{user.username}</span>
                {name !== null && <span className="text-muted-foreground"> ({name})</span>}
                <span className="block truncate text-xs text-muted-foreground">{user.email ?? 'No email'}</span>
              </span>
              {user.studioRole === null ? (
                <Badge variant="outline">No role</Badge>
              ) : (
                <Badge variant={user.studioRole === 'admin' ? 'default' : 'secondary'}>{ROLE_LABELS[user.studioRole]}</Badge>
              )}
              {!user.enabled && <Badge variant="destructive">Disabled</Badge>}
              {user.needsSeat && <Badge variant="warning">Needs a seat</Badge>}
            </label>
          )
        })}
      </fieldset>

      {result?.users.some((user) => user.needsSeat) && (
        <p className="text-xs text-muted-foreground">
          Users marked Needs a seat hold no user seat yet, and a grant to one takes a seat of the license while the
          connection is active.
        </p>
      )}

      {result !== null && (
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>
            Page {result.page} of {pageCount}, {result.total === 1 ? '1 user' : `${result.total} users`}
          </span>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label="Previous page"
              disabled={isPending || result.page <= 1}
              onClick={() => load(searched, result.page - 1)}
            >
              <ChevronLeftIcon />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label="Next page"
              disabled={isPending || result.page >= pageCount}
              onClick={() => load(searched, result.page + 1)}
            >
              <ChevronRightIcon />
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
