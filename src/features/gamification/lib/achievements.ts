import { db } from '@/shared/lib/db'
import { ACHIEVEMENTS } from './achievement-definitions'

export async function trackEvent(userId: string, event: string, _metadata?: Record<string, unknown>) {
  try {
    // Update streak
    await updateStreak(userId)

    // Check achievements based on event
    switch (event) {
      case 'query.executed':
        await incrementAchievement(userId, 'first_query')
        await incrementAchievement(userId, 'queries_100')
        await incrementAchievement(userId, 'queries_1000')
        break
      case 'connection.created':
        await incrementAchievement(userId, 'first_connection')
        break
      case 'query.shared':
        await incrementAchievement(userId, 'first_shared_query')
        await incrementAchievement(userId, 'query_library')
        break
      case 'schema.viewed':
        await incrementAchievement(userId, 'explore_schema')
        break
      case 'user.invited':
        await incrementAchievement(userId, 'mentor')
        break
    }
  } catch {
    // Fire-and-forget: never block the main action
  }
}

async function incrementAchievement(userId: string, achievementCode: string) {
  const def = ACHIEVEMENTS.find(a => a.code === achievementCode)
  if (!def) return

  const achievement = await db.achievement.findUnique({ where: { code: achievementCode } })
  if (!achievement) return

  const userAch = await db.userAchievement.upsert({
    where: { userId_achievementId: { userId, achievementId: achievement.id } },
    update: { progress: { increment: 1 } },
    create: { userId, achievementId: achievement.id, progress: 1 },
  })

  // Check if just unlocked
  if (!userAch.unlockedAt && userAch.progress >= def.threshold) {
    await db.userAchievement.update({
      where: { id: userAch.id },
      data: { unlockedAt: new Date() },
    })
    // Create notification
    await db.notification.create({
      data: {
        userId,
        type: 'SUCCESS',
        title: `Achievement Unlocked: ${def.name}`,
        message: def.description,
        link: '/profile',
      },
    })
  }
}

async function updateStreak(userId: string) {
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const streak = await db.userStreak.upsert({
    where: { userId },
    update: {},
    create: { userId, currentStreak: 0, longestStreak: 0, totalActiveDays: 0 },
  })

  const lastActive = streak.lastActiveDate ? new Date(streak.lastActiveDate) : null
  if (lastActive) lastActive.setHours(0, 0, 0, 0)

  if (lastActive && lastActive.getTime() === today.getTime()) return // already counted today

  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)

  const isConsecutive = lastActive && lastActive.getTime() === yesterday.getTime()
  const newStreak = isConsecutive ? streak.currentStreak + 1 : 1
  const newLongest = Math.max(streak.longestStreak, newStreak)

  await db.userStreak.update({
    where: { userId },
    data: {
      currentStreak: newStreak,
      longestStreak: newLongest,
      lastActiveDate: today,
      totalActiveDays: streak.totalActiveDays + 1,
    },
  })

  // Check streak achievements
  if (newStreak >= 7) await incrementAchievement(userId, 'streak_7')
  if (newStreak >= 30) await incrementAchievement(userId, 'streak_30')
}

export async function getUserStats(userId: string) {
  const [streak, achievements, totalXp] = await Promise.all([
    db.userStreak.findUnique({ where: { userId } }),
    db.userAchievement.findMany({
      where: { userId },
      include: { achievement: true },
    }),
    db.userAchievement.findMany({
      where: { userId, unlockedAt: { not: null } },
      include: { achievement: { select: { xp: true } } },
    }),
  ])

  const xp = totalXp.reduce((sum, ua) => sum + ua.achievement.xp, 0)
  const level = Math.floor(xp / 100)

  return {
    streak: streak ?? { currentStreak: 0, longestStreak: 0, totalActiveDays: 0 },
    achievements,
    xp,
    level,
  }
}
