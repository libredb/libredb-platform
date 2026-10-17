'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Switch } from '@/shared/components/ui/switch'
import { Badge } from '@/shared/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/components/ui/select'
import type { Result } from '@/shared/types'
import { updateStudioSetting } from '../actions/update-studio-setting'
import { resetStudioSetting } from '../actions/reset-studio-setting'
import { HELD_STUDIO_SETTING_NOTE, type StudioSettingField, type StudioSettingValue } from '../lib/setting-value'

const HELD_NOTE = `${HELD_STUDIO_SETTING_NOTE.charAt(0).toUpperCase()}${HELD_STUDIO_SETTING_NOTE.slice(1)}.`

/** The control's draft as text, or a boolean for a switch; an unset key starts empty, or off for a switch. */
type Draft = string | boolean

function initialDraft(field: StudioSettingField): Draft {
  if (field.valueType === 'boolean') return field.value === true
  return field.value === null ? '' : String(field.value)
}

/** The value a draft stands for, or an error message when an integer draft is not a number. */
function draftValue(field: StudioSettingField, draft: Draft): { value: StudioSettingValue } | { error: string } {
  if (field.valueType === 'boolean') return { value: draft === true }
  if (field.valueType === 'integer') {
    const text = String(draft).trim()
    if (!/^-?\d+$/.test(text)) return { error: 'must be a whole number' }
    return { value: Number(text) }
  }
  return { value: String(draft) }
}

function formatValue(value: StudioSettingValue): string {
  if (typeof value === 'boolean') return value ? 'On' : 'Off'
  return String(value)
}

function errorsOf(result: Result<unknown>): string[] {
  if (result.success) return []
  const fieldErrors = Object.values(result.fieldErrors ?? {}).flat()
  return fieldErrors.length > 0 ? fieldErrors : [result.error]
}

function SettingControl({
  field,
  draft,
  onChange,
}: {
  field: StudioSettingField
  draft: Draft
  onChange: (draft: Draft) => void
}) {
  if (field.valueType === 'boolean') {
    return (
      <Switch
        aria-label={field.key}
        checked={draft === true}
        disabled={field.held}
        onCheckedChange={(checked) => onChange(checked)}
      />
    )
  }
  if (field.valueType === 'integer') {
    return (
      <Input
        aria-label={field.key}
        type="number"
        step={1}
        min={field.minValue ?? undefined}
        max={field.maxValue ?? undefined}
        value={String(draft)}
        disabled={field.held}
        onChange={(event) => onChange(event.target.value)}
        className="w-48"
      />
    )
  }
  if (field.allowedValues !== null) {
    return (
      <Select value={String(draft)} disabled={field.held} onValueChange={(value) => onChange(String(value ?? ''))}>
        <SelectTrigger aria-label={field.key} className="w-48">
          <SelectValue placeholder="Choose a value" />
        </SelectTrigger>
        <SelectContent>
          {field.allowedValues.map((allowed) => (
            <SelectItem key={String(allowed)} value={String(allowed)}>
              {String(allowed)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    )
  }
  return (
    <Input
      aria-label={field.key}
      value={String(draft)}
      disabled={field.held}
      onChange={(event) => onChange(event.target.value)}
      className="w-72"
    />
  )
}

function SettingRow({ field }: { field: StudioSettingField }) {
  const router = useRouter()
  const [draft, setDraft] = useState<Draft>(() => initialDraft(field))
  const [errors, setErrors] = useState<string[]>([])
  const [isPending, startTransition] = useTransition()

  const run = (action: () => Promise<Result<{ key: string }>>, successMessage: string) => {
    startTransition(async () => {
      const result = await action()
      setErrors(errorsOf(result))
      if (result.success) {
        toast.success(successMessage)
        router.refresh()
      }
    })
  }

  const save = () => {
    const parsed = draftValue(field, draft)
    if ('error' in parsed) {
      setErrors([parsed.error])
      return
    }
    run(() => updateStudioSetting({ key: field.key, value: parsed.value }), `${field.key} saved`)
  }

  const reset = () => {
    run(() => resetStudioSetting({ key: field.key }), `${field.key} reset to Studio default`)
  }

  const range =
    field.valueType === 'integer' && (field.minValue !== null || field.maxValue !== null)
      ? `${field.minValue ?? 'any'} to ${field.maxValue ?? 'any'}`
      : null

  return (
    <section role="group" aria-label={field.key} className="space-y-2 border-b py-4 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm font-medium">{field.key}</span>
        {field.value === null ? (
          <Badge variant="secondary" data-testid="current-value">Studio default</Badge>
        ) : (
          <Badge variant="outline" data-testid="current-value">{formatValue(field.value)}</Badge>
        )}
      </div>
      <p className="text-sm text-muted-foreground">{field.description}</p>
      {range && <p className="text-xs text-muted-foreground">Allowed range: {range}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <SettingControl field={field} draft={draft} onChange={setDraft} />
        {!field.held && (
          <Button type="button" size="sm" aria-label={`Save ${field.key}`} disabled={isPending} onClick={save}>
            Save
          </Button>
        )}
        {!field.held && field.value !== null && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-label={`Reset ${field.key}`}
            disabled={isPending}
            onClick={reset}
          >
            Reset to Studio default
          </Button>
        )}
      </div>
      {field.held && <p className="text-xs text-muted-foreground">{HELD_NOTE}</p>}
      {errors.map((error) => (
        <p key={error} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ))}
    </section>
  )
}

/** The Studio settings form, generated from the allowlist rows. */
export function StudioSettingsForm({ settings }: { settings: StudioSettingField[] }) {
  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle>Runtime settings</CardTitle>
        <CardDescription>
          Studio applies these values without a restart. A key without a value takes Studio&apos;s default.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {settings.map((field) => (
          <SettingRow key={`${field.key}:${field.updatedAt ?? 'default'}`} field={field} />
        ))}
      </CardContent>
    </Card>
  )
}
