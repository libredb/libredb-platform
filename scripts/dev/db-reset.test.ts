import { describe, it, expect, vi } from 'vitest'
import { resetDatabase } from './db-reset.mjs'

const MIGRATE_DATABASE_URL = 'postgresql://libredb_owner:libredb_owner_dev@localhost:5432/libredb?schema=platform'

function fakeDeps() {
  const queries: string[] = []
  const client = {
    query: vi.fn(async (sql: string) => {
      queries.push(sql)
      return { rows: [] }
    }),
    end: vi.fn(async () => undefined),
  }
  const connect = vi.fn(async (_url: string) => client)
  const run = vi.fn(async (_command: string, _args: string[], _env: Record<string, string | undefined>) => undefined)
  return { queries, client, connect, run }
}

describe('resetDatabase', () => {
  it('refuses to run without ALLOW_DB_RESET=1', async () => {
    for (const env of [{ MIGRATE_DATABASE_URL }, { MIGRATE_DATABASE_URL, ALLOW_DB_RESET: 'true' }, { MIGRATE_DATABASE_URL, ALLOW_DB_RESET: '' }]) {
      const { connect, run } = fakeDeps()
      await expect(resetDatabase({ env, connect, run })).rejects.toThrow('ALLOW_DB_RESET=1')
      expect(connect).not.toHaveBeenCalled()
      expect(run).not.toHaveBeenCalled()
    }
  })

  it('refuses to run without MIGRATE_DATABASE_URL', async () => {
    const { connect, run } = fakeDeps()
    await expect(resetDatabase({ env: { ALLOW_DB_RESET: '1' }, connect, run })).rejects.toThrow('MIGRATE_DATABASE_URL')
    expect(connect).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it('drops the schemas bridge and platform and never the schema studio', async () => {
    const { queries, client, connect, run } = fakeDeps()
    const env = { ALLOW_DB_RESET: '1', MIGRATE_DATABASE_URL }

    await resetDatabase({ env, connect, run })

    expect(connect).toHaveBeenCalledWith(MIGRATE_DATABASE_URL)
    expect(queries).toEqual(['DROP SCHEMA IF EXISTS bridge CASCADE', 'DROP SCHEMA IF EXISTS platform CASCADE'])
    expect(queries.join('\n')).not.toMatch(/studio/i)
    expect(client.end).toHaveBeenCalledOnce()
    expect(run.mock.calls.map(([command, args]) => [command, ...args])).toEqual([
      ['prisma', 'migrate', 'deploy'],
      ['prisma', 'db', 'seed'],
    ])
    expect(run.mock.calls.every(([, , runEnv]) => runEnv === env)).toBe(true)
  })

  it('stops before migrating when a drop fails', async () => {
    const { client, connect, run } = fakeDeps()
    client.query.mockRejectedValueOnce(new Error('must be owner of schema bridge'))

    await expect(resetDatabase({ env: { ALLOW_DB_RESET: '1', MIGRATE_DATABASE_URL }, connect, run })).rejects.toThrow('must be owner of schema bridge')
    expect(client.end).toHaveBeenCalledOnce()
    expect(run).not.toHaveBeenCalled()
  })
})
