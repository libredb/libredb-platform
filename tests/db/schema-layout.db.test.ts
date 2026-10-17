import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connectPlatform, connectStudio, connectSuperuser } from './connect'
import { expectSqlState } from './sqlstate'

const INSUFFICIENT_PRIVILEGE = '42501'
const DML = ['DELETE', 'INSERT', 'SELECT', 'UPDATE']

// The table of every model in prisma/schema.prisma.
const MODEL_TABLES = Prisma.dmmf.datamodel.models.map((model) => model.dbName ?? model.name).sort()

function uniqueName(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

// Applied by tests/db/global-setup.ts, which runs `prisma migrate deploy` as libredb_owner.
describe('platform schema layout and privileges', () => {
  let superuser: Client

  beforeAll(async () => {
    superuser = await connectSuperuser()
  })

  afterAll(async () => {
    await superuser.end()
  })

  it('every Prisma model table is in schema platform and schema public holds none', async () => {
    expect(MODEL_TABLES.length).toBeGreaterThan(0)

    const platformTables = await superuser.query<{ name: string }>(
      `SELECT relname AS name FROM pg_class
        WHERE relnamespace = 'platform'::regnamespace AND relkind IN ('r', 'p')`,
    )
    const inPlatform = new Set(platformTables.rows.map((row) => row.name))
    expect(MODEL_TABLES.filter((table) => !inPlatform.has(table))).toEqual([])

    const inPublic = await superuser.query<{ kind: string; name: string }>(
      `SELECT 'relation' AS kind, relname AS name FROM pg_class WHERE relnamespace = 'public'::regnamespace
       UNION ALL
       SELECT 'type', typname FROM pg_type WHERE typnamespace = 'public'::regnamespace
       ORDER BY 1, 2`,
    )
    expect(inPublic.rows).toEqual([])
  })

  it('schema platform holds no legacy_database_connections, connection_permissions or DatabaseType', async () => {
    const legacy = await superuser.query<{ legacy_table: boolean; permissions_table: boolean; database_type: boolean }>(
      `SELECT to_regclass('platform.legacy_database_connections') IS NOT NULL AS legacy_table,
              to_regclass('platform.connection_permissions') IS NOT NULL AS permissions_table,
              to_regtype('platform."DatabaseType"') IS NOT NULL AS database_type`,
    )
    expect(legacy.rows).toEqual([{ legacy_table: false, permissions_table: false, database_type: false }])
  })

  it('_prisma_migrations is platform._prisma_migrations and libredb_platform can read it', async () => {
    const location = await superuser.query<{ in_platform: boolean; in_public: boolean }>(
      `SELECT to_regclass('platform._prisma_migrations') IS NOT NULL AS in_platform,
              to_regclass('public._prisma_migrations') IS NOT NULL AS in_public`,
    )
    expect(location.rows).toEqual([{ in_platform: true, in_public: false }])

    const platform = await connectPlatform()
    try {
      const applied = await platform.query<{ migration_name: string; finished_at: Date | null }>(
        `SELECT migration_name, finished_at FROM platform._prisma_migrations WHERE rolled_back_at IS NULL`,
      )
      expect(applied.rows.length).toBeGreaterThan(0)
      expect(applied.rows.filter((row) => row.finished_at === null)).toEqual([])

      // Readiness reads the history; only the owner writes it.
      const writable = await platform.query<{ privilege: string; granted: boolean }>(
        `SELECT privilege, has_table_privilege('platform._prisma_migrations', privilege) AS granted
           FROM unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) AS privilege`,
      )
      expect(writable.rows.filter((row) => row.granted)).toEqual([])
    } finally {
      await platform.end()
    }
  })

  it('libredb_platform has SELECT, INSERT, UPDATE and DELETE on every platform table through default privileges, except the append-only admin_actions and the read-only studio_setting_keys', async () => {
    const defaults = await superuser.query<{ objtype: string; privilege: string }>(
      `SELECT d.defaclobjtype::text AS objtype, a.privilege_type AS privilege
         FROM pg_default_acl d
         CROSS JOIN LATERAL aclexplode(d.defaclacl) a
        WHERE d.defaclrole = 'libredb_owner'::regrole
          AND d.defaclnamespace = 'platform'::regnamespace
          AND a.grantee = 'libredb_platform'::regrole
        ORDER BY d.defaclobjtype::text COLLATE "C", a.privilege_type COLLATE "C"`,
    )
    expect(defaults.rows).toEqual([
      { objtype: 'S', privilege: 'SELECT' },
      { objtype: 'S', privilege: 'USAGE' },
      ...DML.map((privilege) => ({ objtype: 'r', privilege })),
    ])

    const tables = await superuser.query<{ name: string; privileges: string[] }>(
      `SELECT c.relname AS name,
              coalesce(array_agg(a.privilege_type ORDER BY a.privilege_type COLLATE "C")
                         FILTER (WHERE a.grantee = 'libredb_platform'::regrole), '{}') AS privileges
         FROM pg_class c
         LEFT JOIN LATERAL aclexplode(c.relacl) a ON true
        WHERE c.relnamespace = 'platform'::regnamespace
          AND c.relkind IN ('r', 'p')
          AND c.relname <> '_prisma_migrations'
        GROUP BY c.relname
        ORDER BY c.relname`,
    )
    expect(tables.rows.map((row) => row.name)).toEqual(expect.arrayContaining(MODEL_TABLES))
    // admin_actions is append-only, and the allowlist rows of studio_setting_keys come only from migrations.
    const RESTRICTED: Record<string, string[]> = { admin_actions: ['INSERT', 'SELECT'], studio_setting_keys: ['SELECT'] }
    const restricted = tables.rows.filter((row) => row.name in RESTRICTED)
    expect(restricted).toEqual(Object.entries(RESTRICTED).map(([name, privileges]) => ({ name, privileges })))
    expect(tables.rows.filter((row) => !(row.name in RESTRICTED) && row.privileges.join() !== DML.join())).toEqual([])
  })

  it('functions created by libredb_owner are not executable by PUBLIC by default', async () => {
    const defaults = await superuser.query<{ grantee: string; privilege: string }>(
      `SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee,
              a.privilege_type AS privilege
         FROM pg_default_acl d
         CROSS JOIN LATERAL aclexplode(d.defaclacl) a
        WHERE d.defaclrole = 'libredb_owner'::regrole
          AND d.defaclnamespace = 0
          AND d.defaclobjtype = 'f'`,
    )
    expect(defaults.rows).toEqual([{ grantee: 'libredb_owner', privilege: 'EXECUTE' }])
  })

  it('libredb_platform cannot create a table in schema platform (42501)', async () => {
    const platform = await connectPlatform()
    try {
      await expectSqlState(platform.query(`CREATE TABLE platform.${uniqueName('layout_probe')} (id integer)`), INSUFFICIENT_PRIVILEGE)
    } finally {
      await platform.end()
    }
  })

  it('libredb_studio cannot read platform.users (42501)', async () => {
    const studio = await connectStudio()
    try {
      await expectSqlState(studio.query('SELECT id FROM platform.users LIMIT 1'), INSUFFICIENT_PRIVILEGE)
    } finally {
      await studio.end()
    }
  })

  it('support_tickets.searchVector is a generated column', async () => {
    const column = await superuser.query<{ is_generated: string; data_type: string }>(
      `SELECT is_generated, data_type FROM information_schema.columns
        WHERE table_schema = 'platform' AND table_name = 'support_tickets' AND column_name = 'searchVector'`,
    )
    expect(column.rows).toEqual([{ is_generated: 'ALWAYS', data_type: 'tsvector' }])

    const sources = await superuser.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.column_column_usage
        WHERE table_schema = 'platform' AND table_name = 'support_tickets' AND dependent_column = 'searchVector'
        ORDER BY column_name COLLATE "C"`,
    )
    expect(sources.rows).toEqual([{ column_name: 'descriptionPlain' }, { column_name: 'subject' }])
  })

  it('support_messages.searchVector is a generated column', async () => {
    const column = await superuser.query<{ is_generated: string; data_type: string }>(
      `SELECT is_generated, data_type FROM information_schema.columns
        WHERE table_schema = 'platform' AND table_name = 'support_messages' AND column_name = 'searchVector'`,
    )
    expect(column.rows).toEqual([{ is_generated: 'ALWAYS', data_type: 'tsvector' }])

    const sources = await superuser.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.column_column_usage
        WHERE table_schema = 'platform' AND table_name = 'support_messages' AND dependent_column = 'searchVector'`,
    )
    expect(sources.rows).toEqual([{ column_name: 'bodyPlain' }])
  })
})
