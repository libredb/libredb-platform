import { describe, expect, it, vi } from 'vitest'

const queryRaw = vi.hoisted(() => vi.fn())
vi.mock('@/shared/lib/db', () => ({ db: { $queryRaw: queryRaw } }))

import { GET } from './route'

describe('GET /api/health/live', () => {
  it('answers 200 without touching the database', async () => {
    queryRaw.mockRejectedValue(new Error('connect ECONNREFUSED'))

    const response = GET()

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'live' })
    expect(queryRaw).not.toHaveBeenCalled()
  })
})
