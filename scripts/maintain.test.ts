import { describe, expect, it } from 'vitest'
import type { LockClient, LockPool, ScheduledTask } from '@/shared/lib/jobs/scheduler'
import { maintain } from './maintain'

/** A lock pool that grants every advisory lock except those held elsewhere, and accepts the statements of scheduler_runs. */
class FakeLockPool implements LockPool {
  constructor(private readonly heldElsewhere: ReadonlySet<string> = new Set()) {}

  async connect(): Promise<LockClient> {
    const heldElsewhere = this.heldElsewhere
    return {
      async query<R>(text: string, values: unknown[] = []): Promise<{ rows: R[] }> {
        if (text.includes('pg_try_advisory_lock')) return { rows: [{ locked: !heldElsewhere.has(values[0] as string) } as R] }
        if (text.includes('pg_advisory_unlock')) return { rows: [{ unlocked: true } as R] }
        if (text.includes('INSERT INTO platform.scheduler_runs')) return { rows: [{ state: null } as R] }
        if (text.includes('UPDATE platform.scheduler_runs')) return { rows: [] }
        throw new Error(`unexpected statement: ${text}`)
      },
      release() {},
    }
  }
}

function task(name: string, run: ScheduledTask['run']): ScheduledTask {
  return { name, intervalMs: 60_000, run }
}

describe('maintain', () => {
  it('exits 1 when a task fails and 0 when every task ran or was skipped', async () => {
    const ran: string[] = []
    const succeeding = task('succeeding', async () => { ran.push('succeeding') })
    const skipped = task('skipped', async () => { ran.push('skipped') })
    const failing = task('failing', async () => {
      ran.push('failing')
      throw new Error('boom')
    })
    const pool = new FakeLockPool(new Set(['libredb:skipped']))

    await expect(maintain({ tasks: [succeeding, skipped], pool })).resolves.toBe(0)
    expect(ran).toEqual(['succeeding'])

    // A failure does not stop the remaining tasks from running.
    ran.length = 0
    await expect(maintain({ tasks: [failing, succeeding, skipped], pool })).resolves.toBe(1)
    expect(ran).toEqual(['failing', 'succeeding'])
  })

  it('exits 1 when the lock connection cannot be opened', async () => {
    const pool: LockPool = { connect: async () => { throw new Error('connection refused') } }
    await expect(maintain({ tasks: [task('any', async () => {})], pool })).resolves.toBe(1)
  })
})
