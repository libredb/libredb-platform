export interface SeedUserAchievement {
  userEmail: string
  achievementCode: string
  progress: number
  unlocked: boolean
}

export const USER_ACHIEVEMENTS: SeedUserAchievement[] = [
  // Sarah Chen: power user, has streak_7 and first_query unlocked
  { userEmail: 'sarah.chen@acme.com', achievementCode: 'first_query', progress: 1, unlocked: true },
  { userEmail: 'sarah.chen@acme.com', achievementCode: 'first_connection', progress: 1, unlocked: true },
  { userEmail: 'sarah.chen@acme.com', achievementCode: 'first_shared_query', progress: 1, unlocked: true },
  { userEmail: 'sarah.chen@acme.com', achievementCode: 'explore_schema', progress: 1, unlocked: true },
  { userEmail: 'sarah.chen@acme.com', achievementCode: 'streak_7', progress: 7, unlocked: true },
  { userEmail: 'sarah.chen@acme.com', achievementCode: 'streak_30', progress: 12, unlocked: false },
  { userEmail: 'sarah.chen@acme.com', achievementCode: 'queries_100', progress: 78, unlocked: false },
  { userEmail: 'sarah.chen@acme.com', achievementCode: 'mentor', progress: 3, unlocked: true },

  // James Wilson: heavy query user, has queries_100 unlocked
  { userEmail: 'james.wilson@acme.com', achievementCode: 'first_query', progress: 1, unlocked: true },
  { userEmail: 'james.wilson@acme.com', achievementCode: 'first_connection', progress: 1, unlocked: true },
  { userEmail: 'james.wilson@acme.com', achievementCode: 'explore_schema', progress: 1, unlocked: true },
  { userEmail: 'james.wilson@acme.com', achievementCode: 'queries_100', progress: 147, unlocked: true },
  { userEmail: 'james.wilson@acme.com', achievementCode: 'queries_1000', progress: 147, unlocked: false },
  { userEmail: 'james.wilson@acme.com', achievementCode: 'streak_7', progress: 5, unlocked: false },

  // Maria Garcia: moderate user
  { userEmail: 'maria.garcia@acme.com', achievementCode: 'first_query', progress: 1, unlocked: true },
  { userEmail: 'maria.garcia@acme.com', achievementCode: 'first_connection', progress: 1, unlocked: true },
  { userEmail: 'maria.garcia@acme.com', achievementCode: 'first_shared_query', progress: 1, unlocked: true },
  { userEmail: 'maria.garcia@acme.com', achievementCode: 'queries_100', progress: 45, unlocked: false },
  { userEmail: 'maria.garcia@acme.com', achievementCode: 'ai_adopter', progress: 6, unlocked: false },

  // Tom Reed: startup admin
  { userEmail: 'tom.reed@startuplabs.io', achievementCode: 'first_query', progress: 1, unlocked: true },
  { userEmail: 'tom.reed@startuplabs.io', achievementCode: 'first_connection', progress: 1, unlocked: true },
  { userEmail: 'tom.reed@startuplabs.io', achievementCode: 'explore_schema', progress: 1, unlocked: true },
  { userEmail: 'tom.reed@startuplabs.io', achievementCode: 'queries_100', progress: 32, unlocked: false },

  // Solo dev: just getting started
  { userEmail: 'dev@example.com', achievementCode: 'first_query', progress: 1, unlocked: true },
  { userEmail: 'dev@example.com', achievementCode: 'first_connection', progress: 1, unlocked: true },
]
