import * as React from "react"
import { cn } from "@/shared/lib/utils"
import { type LucideIcon } from "lucide-react"

interface StatCardProps {
  title: string
  value: string | number
  icon: LucideIcon
  trend?: { value: string; positive: boolean }
  className?: string
}

export function StatCard({ title, value, icon: Icon, trend, className }: StatCardProps) {
  return (
    <div className={cn("rounded-lg border border-border bg-card p-5", className)}>
      <div className="flex items-center justify-between mb-3">
        <div className="rounded-md bg-primary/10 p-2">
          <Icon className="size-4 text-primary" />
        </div>
        {trend && (
          <span className={cn(
            "text-xs font-medium",
            trend.positive ? "text-emerald-500 dark:text-emerald-400" : "text-red-500 dark:text-red-400"
          )}>
            {trend.positive ? "\u2191" : "\u2193"} {trend.value}
          </span>
        )}
      </div>
      <div className="text-3xl font-semibold tracking-tight tabular-nums">{value}</div>
      <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground mt-1">{title}</div>
    </div>
  )
}
