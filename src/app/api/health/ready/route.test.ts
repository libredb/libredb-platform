import { beforeEach, describe, expect, it, vi } from 'vitest'
import { localMigrations } from '@/shared/lib/bridge/readiness'

const queryRaw = vi.hoisted(() => vi.fn())
vi.mock('@/shared/lib/db', () => ({ db: { $queryRaw: queryRaw } }))

import { GET } from './route'

const MIGRATIONS = localMigrations()

interface DatabaseState {
  historyExists?: boolean
  applied?: readonly string[]
  contractListed?: boolean
  failure?: Error
}

// Answers the readiness queries by the text of each tagged template, as PostgreSQL would for `state`.
function databaseIs({ historyExists = true, applied = MIGRATIONS, contractListed = true, failure }: DatabaseState) {
  queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
    if (failure) throw failure
    const sql = strings.join('?')
    if (sql.includes('to_regclass')) return [{ exists: historyExists }]
    if (sql.includes('_prisma_migrations')) return applied.map(name => ({ migration_name: name }))
    if (sql.includes('bridge.contract')) return [{ listed: contractListed }]
    throw new Error(`unexpected query: ${sql}`)
  })
}

describe('GET /api/health/ready', () => {
  beforeEach(() => {
    queryRaw.mockReset()
  })

  it('answers 503 pending-migrations with the missing names', async () => {
    databaseIs({ applied: MIGRATIONS.slice(0, -2) })

    const response = await GET()

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      status: 'not-ready',
      reason: 'pending-migrations',
      pending: MIGRATIONS.slice(-2),
    })
  })

  it('answers 503 pending-migrations with every name on a database without a migration history', async () => {
    databaseIs({ historyExists: false })

    const response = await GET()

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ status: 'not-ready', reason: 'pending-migrations', pending: MIGRATIONS })
  })

  it('answers 503 contract-missing when bridge.contract lacks version 1', async () => {
    databaseIs({ contractListed: false })

    const response = await GET()

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ status: 'not-ready', reason: 'contract-missing' })
  })

  it('answers 503 db-unreachable when the query fails', async () => {
    databaseIs({ failure: new Error('connect ECONNREFUSED 127.0.0.1:5432') })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const response = await GET()

    expect(response.status).toBe(503)
    // The route is public, so the server's message stays in the log.
    expect(await response.json()).toEqual({ status: 'not-ready', reason: 'db-unreachable' })
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'))
    consoleError.mockRestore()
  })

  it('answers 200 when every check passes', async () => {
    databaseIs({})

    const response = await GET()

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ready', contract: 1 })
  })
})
