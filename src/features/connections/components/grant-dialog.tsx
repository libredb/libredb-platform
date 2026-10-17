'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog'
import { setConnectionGrant } from '../actions/set-connection-grant'
import type { ConnectionAccessGrant, DirectoryUserMatch, GrantLevelValue } from '../lib/grant.schema'
import { DirectoryUserPicker } from './directory-user-picker'

const LEVEL_OPTIONS: { value: GrantLevelValue; label: string; hint: string }[] = [
  { value: 'read', label: 'Read', hint: 'Studio opens the connection with its read credential.' },
  { value: 'write', label: 'Write', hint: 'Studio opens the connection with its write credential.' },
]

/** A time as the value of a datetime-local input, in the browser's time zone. */
function localInputValue(iso: string | null): string {
  if (iso === null) return ''
  const date = new Date(iso)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function FieldError({ messages }: { messages?: string[] }) {
  if (!messages?.length) return null
  return (
    <>
      {messages.map((message) => (
        <p key={message} className="text-xs text-destructive">
          {message}
        </p>
      ))}
    </>
  )
}

/** What the dialog sets: a grant to a user picked from the directory, or a change to an existing grant. */
export type GrantDialogTarget = { kind: 'new' } | { kind: 'change'; grant: ConnectionAccessGrant }

interface GrantDialogProps {
  connectionId: string
  hasWriteCredential: boolean
  target: GrantDialogTarget
  onClose: () => void
}

/**
 * Grants a Keycloak user read or write on the connection, or changes the level and expiry of a grant, through
 * setConnectionGrant. Write is disabled when the connection has no write credential, which the action
 * refuses as well. Render it with a key per target, so each opening starts from the target's values.
 */
export function GrantDialog({ connectionId, hasWriteCredential, target, onClose }: GrantDialogProps) {
  const existing = target.kind === 'change' ? target.grant : null
  const [picked, setPicked] = useState<DirectoryUserMatch | null>(null)
  const [level, setLevel] = useState<GrantLevelValue>(
    existing !== null && hasWriteCredential ? existing.level : 'read',
  )
  const [expiry, setExpiry] = useState(localInputValue(existing?.expiresAt ?? null))
  const [errors, setErrors] = useState<Record<string, string[]>>({})
  const [isPending, startTransition] = useTransition()

  const subject = existing !== null ? existing.subject : picked?.id ?? null
  const username = existing !== null ? existing.username : picked?.username ?? null

  function submit() {
    if (subject === null) return
    startTransition(async () => {
      const result = await setConnectionGrant({
        connectionId,
        subject,
        level,
        expiresAt: expiry === '' ? null : new Date(expiry),
      })
      if (result.success) {
        toast.success(existing !== null ? `${username}'s grant is changed` : `${username} is granted ${level}`)
        onClose()
        return
      }
      setErrors(result.fieldErrors ?? {})
      toast.error(result.error)
    })
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{existing !== null ? `Change the grant of ${existing.username}` : 'Grant access'}</DialogTitle>
          <DialogDescription>
            {existing !== null
              ? 'Studio applies the new level and expiry as soon as it is saved.'
              : 'Pick a user of the Keycloak directory and the level Studio opens the connection with.'}
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
        >
          {existing === null && (
            <div className="space-y-2">
              <DirectoryUserPicker selected={picked} onSelect={setPicked} />
              <FieldError messages={errors.subject} />
            </div>
          )}

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Level</legend>
            {LEVEL_OPTIONS.map((option) => {
              const disabled = option.value === 'write' && !hasWriteCredential
              return (
                <div key={option.value} className="text-sm">
                  <label className="flex items-center gap-2 has-disabled:opacity-60">
                    <input
                      type="radio"
                      name="grant-level"
                      className="size-4 accent-primary"
                      value={option.value}
                      checked={level === option.value}
                      disabled={disabled}
                      onChange={() => setLevel(option.value)}
                      aria-describedby={`grant-level-${option.value}-hint`}
                    />
                    <span className="font-medium">{option.label}</span>
                  </label>
                  <p id={`grant-level-${option.value}-hint`} className="pl-6 text-xs text-muted-foreground">
                    {disabled ? 'The connection has no write credential, so it can be granted read only.' : option.hint}
                  </p>
                </div>
              )
            })}
            <FieldError messages={errors.level} />
          </fieldset>

          <div className="space-y-2">
            <Label htmlFor="grant-expiry">Expires</Label>
            <Input
              id="grant-expiry"
              type="datetime-local"
              value={expiry}
              onChange={(event) => setExpiry(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">Leave empty for a grant that does not expire.</p>
            <FieldError messages={errors.expiresAt} />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={isPending || subject === null}>
              {existing !== null ? 'Save' : 'Grant'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
