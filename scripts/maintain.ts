// The `maintain` command (docs/deploy/platform-runtime.md): runs every scheduled task once and exits.
// Each task runs under the advisory lock the scheduler uses, so a run beside live replicas is safe:
// a task whose lock another process holds is skipped.
// Exits 1 when any task fails, and 0 when every task succeeded or was skipped.
import { db } from '@/shared/lib/db'
import { getLockPool } from '@/shared/lib/jobs/lock-pool'
import { TASKS } from '@/shared/lib/jobs/registry'
import { runTaskOnce, type RunOptions, type ScheduledTask } from '@/shared/lib/jobs/scheduler'
import { logger } from '@/shared/lib/logger'
import { readRuntimeConfig } from '@/shared/lib/runtime-config'

export interface MaintainOptions extends RunOptions {
  tasks: readonly ScheduledTask[]
}

/** Runs the tasks one after another and returns the exit code; a failed task does not stop the ones after it. */
export async function maintain({ tasks, ...options }: MaintainOptions): Promise<number> {
  const failed: string[] = []
  for (const task of tasks) {
    const outcome = await runTaskOnce(task, options)
    logger.info(`maintain: ${task.name} ${outcome.status}`, { task: task.name, status: outcome.status })
    if (outcome.status === 'failed') failed.push(task.name)
  }
  if (failed.length > 0) {
    logger.error('maintain: some tasks failed', undefined, { failed })
    return 1
  }
  return 0
}

async function main(): Promise<number> {
  // A misconfigured environment fails here, before any connection, with the same messages the server gives.
  readRuntimeConfig(process.env)
  const pool = getLockPool()
  try {
    return await maintain({ tasks: TASKS, pool })
  } finally {
    await pool.end()
    await db.$disconnect()
  }
}

// Runs only as the entry point (tsx, or the bundle in the image), never when a test imports this module.
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  main().then(
    code => { process.exitCode = code },
    error => {
      logger.error('maintain failed', error instanceof Error ? error : new Error(String(error)))
      process.exitCode = 1
    },
  )
}
