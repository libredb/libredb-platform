import { randomUUID } from 'crypto'
import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connectPlatform, connectSuperuser } from './connect'
import { expectSqlState } from './sqlstate'

const INSUFFICIENT_PRIVILEGE = '42501'

// platform.admin_actions is append-only for the runtime role.
describe('admin action log privileges', () => {
  let superuser: Client
  let platform: Client
  let actorId: string
  let actionId: string

  beforeAll(async () => {
    superuser = await connectSuperuser()
    platform = await connectPlatform()
    actorId = `admin_actions_${randomUUID()}`
    await platform.query(
      `INSERT INTO platform.users (id, email, "updatedAt") VALUES ($1, $2, now())`,
      [actorId, `${actorId}@libredb.test`],
    )
  })

  afterAll(async () => {
    await superuser.query('DELETE FROM platform.admin_actions WHERE "actorId" = $1', [actorId])
    await superuser.query('DELETE FROM platform.users WHERE id = $1', [actorId])
    await platform.end()
    await superuser.end()
  })

  it('libredb_platform can INSERT and SELECT admin_actions', async () => {
    actionId = randomUUID()
    await platform.query(
      `INSERT INTO platform.admin_actions (id, "actorId", action, "targetType", "targetId", before, after)
       VALUES ($1, $2, 'grant.create', 'grant', 'grant-1', NULL, $3)`,
      [actionId, actorId, JSON.stringify({ level: 'read' })],
    )

    const rows = await platform.query(
      `SELECT action, "targetType", "targetId", before, after, "createdAt" FROM platform.admin_actions WHERE id = $1`,
      [actionId],
    )
    expect(rows.rows).toEqual([
      {
        action: 'grant.create',
        targetType: 'grant',
        targetId: 'grant-1',
        before: null,
        after: { level: 'read' },
        createdAt: expect.any(Date),
      },
    ])
  })

  it('libredb_platform cannot UPDATE, DELETE or TRUNCATE admin_actions (42501)', async () => {
    await expectSqlState(
      platform.query(`UPDATE platform.admin_actions SET action = 'grant.delete' WHERE id = $1`, [actionId]),
      INSUFFICIENT_PRIVILEGE,
    )
    await expectSqlState(platform.query('DELETE FROM platform.admin_actions WHERE id = $1', [actionId]), INSUFFICIENT_PRIVILEGE)
    await expectSqlState(platform.query('TRUNCATE platform.admin_actions'), INSUFFICIENT_PRIVILEGE)

    const rows = await superuser.query('SELECT action FROM platform.admin_actions WHERE id = $1', [actionId])
    expect(rows.rows).toEqual([{ action: 'grant.create' }])
  })

  it('an action outside the dotted lowercase form is refused (23514)', async () => {
    await expectSqlState(
      platform.query(
        `INSERT INTO platform.admin_actions (id, "actorId", action, "targetType", "targetId")
         VALUES ($1, $2, 'GrantCreate', 'grant', 'grant-1')`,
        [randomUUID(), actorId],
      ),
      '23514',
    )
  })
})
