import * as React from 'react'
import { cn } from '@/shared/lib/utils'

interface UsageBarProps {
  used: number
  /** -1 means unlimited (convention from PlanConfig). */
  limit: number
  label?: string
  className?: string
  /** When true, renders a compact single-line variant for table cells. */
  compact?: boolean
}

/**
 * Usage bar that visualises `used / limit`.
 * Color ramps at 80% (amber) and 100% (red); unlimited shows a neutral "∞".
 * Used in the tenant list (compact) and in the tenant overview (full).
 */
export function UsageBar({
  used,
  limit,
  label,
  className,
  compact = false,
}: UsageBarProps) {
  const unlimited = limit === -1
  const ratio = unlimited ? 0 : Math.min(used / Math.max(limit, 1), 1)
  const pct = Math.round(ratio * 100)

  const color = unlimited
    ? 'bg-muted-foreground/30'
    : ratio >= 1
      ? 'bg-red-500'
      : ratio >= 0.8
        ? 'bg-amber-500'
        : 'bg-emerald-500'

  const valueText = unlimited ? `${used} / ∞` : `${used} / ${limit}`

  if (compact) {
    return (
      <div className={cn('flex items-center gap-2 min-w-[90px]', className)}>
        <div className="h-1.5 w-12 overflow-hidden rounded-full bg-muted">
          <div
            className={cn('h-full rounded-full transition-all', color)}
            style={{ width: unlimited ? '100%' : `${Math.max(pct, 2)}%` }}
          />
        </div>
        <span className="text-xs tabular-nums text-muted-foreground">
          {valueText}
        </span>
      </div>
    )
  }

  return (
    <div className={cn('space-y-1.5', className)}>
      {label && (
        <div className="flex items-center justify-between text-xs">
          <span className="font-medium text-muted-foreground uppercase tracking-wider">
            {label}
          </span>
          <span className="tabular-nums text-foreground">{valueText}</span>
        </div>
      )}
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div
          className={cn('h-full rounded-full transition-all', color)}
          style={{ width: unlimited ? '100%' : `${Math.max(pct, 2)}%` }}
        />
      </div>
    </div>
  )
}
