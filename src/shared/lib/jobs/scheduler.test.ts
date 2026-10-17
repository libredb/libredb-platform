import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runTaskOnce, startScheduler, type LockClient, type LockPool, type ScheduledTask } from './scheduler'

interface RunRow {
  lastStartedAt: Date | null
  lastSucceededAt: Date | null
  lastFailedAt: Date | null
  lastError: string | null
  lastDurationMs: number | null
  state: unknown
}

/**
 * An in-memory stand-in for the lock pool: session-level advisory locks keyed by the text passed to hashtext(),
 * and the rows of platform.scheduler_runs. It answers the statements of scheduler.ts by their shape.
 */
class FakeLockDatabase implements LockPool {
  readonly heldBy = new Map<string, FakeClient>()
  readonly runs = new Map<string, RunRow>()
  readonly released: Array<{ client: FakeClient; error: Error | boolean | undefined }> = []

  async connect(): Promise<LockClient> {
    return new FakeClient(this)
  }

  holdElsewhere(key: string): void {
    this.heldBy.set(key, new FakeClient(this))
  }
}

class FakeClient implements LockClient {
  constructor(private readonly database: FakeLockDatabase) {}

  async query<R>(text: string, values: unknown[] = []): Promise<{ rows: R[] }> {
    const db = this.database
    if (text.includes('pg_try_advisory_lock')) {
      const key = values[0] as string
      const holder = db.heldBy.get(key)
      if (holder && holder !== this) return { rows: [{ locked: false } as R] }
      db.heldBy.set(key, this)
      return { rows: [{ locked: true } as R] }
    }
    if (text.includes('pg_advisory_unlock')) {
      const key = values[0] as string
      const unlocked = db.heldBy.get(key) === this
      if (unlocked) db.heldBy.delete(key)
      return { rows: [{ unlocked } as R] }
    }
    if (text.includes('INSERT INTO platform.scheduler_runs')) {
      const [task, startedAt] = values as [string, Date]
      const row = db.runs.get(task) ?? {
        lastStartedAt: null, lastSucceededAt: null, lastFailedAt: null, lastError: null, lastDurationMs: null, state: null,
      }
      row.lastStartedAt = startedAt
      db.runs.set(task, row)
      return { rows: [{ state: row.state } as R] }
    }
    if (text.includes('"lastSucceededAt" = $2')) {
      const [task, at, durationMs, replaceState, state] = values as [string, Date, number, boolean, string]
      const row = db.runs.get(task)!
      Object.assign(row, { lastSucceededAt: at, lastDurationMs: durationMs })
      if (replaceState) row.state = JSON.parse(state)
      return { rows: [] }
    }
    if (text.includes('"lastFailedAt" = $2')) {
      const [task, at, durationMs, error] = values as [string, Date, number, string]
      Object.assign(db.runs.get(task)!, { lastFailedAt: at, lastDurationMs: durationMs, lastError: error })
      return { rows: [] }
    }
    throw new Error(`unexpected statement: ${text}`)
  }

  release(error?: Error | boolean): void {
    this.database.released.push({ client: this, error })
    // A destroyed connection ends its session, which drops every advisory lock it holds.
    if (error) {
      for (const [key, holder] of this.database.heldBy) if (holder === this) this.database.heldBy.delete(key)
    }
  }
}

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

const MINUTE = 60_000

