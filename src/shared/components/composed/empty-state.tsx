import * as React from "react"
import { cn } from "@/shared/lib/utils"
import { type LucideIcon } from "lucide-react"
import { Button } from "@/shared/components/ui/button"

interface EmptyStateProps {
  icon: LucideIcon
  title: string
  description: string
  action?: {
    label: string
    onClick?: () => void
  }
  className?: string
}

export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn("flex flex-col items-center justify-center py-16", className)}>
      <div className="rounded-full bg-muted p-4 mb-4 dark:bg-white/[0.03]">
        <Icon className="size-8 text-muted-foreground/50" />
      </div>
      <h3 className="font-semibold tracking-tight font-heading">{title}</h3>
      <p className="text-sm text-muted-foreground mt-1 max-w-sm text-center">{description}</p>
      {action && (
        <Button className="mt-4" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </div>
  )
}
