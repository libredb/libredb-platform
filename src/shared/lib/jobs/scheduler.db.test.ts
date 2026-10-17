import { randomUUID } from 'crypto'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connectSuperuser, fixtureUrl } from '../../../../tests/db/connect'
import { createLockPool } from './lock-pool'
import { runTaskOnce, type ScheduledTask } from './scheduler'

// Two Platform replicas: each has its own lock pool, built from a DATABASE_URL as the runtime role sees it.
describe('scheduler on PostgreSQL', () => {
  let first: Pool
  let second: Pool

  beforeAll(() => {
    const databaseUrl = `${fixtureUrl('platform')}?schema=platform`
    first = createLockPool(databaseUrl, 2)
    second = createLockPool(databaseUrl, 2)
  })

  afterAll(async () => {
    await first.end()
    await second.end()
  })

  it('two schedulers on one database run a task once per tick', async () => {
    const name = `probe-${randomUUID()}`
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    let runs = 0
    const task: ScheduledTask = {
      name,
      intervalMs: 60_000,
      run: async () => {
        runs += 1
        await blocked
        return { state: { runs } }
      },
    }

    // Both replicas reach the same tick; the one that loses the advisory lock skips while the other runs.
    const firstRun = runTaskOnce(task, { pool: first })
    await expect.poll(() => runs).toBe(1)
    await expect(runTaskOnce(task, { pool: second })).resolves.toEqual({ status: 'skipped' })
    release()
    await expect(firstRun).resolves.toMatchObject({ status: 'succeeded' })
    expect(runs).toBe(1)

    const superuser = await connectSuperuser()
    try {
      const recorded = await superuser.query(
        `SELECT "lastStartedAt" IS NOT NULL AS started, "lastSucceededAt" IS NOT NULL AS succeeded,
                "lastFailedAt" IS NULL AS never_failed, "lastDurationMs" >= 0 AS timed, state
           FROM platform.scheduler_runs WHERE task = $1`,
        [name],
      )
      expect(recorded.rows).toEqual([{ started: true, succeeded: true, never_failed: true, timed: true, state: { runs: 1 } }])

      // The winner released the advisory lock, so no session holds it any more.
      const held = await superuser.query(
        `SELECT count(*)::int AS held FROM pg_locks
          WHERE locktype = 'advisory' AND objid = hashtext($1)::oid AND objsubid = 1`,
        [`libredb:${name}`],
      )
      expect(held.rows).toEqual([{ held: 0 }])

      // The next tick runs on whichever replica gets there.
      await expect(runTaskOnce(task, { pool: second })).resolves.toMatchObject({ status: 'succeeded' })
      expect(runs).toBe(2)
    } finally {
      await superuser.query('DELETE FROM platform.scheduler_runs WHERE task = $1', [name])
      await superuser.end()
    }
  })
})
