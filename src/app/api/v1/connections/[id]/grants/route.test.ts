// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NotFoundError } from '@/shared/lib/errors'

const findById = vi.hoisted(() => vi.fn())
const listForConnection = vi.hoisted(() => vi.fn())

vi.mock('@/shared/lib/bearer/with-bearer', async () => (await import('../../../../../../../tests/api/fake-bearer')).fakeBearerModule())
vi.mock('@/shared/lib/auth-utils', async () => (await import('../../../../../../../tests/api/fake-bearer')).fakeAuthUtilsModule())
vi.mock('@/shared/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('@/features/connections/lib/database-connection.repository', () => ({ DatabaseConnectionRepository: { findById } }))
vi.mock('@/features/connections/lib/grant.repository', () => ({ ConnectionGrantRepository: { listForConnection } }))

import { GET } from './route'

async function get(id: string) {
  const response = await GET(new Request(`http://localhost:3100/api/v1/connections/${id}/grants`), {
    params: Promise.resolve({ id }),
  })
  return { status: response.status, body: await response.json() }
}

beforeEach(() => {
  findById.mockReset().mockResolvedValue({ id: 'conn-orders', hasWriteCredential: true })
  listForConnection.mockReset()
})

describe('GET /api/v1/connections/{id}/grants', () => {
  it('lists the grants of the connection with the admin who last set each one', async () => {
    listForConnection.mockResolvedValue([
      {
        id: 'grant-1',
        connectionId: 'conn-orders',
        subjectKind: 'user',
        subject: 'kc-bob',
        subjectUsername: 'bob',
        subjectEmail: 'bob@libredb.test',
        level: 'write',
        expiresAt: new Date('2027-02-01T00:00:00Z'),
        grantedById: 'user-alice',
        grantedAt: new Date('2027-01-01T00:00:00Z'),
        updatedAt: new Date('2027-01-01T00:00:00Z'),
        grantedBy: { name: 'Alice', email: 'alice@libredb.test' },
      },
      {
        id: 'grant-2',
        connectionId: 'conn-orders',
        subjectKind: 'user',
        subject: 'kc-dave',
        subjectUsername: 'dave',
        subjectEmail: null,
        level: 'read',
        expiresAt: null,
        grantedById: 'user-grace',
        grantedAt: new Date('2027-01-02T00:00:00Z'),
        updatedAt: new Date('2027-01-02T00:00:00Z'),
        grantedBy: { name: null, email: 'grace@libredb.test' },
      },
    ])

    const { status, body } = await get('conn-orders')

    expect(status).toBe(200)
    expect(body).toEqual({
      grants: [
        {
          id: 'grant-1',
          subject: 'kc-bob',
          subjectUsername: 'bob',
          subjectEmail: 'bob@libredb.test',
          level: 'write',
          expiresAt: '2027-02-01T00:00:00.000Z',
          grantedBy: { id: 'user-alice', name: 'Alice', email: 'alice@libredb.test' },
          grantedAt: '2027-01-01T00:00:00.000Z',
        },
        {
          id: 'grant-2',
          subject: 'kc-dave',
          subjectUsername: 'dave',
          subjectEmail: null,
          level: 'read',
          expiresAt: null,
          grantedBy: { id: 'user-grace', name: null, email: 'grace@libredb.test' },
          grantedAt: '2027-01-02T00:00:00.000Z',
        },
      ],
    })
    expect(findById).toHaveBeenCalledWith('tenant-install', 'conn-orders')
    expect(listForConnection).toHaveBeenCalledWith('tenant-install', 'conn-orders')
  })

  it('answers 404 NOT_FOUND for a connection the install tenant does not have', async () => {
    findById.mockRejectedValue(new NotFoundError('Connection'))

    const { status, body } = await get('conn-unknown')

    expect(status).toBe(404)
    expect(body).toEqual({ error: { code: 'NOT_FOUND', message: 'Connection not found' } })
    expect(listForConnection).not.toHaveBeenCalled()
  })
})
