import { execFile } from 'child_process'
import path from 'path'
import { promisify } from 'util'
import { describe, expect, it } from 'vitest'
import { assertNameUnused, migrationDirName } from './prisma-new-migration'

describe('migrationDirName', () => {
  it('prefixes the name with the UTC time as YYYYMMDDHHMMSS', () => {
    expect(migrationDirName('add_audit_index', new Date('2026-10-15T07:08:09.123Z'))).toBe('20261015070809_add_audit_index')
  })

  it('refuses a name that is not lower-case words joined by underscores', () => {
    for (const name of ['', 'AddIndex', 'add-index', '_add', 'add_', 'add__index', '../evil', 'add index']) {
      expect(() => migrationDirName(name, new Date())).toThrow('invalid migration name')
    }
  })
})

describe('assertNameUnused', () => {
  it('refuses a name an existing migration carries', () => {
    expect(() => assertNameUnused('identity', ['20261014224651_baseline', '20261014233621_identity'])).toThrow(
      'prisma/migrations/20261014233621_identity',
    )
  })

  it('accepts a new name, including one that only extends an existing name', () => {
    expect(() => assertNameUnused('identity_index', ['20261014233621_identity', 'migration_lock.toml'])).not.toThrow()
  })
})

describe('the Prisma CLI output the migration is written from', () => {
  it('holds only SQL, with no line printed by loading prisma.config.ts', async () => {
    const root = path.resolve(__dirname, '..')
    const { stdout } = await promisify(execFile)(
      path.join(root, 'node_modules', '.bin', 'prisma'),
      ['migrate', 'diff', '--from-empty', '--to-schema', 'prisma/schema.prisma', '--script'],
      { cwd: root, env: { ...process.env, CHECKPOINT_DISABLE: '1' }, maxBuffer: 64 * 1024 * 1024 },
    )
    expect(stdout.split('\n')[0]).toMatch(/^-- /)
    expect(stdout).not.toContain('injected env')
  }, 60_000)
})
