import { execFile } from 'child_process'
import path from 'path'
import { promisify } from 'util'
import { fixtureUrl, FIXTURE_DATABASE } from './connect'

const ROOT = path.resolve(__dirname, '..', '..')
const PRISMA_CLI = path.join(ROOT, 'node_modules', '.bin', 'prisma')

// Applies prisma/migrations as libredb_owner, the only role with DDL in schema
// platform, through MIGRATE_DATABASE_URL in Prisma syntax, as the migrate job
// does. A database that is already migrated is left unchanged.
export async function migrate(database: string = FIXTURE_DATABASE): Promise<void> {
  try {
    await promisify(execFile)(PRISMA_CLI, ['migrate', 'deploy'], {
      cwd: ROOT,
      env: { ...process.env, MIGRATE_DATABASE_URL: `${fixtureUrl('owner', database)}?schema=platform`, CHECKPOINT_DISABLE: '1' },
    })
  } catch (error) {
    const { stdout = '', stderr = '' } = error as { stdout?: string; stderr?: string }
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`prisma migrate deploy of ${database} as libredb_owner failed: ${reason}\n${stdout}${stderr}`)
  }
}
