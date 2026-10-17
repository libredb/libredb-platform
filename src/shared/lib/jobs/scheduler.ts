import { logger } from '@/shared/lib/logger'

/** The part of a pg pool client the scheduler uses: one dedicated connection that holds a task's advisory lock. */
export interface LockClient {
  query<R>(text: string, values?: unknown[]): Promise<{ rows: R[] }>
  /** Returns the connection to the pool; an error destroys it, which ends its session and drops its advisory locks. */
  release(error?: Error | boolean): void
}

/** The part of a pg pool the scheduler uses, see lock-pool.ts. */
export interface LockPool {
  connect(): Promise<LockClient>
}

export interface TaskContext {
  /** The value the task returned as `state` from its last successful run, or null. */
  state: unknown
}

export interface TaskResult {
  /** Replaces the task's stored state; a task that returns nothing keeps the stored state. */
  state: unknown
}

export interface ScheduledTask {
  /** Unique; it names the row in platform.scheduler_runs and the advisory lock `libredb:<name>`. */
  name: string
  /** The pause between the end of one run and the start of the next, before jitter. */
  intervalMs: number
  /** Each later run waits the interval plus up to this fraction of it, in place of the scheduler's jitterRatio. */
  jitterRatio?: number
  /** A thrown error fails the run; its message is stored in scheduler_runs, so it must not carry a secret. */
  run(context: TaskContext): Promise<TaskResult | void>
}

export type TaskOutcome =
  | { status: 'succeeded'; durationMs: number }
  | { status: 'skipped' }
  | { status: 'failed'; error: Error }

export interface RunOptions {
  pool: LockPool
  now?: () => Date
}

export interface SchedulerOptions extends RunOptions {
  tasks: readonly ScheduledTask[]
  /** Returns a number in [0, 1); Math.random by default. */
  random?: () => number
  /** The first run of each task starts within this many milliseconds of the start. */
  startupJitterMs?: number
  /** Each later run waits the interval plus up to this fraction of it. */
  jitterRatio?: number
}

export interface Scheduler {
  /** Cancels every pending run and waits for the runs in progress to end. */
  stop(): Promise<void>
}

const DEFAULT_STARTUP_JITTER_MS = 5_000
const DEFAULT_JITTER_RATIO = 0.1
const MAX_ERROR_LENGTH = 2_000

// Session-level, so the lock lives exactly as long as the dedicated connection holds it.
const TRY_LOCK_SQL = 'SELECT pg_try_advisory_lock(hashtext($1)) AS locked'
const UNLOCK_SQL = 'SELECT pg_advisory_unlock(hashtext($1)) AS unlocked'

const START_SQL = `INSERT INTO platform.scheduler_runs (task, "lastStartedAt") VALUES ($1, $2)
  ON CONFLICT (task) DO UPDATE SET "lastStartedAt" = EXCLUDED."lastStartedAt"
  RETURNING state`

const SUCCESS_SQL = `UPDATE platform.scheduler_runs
  SET "lastSucceededAt" = $2, "lastDurationMs" = $3, state = CASE WHEN $4::boolean THEN $5::jsonb ELSE state END
  WHERE task = $1`

const FAILURE_SQL = `UPDATE platform.scheduler_runs
  SET "lastFailedAt" = $2, "lastDurationMs" = $3, "lastError" = $4
  WHERE task = $1`

