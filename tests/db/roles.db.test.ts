import { randomUUID } from 'crypto'
import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connectPlatform, connectStudio, connectSuperuser, connectUrl, urlFor } from './connect'
import { expectSqlState } from './sqlstate'

const INSUFFICIENT_PRIVILEGE = '42501'

function uniqueName(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

describe('database bootstrap roles', () => {
  let superuser: Client

  beforeAll(async () => {
    superuser = await connectSuperuser()
  })

  afterAll(async () => {
    await superuser.end()
  })

  it('libredb_studio owns schema studio and can create a table in it', async () => {
    const owner = await superuser.query<{ owner: string }>(
      `SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = 'studio'`,
    )
    expect(owner.rows).toEqual([{ owner: 'libredb_studio' }])

    const table = uniqueName('roles_probe')
    const studio = await connectStudio()
    try {
      await studio.query(`CREATE TABLE studio.${table} (id integer)`)
      await studio.query(`INSERT INTO studio.${table} (id) VALUES (1)`)
      const rows = await studio.query(`SELECT id FROM studio.${table}`)
      expect(rows.rows).toEqual([{ id: 1 }])
    } finally {
      await studio.query(`DROP TABLE IF EXISTS studio.${table}`)
      await studio.end()
    }
  })

  it('libredb_platform cannot create a table in schema public (42501)', async () => {
    const platform = await connectPlatform()
    try {
      await expectSqlState(platform.query(`CREATE TABLE public.${uniqueName('roles_probe')} (id integer)`), INSUFFICIENT_PRIVILEGE)
    } finally {
      await platform.end()
    }
  })

  it('libredb_platform cannot read a table in schema studio (42501)', async () => {
    const table = uniqueName('roles_probe')
    const studio = await connectStudio()
    const platform = await connectPlatform()
    try {
      await studio.query(`CREATE TABLE studio.${table} (id integer)`)
      await expectSqlState(platform.query(`SELECT * FROM studio.${table}`), INSUFFICIENT_PRIVILEGE)
    } finally {
      await platform.end()
      await studio.query(`DROP TABLE IF EXISTS studio.${table}`)
      await studio.end()
    }
  })

  it('a login role without CONNECT cannot connect to libredb (42501)', async () => {
    const role = uniqueName('roles_probe')
    const password = randomUUID()
    await superuser.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`)
    try {
      await expectSqlState(async () => {
        const client = await connectUrl(urlFor(role, password))
        await client.end()
      }, INSUFFICIENT_PRIVILEGE)
    } finally {
      await superuser.query(`DROP ROLE ${role}`)
    }
  })

  it('the connection limits are owner 5, platform 25 and studio 30', async () => {
    const result = await superuser.query<{ rolname: string; rolconnlimit: number }>(
      `SELECT rolname, rolconnlimit FROM pg_roles
        WHERE rolname IN ('libredb_owner', 'libredb_platform', 'libredb_studio')
        ORDER BY rolname`,
    )
    expect(result.rows).toEqual([
      { rolname: 'libredb_owner', rolconnlimit: 5 },
      { rolname: 'libredb_platform', rolconnlimit: 25 },
      { rolname: 'libredb_studio', rolconnlimit: 30 },
    ])
  })

  it('the role settings set search_path platform for owner and platform, search_path studio for studio, and statement_timeout 30s for studio', async () => {
    const result = await superuser.query<{ rolname: string; setconfig: string[] }>(
      `SELECT r.rolname, s.setconfig
         FROM pg_db_role_setting s
         JOIN pg_roles r ON r.oid = s.setrole
         JOIN pg_database d ON d.oid = s.setdatabase
        WHERE d.datname = 'libredb'
          AND r.rolname IN ('libredb_owner', 'libredb_platform', 'libredb_studio')`,
    )
    const settings = Object.fromEntries(result.rows.map((row) => [row.rolname, row.setconfig]))

    expect(settings.libredb_owner ?? []).toContain('search_path=platform')
    expect(settings.libredb_platform ?? []).toContain('search_path=platform')
    expect(settings.libredb_studio ?? []).toContain('search_path=studio')
    expect(settings.libredb_studio ?? []).toContain('statement_timeout=30s')
  })
})
