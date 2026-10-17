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
