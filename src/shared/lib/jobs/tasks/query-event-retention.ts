import type { PrismaClient } from '@prisma/client'
import { logger } from '@/shared/lib/logger'
import type { ScheduledTask } from '../scheduler'

export const QUERY_EVENT_RETENTION_TASK = 'query-event-retention'

const INTERVAL_MS = 6 * 60 * 60 * 1000
const DEFAULT_BATCH = 10_000

/** Deletes at most `batch` query events older than `retentionDays`, oldest first, and returns how many it deleted. */
export type TrimQueryEvents = (retentionDays: number, batch: number) => Promise<number>

/**
 * Calls bridge.trim_query_events (Studio's GOVERNANCE.md), which Platform's runtime role may only execute.
 * The function never deletes an event younger than 7 days, whatever the retention.
 */
export function trimQueryEventsWith(client: Pick<PrismaClient, '$queryRaw'>): TrimQueryEvents {
  return async (retentionDays, batch) => {
    const rows = await client.$queryRaw<Array<{ deleted: number }>>`
      SELECT bridge.trim_query_events(${retentionDays}::integer, ${batch}::integer)::integer AS deleted`
    const deleted = rows[0]?.deleted
    if (typeof deleted !== 'number') throw new Error('bridge.trim_query_events returned no row count')
    return deleted
  }
}

export interface QueryEventRetentionOptions {
  trim: TrimQueryEvents
  /** Read at each run, so the task follows the validated QUERY_LOG_RETENTION_DAYS. */
  retentionDays: () => number
  batch?: number
}

/**
 * Query event retention: every 6 hours, trims expired events in batches until a call returns fewer rows than the batch.
 * Each call is its own short transaction, so a large backlog never holds one long lock on bridge.query_event.
 */
export function createQueryEventRetentionTask({
  trim,
  retentionDays,
  batch = DEFAULT_BATCH,
}: QueryEventRetentionOptions): ScheduledTask {
  if (!Number.isInteger(batch) || batch <= 0) throw new Error('The query event retention batch must be a positive integer')
  return {
    name: QUERY_EVENT_RETENTION_TASK,
    intervalMs: INTERVAL_MS,
    async run() {
      const days = retentionDays()
      let deleted = 0
      let calls = 0
      for (;;) {
        const count = await trim(days, batch)
        deleted += count
        calls += 1
        if (count < batch) break
      }
      logger.info('Query event retention trimmed expired events', { retentionDays: days, deleted, calls })
    },
  }
}
