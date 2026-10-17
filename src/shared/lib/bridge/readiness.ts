import { readdirSync } from 'node:fs'
import path from 'node:path'
import type { PrismaClient } from '@prisma/client'
import { logger } from '@/shared/lib/logger'
import { PLATFORM_BRIDGE_CONTRACT_VERSION } from './contract'

export type Readiness =
  | { status: 'ready'; contract: typeof PLATFORM_BRIDGE_CONTRACT_VERSION }
  | { status: 'not-ready'; reason: 'db-unreachable' }
  | { status: 'not-ready'; reason: 'pending-migrations'; pending: string[] }
  | { status: 'not-ready'; reason: 'contract-missing' }

// The image keeps prisma/ next to server.js, and the working directory is the app root in the image, in dev and in tests.
const MIGRATIONS_DIR = path.join(process.cwd(), 'prisma', 'migrations')

/** The migrations this build ships: every folder under prisma/migrations, in the order Prisma applies them. */
export function localMigrations(directory: string = MIGRATIONS_DIR): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()
}

type Queryable = Pick<PrismaClient, '$queryRaw'>

/** The local migrations that platform._prisma_migrations does not list as finished and not rolled back. */
async function pendingMigrations(client: Queryable, migrations: readonly string[]): Promise<string[]> {
  // Before the first `migrate` the history table does not exist, and every migration is pending.
  const [history] = await client.$queryRaw<{ exists: boolean }[]>`
    SELECT to_regclass('platform._prisma_migrations') IS NOT NULL AS "exists"`
  if (!history.exists) return [...migrations]

  const rows = await client.$queryRaw<{ migration_name: string }[]>`
    SELECT migration_name FROM platform._prisma_migrations
    WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`
  const applied = new Set(rows.map(row => row.migration_name))
  return migrations.filter(name => !applied.has(name))
}

async function contractListed(client: Queryable): Promise<boolean> {
  const [row] = await client.$queryRaw<{ listed: boolean }[]>`
    SELECT EXISTS (SELECT FROM bridge.contract WHERE version = ${PLATFORM_BRIDGE_CONTRACT_VERSION}) AS listed`
  return row.listed
}

/**
 * Platform is ready when every local migration is applied and bridge.contract lists its version.
 * A failed query reports db-unreachable and logs the error, which the public readiness answer leaves out.
 */
export async function checkReadiness(
  client: Queryable,
  migrations: readonly string[] = localMigrations(),
): Promise<Readiness> {
  try {
    const pending = await pendingMigrations(client, migrations)
    if (pending.length > 0) return { status: 'not-ready', reason: 'pending-migrations', pending }
    if (!(await contractListed(client))) return { status: 'not-ready', reason: 'contract-missing' }
    return { status: 'ready', contract: PLATFORM_BRIDGE_CONTRACT_VERSION }
  } catch (error) {
    logger.error('Readiness check could not query the database', error instanceof Error ? error : new Error(String(error)))
    return { status: 'not-ready', reason: 'db-unreachable' }
  }
}
