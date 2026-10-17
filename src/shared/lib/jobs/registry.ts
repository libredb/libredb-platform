import { db } from '@/shared/lib/db'
import { getKeycloakDirectory } from '@/shared/lib/keycloak/directory'
import { getRuntimeConfig } from '@/shared/lib/runtime-config'
import type { ScheduledTask } from './scheduler'
import { createDirectorySyncTask, directorySnapshotStoreWith } from './tasks/directory-sync'
import { createHeartbeatCleanupTask } from './tasks/heartbeat-cleanup'
import { createQueryEventRetentionTask, trimQueryEventsWith } from './tasks/query-event-retention'

/**
 * Every task the scheduler runs.
 * A task slice adds its task here, with a name that stays stable because it keys platform.scheduler_runs and the advisory lock.
 */
export const TASKS: readonly ScheduledTask[] = [
  createQueryEventRetentionTask({
    trim: trimQueryEventsWith(db),
    retentionDays: () => getRuntimeConfig().QUERY_LOG_RETENTION_DAYS,
  }),
  createHeartbeatCleanupTask((sql, values) => db.$executeRawUnsafe(sql, ...values)),
  createDirectorySyncTask({
    config: getRuntimeConfig,
    directory: getKeycloakDirectory,
    store: directorySnapshotStoreWith(db),
  }),
]
