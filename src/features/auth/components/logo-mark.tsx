'use client'

import { cn } from '@/shared/lib/utils'

interface LogoMarkProps {
  className?: string
}

export function LogoMark({ className }: LogoMarkProps) {
  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      <div
        className="relative flex h-7 w-7 items-center justify-center rounded-md bg-gradient-to-br from-primary to-chart-4 text-primary-foreground font-bold text-sm"
        aria-hidden="true"
      >
        L
        <span
          data-testid="logo-health-dot"
          aria-hidden="true"
          className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-chart-4 shadow-[0_0_6px_var(--chart-4)] animate-logo-pulse"
        />
      </div>
      <span className="font-heading font-bold tracking-tight text-[15px] text-foreground">
        LibreDB
      </span>
      <span className="text-[10px] text-muted-foreground/70 tracking-wider">
        Platform
      </span>
    </div>
  )
}
