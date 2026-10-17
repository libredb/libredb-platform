import { Client } from 'pg'

// Fixture server started by docker-compose.test.yml. The port is read from
// TEST_POSTGRES_PORT so that parallel runs and CI can each choose one.
export const FIXTURE_HOST = process.env.TEST_POSTGRES_HOST ?? '127.0.0.1'
export const FIXTURE_PORT = Number(process.env.TEST_POSTGRES_PORT ?? '55432')
export const FIXTURE_DATABASE = 'libredb'

// Fixed development passwords, matching docker/postgres/init/01-bootstrap.sh.
export const FIXTURE_ROLES = {
  superuser: { user: 'postgres', password: 'postgres' },
  owner: { user: 'libredb_owner', password: 'libredb_owner_dev' },
  platform: { user: 'libredb_platform', password: 'libredb_platform_dev' },
  studio: { user: 'libredb_studio', password: 'libredb_studio_dev' },
} as const

export type FixtureRole = keyof typeof FIXTURE_ROLES

export function fixtureUrl(role: FixtureRole, database: string = FIXTURE_DATABASE): string {
  const { user, password } = FIXTURE_ROLES[role]
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${FIXTURE_HOST}:${FIXTURE_PORT}/${database}`
}

export function urlFor(user: string, password: string, database: string = FIXTURE_DATABASE): string {
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${FIXTURE_HOST}:${FIXTURE_PORT}/${database}`
}

export async function connectUrl(connectionString: string): Promise<Client> {
  const client = new Client({ connectionString })
  await client.connect()
  return client
}

export function connectAs(role: FixtureRole, database: string = FIXTURE_DATABASE): Promise<Client> {
  return connectUrl(fixtureUrl(role, database))
}

export const connectSuperuser = (database?: string) => connectAs('superuser', database)
export const connectOwner = (database?: string) => connectAs('owner', database)
export const connectPlatform = (database?: string) => connectAs('platform', database)
export const connectStudio = (database?: string) => connectAs('studio', database)
