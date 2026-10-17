import { afterEach, describe, expect, it, vi } from 'vitest'

describe('getLockPool', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('holds one connection per registered task and one more', async () => {
    vi.stubEnv('DEPLOYMENT_MODE', 'cloud')
    vi.stubEnv('DATABASE_URL', 'postgresql://libredb_platform:db-password@db.internal:5432/libredb?schema=platform')
    vi.stubEnv('AUTH_SECRET', 'auth-secret-value-of-at-least-32-characters')
    vi.resetModules()
    const { getLockPool } = await import('./lock-pool')
    const { TASKS } = await import('./registry')

    // Each run holds a connection of its own for as long as it runs, so every task can run at once.
    const pool = getLockPool()
    try {
      expect(pool.options.max).toBe(TASKS.length + 1)
      expect(getLockPool()).toBe(pool)
    } finally {
      await pool.end()
    }
  })
})