describe('scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'debug').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('skips a run when the advisory lock is held', async () => {
    const database = new FakeLockDatabase()
    database.holdElsewhere('libredb:directory-sync')
    const run = vi.fn(async () => {})
    const scheduler = startScheduler({
      pool: database,
      tasks: [{ name: 'directory-sync', intervalMs: MINUTE, run }],
      random: () => 0,
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(run).not.toHaveBeenCalled()
    expect(database.runs.has('directory-sync')).toBe(false)
    // The connection went back to the pool and the other holder still has the lock.
    expect(database.released).toHaveLength(1)
    expect(database.heldBy.has('libredb:directory-sync')).toBe(true)

    // Once the other holder lets go, the next tick runs the task.
    database.heldBy.delete('libredb:directory-sync')
    await vi.advanceTimersByTimeAsync(MINUTE)
    expect(run).toHaveBeenCalledTimes(1)
    expect(database.heldBy.has('libredb:directory-sync')).toBe(false)

    await scheduler.stop()
  })

  it('never starts a task while its previous run is still going', async () => {
    const database = new FakeLockDatabase()
    const firstRun = deferred()
    const run = vi.fn()
      .mockImplementationOnce(() => firstRun.promise)
      .mockImplementation(async () => {})
    const scheduler = startScheduler({
      pool: database,
      tasks: [{ name: 'slow', intervalMs: MINUTE, run }],
      random: () => 0,
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(1)

    // Ten intervals pass while the first run is still going.
    await vi.advanceTimersByTimeAsync(10 * MINUTE)
    expect(run).toHaveBeenCalledTimes(1)

    // The next run starts one interval after the first one ends.
    firstRun.resolve()
    await vi.advanceTimersByTimeAsync(MINUTE - 1)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(2)

    await scheduler.stop()
  })

  it('records success and failure and releases the lock after a throw', async () => {
    const database = new FakeLockDatabase()
    const clock = [new Date('2026-10-15T10:00:00.000Z'), new Date('2026-10-15T10:00:01.250Z')]
    const now = () => clock.shift()!

    const succeeding: ScheduledTask = {
      name: 'retention',
      intervalMs: MINUTE,
      run: async ({ state }) => ({ state: { previous: state, cursor: 7 } }),
    }
    await expect(runTaskOnce(succeeding, { pool: database, now })).resolves.toEqual({ status: 'succeeded', durationMs: 1250 })
    expect(database.runs.get('retention')).toEqual({
      lastStartedAt: new Date('2026-10-15T10:00:00.000Z'),
      lastSucceededAt: new Date('2026-10-15T10:00:01.250Z'),
      lastFailedAt: null,
      lastError: null,
      lastDurationMs: 1250,
      state: { previous: null, cursor: 7 },
    })
    expect(database.heldBy.size).toBe(0)

    clock.push(new Date('2026-10-15T11:00:00.000Z'), new Date('2026-10-15T11:00:00.500Z'))
    const failing: ScheduledTask = {
      name: 'retention',
      intervalMs: MINUTE,
      run: async ({ state }) => {
        expect(state).toEqual({ previous: null, cursor: 7 })
        throw new Error('connect to postgresql://libredb_platform:s3cret-password@db.internal/libredb failed')
      },
    }
    const outcome = await runTaskOnce(failing, { pool: database, now })
    expect(outcome.status).toBe('failed')

    const row = database.runs.get('retention')!
    expect(row.lastSucceededAt).toEqual(new Date('2026-10-15T10:00:01.250Z'))
    expect(row.lastFailedAt).toEqual(new Date('2026-10-15T11:00:00.500Z'))
    expect(row.lastDurationMs).toBe(500)
    expect(row.lastError).toContain('failed')
    expect(row.lastError).not.toContain('s3cret-password')
    expect(row.state).toEqual({ previous: null, cursor: 7 })

    // The lock is released and the connection returned after the throw, so the next run can take it.
    expect(database.heldBy.size).toBe(0)
    expect(database.released).toHaveLength(2)
    const again = await runTaskOnce({ name: 'retention', intervalMs: MINUTE, run: async () => {} }, { pool: database })
    expect(again.status).toBe('succeeded')
  })

  it('rejects duplicate task names and intervals that are not positive integers', () => {
    const run = async () => {}
    const database = new FakeLockDatabase()
    expect(() => startScheduler({ pool: database, tasks: [{ name: 'a', intervalMs: 1, run }, { name: 'a', intervalMs: 1, run }] }))
      .toThrow(/a.*more than once/)
    expect(() => startScheduler({ pool: database, tasks: [{ name: 'b', intervalMs: 0, run }] })).toThrow(/intervalMs/)
  })

  it("a task's own jitterRatio replaces the scheduler's", async () => {
    const database = new FakeLockDatabase()
    const exact = vi.fn(async () => {})
    const jittered = vi.fn(async () => {})
    const scheduler = startScheduler({
      pool: database,
      tasks: [
        { name: 'exact', intervalMs: MINUTE, jitterRatio: 0, run: exact },
        { name: 'jittered', intervalMs: MINUTE, run: jittered },
      ],
      // The largest draw: the scheduler's jitter of 10% adds 5940 ms to each interval of a minute.
      random: () => 0.99,
      startupJitterMs: 0,
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(exact).toHaveBeenCalledTimes(1)
    expect(jittered).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(MINUTE)
    expect(exact).toHaveBeenCalledTimes(2)
    expect(jittered).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5_940)
    expect(jittered).toHaveBeenCalledTimes(2)

    await scheduler.stop()

    for (const jitterRatio of [-0.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => startScheduler({ pool: database, tasks: [{ name: 'c', intervalMs: 1, jitterRatio, run: exact }] }))
        .toThrow(/jitterRatio/)
    }
  })
})
