import type { Client } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { connectPlatform, connectSuperuser } from '../../../../../tests/db/connect'
import { createHeartbeatCleanupTask } from './heartbeat-cleanup'

// Every instance of this file has this prefix, so the cleanup after each test removes exactly them.
const INSTANCE_PREFIX = 'heartbeat-cleanup-test-'

describe('heartbeat cleanup on PostgreSQL', () => {
  let superuser: Client
  let platform: Client

  beforeAll(async () => {
    superuser = await connectSuperuser()
    platform = await connectPlatform()
  })

  afterEach(async () => {
    await superuser.query('DELETE FROM bridge.studio_instance WHERE starts_with(instance_id, $1)', [INSTANCE_PREFIX])
  })

  afterAll(async () => {
    await platform.end()
    await superuser.end()
  })

  // Rows are written as the superuser because last_seen_at is always now() through Studio's view.
  async function instanceLastSeen(name: string, interval: string): Promise<void> {
    await superuser.query(
      `INSERT INTO bridge.studio_instance (instance_id, studio_version, contract_version, listener_state, started_at, last_seen_at)
       VALUES ($1, '1.0.0', 1, 'listening', now() - interval '30 days', now() - $2::interval)`,
      [`${INSTANCE_PREFIX}${name}`, interval],
    )
  }

  it('deletes only instances unseen for 7 days', async () => {
    await instanceLastSeen('current', '0 seconds')
    await instanceLastSeen('six-days', '6 days')
    await instanceLastSeen('almost-seven-days', '6 days 23 hours 59 minutes')
    await instanceLastSeen('seven-days', '7 days 1 minute')
    await instanceLastSeen('thirty-days', '30 days')

    // The task runs as libredb_platform, which may only read and delete bridge.studio_instance.
    const task = createHeartbeatCleanupTask(async (sql, values) => (await platform.query(sql, values)).rowCount ?? 0)
    await task.run({ state: null })

    const left = await superuser.query<{ instance_id: string }>(
      'SELECT instance_id FROM bridge.studio_instance WHERE starts_with(instance_id, $1) ORDER BY instance_id',
      [INSTANCE_PREFIX],
    )
    expect(left.rows.map(row => row.instance_id)).toEqual([
      `${INSTANCE_PREFIX}almost-seven-days`,
      `${INSTANCE_PREFIX}current`,
      `${INSTANCE_PREFIX}six-days`,
    ])
  })
})
