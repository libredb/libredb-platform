// Empties the shadow database of `prisma migrate diff --from-migrations` and `prisma migrate dev` (SHADOW_DATABASE_URL).
// Prisma resets only the schemas listed in `schemas` of prisma/schema.prisma, which is `platform`, so schema bridge and
// its functions from a previous replay survive, and the next replay of the bridge base migration fails with P3006.
// This drops every schema except public as libredb_owner, which owns the shadow database, so Prisma replays the
// migrations into an empty database.
// Run it as `npm run db:shadow-reset`; `npm run db:migration` and `npm run db:drift` run it first.
import { Client } from 'pg'

/**
 * Drops every schema of the database at `connectionString` except public and the system schemas, and returns their names.
 * Refuses a database that holds a Prisma migration history table: a shadow database never has one, so that database is a
 * real one that SHADOW_DATABASE_URL points at by mistake.
 */
export async function resetShadowDatabase(connectionString: string): Promise<string[]> {
  const client = new Client({ connectionString })
  await client.connect()
  try {
    const history = await client.query<{ name: string }>(
      `SELECT format('%I.%I', n.nspname, c.relname) AS name
       FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relname = '_prisma_migrations' AND c.relkind = 'r'`,
    )
    if (history.rows.length > 0) {
      throw new Error(
        `refusing to reset database ${client.database}: it holds the Prisma migration history ` +
          `${history.rows.map((row) => row.name).join(', ')}, so it is not a shadow database. Check SHADOW_DATABASE_URL.`,
      )
    }

    const { rows } = await client.query<{ nspname: string }>(
      `SELECT nspname FROM pg_catalog.pg_namespace
       WHERE nspname <> 'public' AND nspname <> 'information_schema' AND nspname NOT LIKE 'pg\\_%'
       ORDER BY nspname`,
    )
    const schemas = rows.map((row) => row.nspname)
    await client.query('BEGIN')
    try {
      for (const schema of schemas) {
        await client.query(`DROP SCHEMA ${client.escapeIdentifier(schema)} CASCADE`)
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    }
    return schemas
  } finally {
    await client.end()
  }
}

async function main(): Promise<void> {
  const url = process.env.SHADOW_DATABASE_URL
  if (!url) {
    throw new Error('SHADOW_DATABASE_URL is not set: it names a database libredb_owner owns, such as libredb_shadow (see .env.example).')
  }
  const dropped = await resetShadowDatabase(url)
  console.log(dropped.length > 0 ? `shadow database reset: dropped ${dropped.join(', ')}` : 'shadow database reset: already empty')
}

// Runs only as the entry point, never when a test imports this module.
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
