import { connectSuperuser } from './connect'
import { migrate } from './migrate'

/**
 * Drops and recreates `database` on the fixture server as a fresh install: owned by libredb_owner like database libredb
 * (docker/postgres/bootstrap.psql), with schema studio, and migrated. For a test that needs a database no other test
 * file writes to, such as one that counts every tenant or user.
 */
export async function createFreshDatabase(database: string): Promise<void> {
  if (!/^[a-z_][a-z0-9_]*$/.test(database)) throw new Error(`invalid fixture database name: ${database}`)

  const server = await connectSuperuser('postgres')
  try {
    await server.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`)
    await server.query(`CREATE DATABASE ${database} OWNER libredb_owner ENCODING 'UTF8' TEMPLATE template0`)
  } finally {
    await server.end()
  }

  const client = await connectSuperuser(database)
  try {
    await client.query('REVOKE ALL ON SCHEMA public FROM PUBLIC')
    await client.query('CREATE SCHEMA studio AUTHORIZATION libredb_studio')
  } finally {
    await client.end()
  }

  await migrate(database)
}
