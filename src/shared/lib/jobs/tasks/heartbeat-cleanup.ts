import { logger } from '@/shared/lib/logger'
import type { ScheduledTask } from '../scheduler'

/** Runs a parameterised statement and returns the number of rows it affected. */
export type ExecuteSql = (sql: string, values: unknown[]) => Promise<number>

export const HEARTBEAT_CLEANUP_TASK = 'heartbeat-cleanup'

/** An instance whose heartbeat is older than this is gone; every beat advances last_seen_at (Studio's GOVERNANCE.md). */
export const HEARTBEAT_RETENTION_DAYS = 7

const DAY_MS = 24 * 60 * 60 * 1000

// The database clock decides, because Studio's beats write last_seen_at with now().
const DELETE_UNSEEN_SQL = `DELETE FROM bridge.studio_instance
  WHERE last_seen_at < now() - make_interval(days => $1::integer)`

/** Deletes the bridge.studio_instance rows of Studio instances unseen for 7 days, once a day. */
export function createHeartbeatCleanupTask(execute: ExecuteSql): ScheduledTask {
  return {
    name: HEARTBEAT_CLEANUP_TASK,
    intervalMs: DAY_MS,
    async run() {
      const deleted = await execute(DELETE_UNSEEN_SQL, [HEARTBEAT_RETENTION_DAYS])
      logger.info('Heartbeat cleanup deleted unseen Studio instances', { deleted, retentionDays: HEARTBEAT_RETENTION_DAYS })
    },
  }
}
