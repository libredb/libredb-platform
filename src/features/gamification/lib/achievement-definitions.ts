export const ACHIEVEMENT_CATEGORIES = {
  ONBOARDING: 'ONBOARDING',
  EXPLORATION: 'EXPLORATION',
  COLLABORATION: 'COLLABORATION',
  MASTERY: 'MASTERY',
} as const

export type AchievementCategory = (typeof ACHIEVEMENT_CATEGORIES)[keyof typeof ACHIEVEMENT_CATEGORIES]

export const ACHIEVEMENTS = [
  // Onboarding
  { code: 'first_query', name: 'First Query', description: 'Execute your first query', icon: 'zap', category: 'ONBOARDING', threshold: 1, xp: 10 },
  { code: 'first_connection', name: 'Connected', description: 'Add your first DB connection', icon: 'plug', category: 'ONBOARDING', threshold: 1, xp: 10 },
  { code: 'first_shared_query', name: 'Team Player', description: 'Share a query with your team', icon: 'share-2', category: 'ONBOARDING', threshold: 1, xp: 15 },
  { code: 'explore_schema', name: 'Explorer', description: 'View schema for the first time', icon: 'compass', category: 'ONBOARDING', threshold: 1, xp: 10 },

  // Exploration
  { code: 'multi_db_types', name: 'Polyglot', description: 'Connect to 3 different DB types', icon: 'languages', category: 'EXPLORATION', threshold: 3, xp: 25 },
  { code: 'ai_adopter', name: 'AI Copilot', description: 'Use NL2SQL 10 times', icon: 'bot', category: 'EXPLORATION', threshold: 10, xp: 20 },

  // Collaboration
  { code: 'query_library', name: 'Librarian', description: 'Share 10 queries', icon: 'library', category: 'COLLABORATION', threshold: 10, xp: 30 },
  { code: 'mentor', name: 'Mentor', description: 'Invite 3 users to your tenant', icon: 'users-round', category: 'COLLABORATION', threshold: 3, xp: 25 },

  // Mastery
  { code: 'streak_7', name: 'On Fire', description: '7-day activity streak', icon: 'flame', category: 'MASTERY', threshold: 7, xp: 30 },
  { code: 'streak_30', name: 'Dedicated', description: '30-day activity streak', icon: 'trophy', category: 'MASTERY', threshold: 30, xp: 100 },
  { code: 'queries_100', name: 'Centurion', description: 'Execute 100 queries', icon: 'target', category: 'MASTERY', threshold: 100, xp: 25 },
  { code: 'queries_1000', name: 'Veteran', description: 'Execute 1000 queries', icon: 'award', category: 'MASTERY', threshold: 1000, xp: 50 },
] as const

export type AchievementCode = (typeof ACHIEVEMENTS)[number]['code']