export function advisoryLockKey(task: string): string {
  return `libredb:${task}`
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

/** The error as stored in scheduler_runs: credentials in URLs are masked and the text is bounded. */
export function describeError(error: Error): string {
  const text = `${error.name}: ${error.message}`.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[REDACTED]@')
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH - 3)}...` : text
}

async function runLocked(client: LockClient, task: ScheduledTask, now: () => Date): Promise<TaskOutcome> {
  const startedAt = now()
  const started = await client.query<{ state: unknown }>(START_SQL, [task.name, startedAt])
  const state = started.rows[0]?.state ?? null

  let result: TaskResult | void = undefined
  let failure: Error | undefined
  try {
    result = await task.run({ state })
  } catch (error) {
    failure = toError(error)
  }
  const finishedAt = now()
  const durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime())

  if (failure) {
    await client.query(FAILURE_SQL, [task.name, finishedAt, durationMs, describeError(failure)])
    logger.error(`Scheduled task ${task.name} failed`, failure, { task: task.name, durationMs })
    return { status: 'failed', error: failure }
  }
  const replaceState = result !== undefined
  await client.query(SUCCESS_SQL, [task.name, finishedAt, durationMs, replaceState, JSON.stringify(result?.state ?? null)])
  logger.info(`Scheduled task ${task.name} succeeded`, { task: task.name, durationMs })
  return { status: 'succeeded', durationMs }
}

/**
 * Runs a task once under its advisory lock, on a dedicated connection from the lock pool.
 * Another holder of the lock, such as a second replica, makes this a skip that records nothing.
 * The outcome is recorded in platform.scheduler_runs, and the lock is released however the run ends.
 * Never rejects: every error becomes a failed outcome and is logged.
 */
export async function runTaskOnce(task: ScheduledTask, { pool, now = () => new Date() }: RunOptions): Promise<TaskOutcome> {
  const lockKey = advisoryLockKey(task.name)
  let client: LockClient
  try {
    client = await pool.connect()
  } catch (error) {
    const failure = toError(error)
    logger.error(`Scheduled task ${task.name} could not get a lock connection`, failure, { task: task.name })
    return { status: 'failed', error: failure }
  }

  // A connection in an unknown state is destroyed instead of returned, which also drops any lock it holds.
  let broken: Error | undefined
  try {
    const locked = await client.query<{ locked: boolean }>(TRY_LOCK_SQL, [lockKey])
    if (locked.rows[0]?.locked !== true) {
      logger.debug(`Scheduled task ${task.name} skipped: another process holds its lock`, { task: task.name })
      return { status: 'skipped' }
    }
    try {
      return await runLocked(client, task, now)
    } finally {
      try {
        const unlocked = await client.query<{ unlocked: boolean }>(UNLOCK_SQL, [lockKey])
        if (unlocked.rows[0]?.unlocked !== true) throw new Error(`advisory lock ${lockKey} was not held at release`)
      } catch (error) {
        broken = toError(error)
        logger.error(`Scheduled task ${task.name} could not release its lock`, broken, { task: task.name })
      }
    }
  } catch (error) {
    broken = toError(error)
    logger.error(`Scheduled task ${task.name} failed`, broken, { task: task.name })
    return { status: 'failed', error: broken }
  } finally {
    client.release(broken)
  }
}

function validateTasks(tasks: readonly ScheduledTask[]): void {
  const names = new Set<string>()
  for (const task of tasks) {
    if (names.has(task.name)) throw new Error(`Scheduled task ${task.name} is registered more than once`)
    names.add(task.name)
    if (!Number.isInteger(task.intervalMs) || task.intervalMs <= 0) {
      throw new Error(`Scheduled task ${task.name} needs a positive integer intervalMs`)
    }
    if (task.jitterRatio !== undefined && !(Number.isFinite(task.jitterRatio) && task.jitterRatio >= 0)) {
      throw new Error(`Scheduled task ${task.name} needs a finite jitterRatio of at least 0`)
    }
  }
}

/**
 * Runs every task on its interval with jitter until stopped.
 * The next run of a task is scheduled only when its previous run has ended, so a task never overlaps itself in one process,
 * and the advisory lock keeps it from overlapping itself across processes.
 */
export function startScheduler({
  pool,
  tasks,
  now,
  random = Math.random,
  startupJitterMs = DEFAULT_STARTUP_JITTER_MS,
  jitterRatio = DEFAULT_JITTER_RATIO,
}: SchedulerOptions): Scheduler {
  validateTasks(tasks)
  let stopped = false
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const running = new Map<string, Promise<TaskOutcome>>()

  function schedule(task: ScheduledTask, delayMs: number): void {
    const timer = setTimeout(() => void tick(task), delayMs)
    // A pending run never keeps the process alive.
    timer.unref?.()
    timers.set(task.name, timer)
  }

  async function tick(task: ScheduledTask): Promise<void> {
    timers.delete(task.name)
    if (stopped || running.has(task.name)) return
    const run = runTaskOnce(task, { pool, now })
    running.set(task.name, run)
    try {
      await run
    } finally {
      running.delete(task.name)
      const ratio = task.jitterRatio ?? jitterRatio
      if (!stopped) schedule(task, task.intervalMs + Math.floor(random() * ratio * task.intervalMs))
    }
  }

  for (const task of tasks) schedule(task, Math.floor(random() * startupJitterMs))
  logger.info('Scheduler started', { tasks: tasks.map(task => task.name) })

  return {
    async stop() {
      stopped = true
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      await Promise.allSettled(running.values())
    },
  }
}
