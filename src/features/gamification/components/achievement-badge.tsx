'use client'

import {
  Zap, Plug, Share2, Compass, Languages, Bot, Library,
  UsersRound, Flame, Trophy, Target, Award, type LucideIcon,
} from 'lucide-react'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/shared/components/ui/tooltip'
import { cn } from '@/shared/lib/utils'

const ICON_MAP: Record<string, LucideIcon> = {
  zap: Zap,
  plug: Plug,
  'share-2': Share2,
  compass: Compass,
  languages: Languages,
  bot: Bot,
  library: Library,
  'users-round': UsersRound,
  flame: Flame,
  trophy: Trophy,
  target: Target,
  award: Award,
}

interface AchievementBadgeProps {
  name: string
  description: string
  icon: string
  progress: number
  threshold: number
  unlockedAt: Date | null
}

export function AchievementBadge({
  name,
  description,
  icon,
  progress,
  threshold,
  unlockedAt,
}: AchievementBadgeProps) {
  const Icon = ICON_MAP[icon] ?? Zap
  const isUnlocked = !!unlockedAt
  const progressPercent = Math.min((progress / threshold) * 100, 100)

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            className={cn(
              'flex flex-col items-center gap-1.5 rounded-lg border p-3 transition-colors',
              isUnlocked
                ? 'border-primary/30 bg-primary/5'
                : 'border-border bg-muted/30 opacity-60'
            )}
          >
            <div
              className={cn(
                'flex size-10 items-center justify-center rounded-full',
                isUnlocked
                  ? 'bg-primary/10 text-primary'
                  : 'bg-muted text-muted-foreground'
              )}
            >
              <Icon className="size-5" />
            </div>
            <span className="text-xs font-medium leading-tight text-center">
              {name}
            </span>
            {!isUnlocked && (
              <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary/50 transition-all"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            )}
          </div>
        }
      />
      <TooltipContent>
        <p>{description}</p>
        {!isUnlocked && (
          <p className="mt-0.5 opacity-70">
            {progress}/{threshold}
          </p>
        )}
      </TooltipContent>
    </Tooltip>
  )
}
