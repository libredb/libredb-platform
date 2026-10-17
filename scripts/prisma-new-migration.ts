// `npm run db:migration -- <name>`: writes the changes of prisma/schema.prisma that no migration holds into a new
// prisma/migrations/<timestamp>_<name>/migration.sql, and applies nothing.
// It empties the shadow database first (scripts/prisma-shadow-reset.ts), because Prisma replays the migrations there and
// resets only schema platform. Raw SQL added to the file by hand names its schema, such as platform.users or bridge.query_events.
// `npm run db:migrate` applies the pending migrations.
import { execFile } from 'child_process'
import { mkdir, readdir, writeFile } from 'fs/promises'
import path from 'path'
import { promisify } from 'util'
import { resetShadowDatabase } from './prisma-shadow-reset'

const ROOT = path.resolve(__dirname, '..')
const MIGRATIONS_DIR = path.join(ROOT, 'prisma', 'migrations')
const PRISMA_CLI = path.join(ROOT, 'node_modules', '.bin', 'prisma')

const NAME_PATTERN = /^[a-z0-9]+(_[a-z0-9]+)*$/

/** The directory name Prisma gives a migration: the UTC time as YYYYMMDDHHMMSS, an underscore and the name. */
export function migrationDirName(name: string, now: Date): string {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(`invalid migration name "${name}": use lower-case words joined by underscores, such as add_audit_index`)
  }
  const timestamp = now.toISOString().replace(/\D/g, '').slice(0, 14)
  return `${timestamp}_${name}`
}

/** Refuses a name that an existing migration already carries, so two migrations never share one. */
export function assertNameUnused(name: string, existing: readonly string[]): void {
  const clash = existing.find((dir) => dir.replace(/^\d{14}_/, '') === name)
  if (clash) throw new Error(`a migration named "${name}" already exists: prisma/migrations/${clash}`)
}

async function diffScript(): Promise<string> {
  try {
    const { stdout } = await promisify(execFile)(
      PRISMA_CLI,
      ['migrate', 'diff', '--from-migrations', 'prisma/migrations', '--to-schema', 'prisma/schema.prisma', '--script'],
      { cwd: ROOT, env: { ...process.env, CHECKPOINT_DISABLE: '1' }, maxBuffer: 64 * 1024 * 1024 },
    )
    return stdout
  } catch (error) {
    const { stdout = '', stderr = '' } = error as { stdout?: string; stderr?: string }
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`prisma migrate diff failed: ${reason}\n${stdout}${stderr}`)
  }
}

async function main(): Promise<void> {
  const name = process.argv[2]
  if (!name || process.argv.length > 3) {
    throw new Error('usage: npm run db:migration -- <name>')
  }
  const shadowUrl = process.env.SHADOW_DATABASE_URL
  if (!shadowUrl) {
    throw new Error('SHADOW_DATABASE_URL is not set: it names a database libredb_owner owns, such as libredb_shadow (see .env.example).')
  }
  const dirName = migrationDirName(name, new Date())
  assertNameUnused(name, await readdir(MIGRATIONS_DIR))

  await resetShadowDatabase(shadowUrl)
  const sql = await diffScript()

  const dir = path.join(MIGRATIONS_DIR, dirName)
  await mkdir(dir)
  await writeFile(path.join(dir, 'migration.sql'), sql)
  console.log(`wrote prisma/migrations/${dirName}/migration.sql`)
}

// Runs only as the entry point, never when a test imports this module.
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
