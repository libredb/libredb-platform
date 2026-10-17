'use client'

import { useQuery } from '@tanstack/react-query'
import { Flame, Star } from 'lucide-react'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/shared/components/ui/tooltip'

interface UserStats {
  streak: { currentStreak: number; longestStreak: number; totalActiveDays: number }
  xp: number
  level: number
}

export function StreakDisplay() {
  const { data } = useQuery({
    queryKey: ['gamification', 'stats'],
    queryFn: async () => {
      const res = await fetch('/api/gamification/stats')
      if (!res.ok) return null
      return res.json() as Promise<UserStats>
    },
    refetchInterval: 120_000,
  })

  if (!data) return null

  return (
    <div className="flex items-center gap-3">
      {/* Streak */}
      <Tooltip>
        <TooltipTrigger
          render={
            <div className="flex items-center gap-1 text-sm text-muted-foreground">
              <Flame
                className={
                  data.streak.currentStreak > 0
                    ? 'size-4 text-orange-500'
                    : 'size-4'
                }
              />
              <span className="font-medium tabular-nums">
                {data.streak.currentStreak}
              </span>
            </div>
          }
        />
        <TooltipContent>
          {data.streak.currentStreak > 0
            ? `${data.streak.currentStreak}-day streak! Longest: ${data.streak.longestStreak}`
            : 'Start your streak by being active today!'}
        </TooltipContent>
      </Tooltip>

      {/* XP / Level */}
      <Tooltip>
        <TooltipTrigger
          render={
            <div className="flex items-center gap-1 text-sm text-muted-foreground">
              <Star className="size-4 text-yellow-500" />
              <span className="font-medium tabular-nums">
                Lv.{data.level}
              </span>
            </div>
          }
        />
        <TooltipContent>
          {data.xp} XP total &middot; {100 - (data.xp % 100)} XP to next level
        </TooltipContent>
      </Tooltip>
    </div>
  )
}
