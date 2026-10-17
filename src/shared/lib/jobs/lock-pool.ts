import { Pool } from 'pg'
import { logger } from '@/shared/lib/logger'
import { getRuntimeConfig } from '@/shared/lib/runtime-config'
import { TASKS } from './registry'

/**
 * A pg pool of `size` connections reserved for the scheduler's advisory locks.
 * A session-level advisory lock belongs to one connection, so each run holds a connection of its own for as long as it runs,
 * apart from Prisma's pool, which hands a query any free connection.
 */
export function createLockPool(connectionString: string, size: number): Pool {
  const pool = new Pool({
    connectionString,
    max: size,
    connectionTimeoutMillis: 5_000,
    query_timeout: 30_000,
    keepAlive: true,
    application_name: 'libredb-platform-scheduler',
  })
  // An idle connection that the server closes emits here; without a listener the process would crash.
  pool.on('error', error => logger.error('Scheduler lock connection failed', error))
  return pool
}

let pool: Pool | undefined

/**
 * The process-wide lock pool, built from the validated DATABASE_URL on first use.
 * A task never runs twice at once in one process, so one connection per registered task lets every task run at once,
 * and the pool keeps one more as headroom; it opens a connection only when a run needs one.
 */
export function getLockPool(): Pool {
  pool ??= createLockPool(getRuntimeConfig().DATABASE_URL, TASKS.length + 1)
  return pool
}
