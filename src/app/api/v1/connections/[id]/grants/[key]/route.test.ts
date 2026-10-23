// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DirectoryUser } from '@/shared/lib/keycloak/directory'
import { KeycloakUnavailableError } from '@/shared/lib/keycloak/errors'
import { LicenseLimitError, NotFoundError } from '@/shared/lib/errors'

const findById = vi.hoisted(() => vi.fn())
const set = vi.hoisted(() => vi.fn())
const revoke = vi.hoisted(() => vi.fn())

vi.mock('@/shared/lib/bearer/with-bearer', async () => (await import('../../../../../../../../tests/api/fake-bearer')).fakeBearerModule())
vi.mock('@/shared/lib/auth-utils', async () => (await import('../../../../../../../../tests/api/fake-bearer')).fakeAuthUtilsModule())
vi.mock('@/shared/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('@/features/connections/lib/database-connection.repository', () => ({ DatabaseConnectionRepository: { findById } }))
vi.mock('@/features/connections/lib/grant.repository', () => ({ ConnectionGrantRepository: { set, revoke } }))

const directory = vi.hoisted(() => ({ getUser: vi.fn() }))
vi.mock('@/shared/lib/keycloak/directory', () => ({ getKeycloakDirectory: () => directory }))

const license = vi.hoisted(() => ({ status: null as unknown }))
vi.mock('@/shared/lib/license/install-license', () => ({ getLicenseStatus: () => license.status }))

import { SMALL_LICENSE_ACTIVE } from '../../../../../../../../tests/license/statuses'
import { DELETE, PUT } from './route'

const DAY_MS = 24 * 60 * 60 * 1000

const BOB: DirectoryUser = {
  id: 'kc-bob',
  username: 'bob',
  email: 'bob@libredb.test',
  firstName: 'Bob',
  lastName: null,
  enabled: true,
}

type Answer = { status: number; body: Record<string, unknown> & { error: { code: string; fieldErrors?: unknown } } }

async function put(body: unknown, subject = BOB.id, id = 'conn-orders'): Promise<Answer> {
  const response = await PUT(
    new Request(`http://localhost:3100/api/v1/connections/${id}/grants/${encodeURIComponent(subject)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id, key: subject }) },
  )
  return { status: response.status, body: await response.json() }
}

async function remove(grantId: string, id = 'conn-orders') {
  return DELETE(new Request(`http://localhost:3100/api/v1/connections/${id}/grants/${grantId}`, { method: 'DELETE' }), {
    params: Promise.resolve({ id, key: grantId }),
  })
}

beforeEach(() => {
  license.status = SMALL_LICENSE_ACTIVE
  findById.mockReset().mockResolvedValue({ id: 'conn-orders', hasWriteCredential: true })
  set.mockReset().mockResolvedValue({ id: 'grant-1' })
  revoke.mockReset().mockResolvedValue({ connectionId: 'conn-orders' })
  directory.getUser.mockReset().mockImplementation(async (id: string) => (id === BOB.id ? BOB : null))
})

describe('PUT /api/v1/connections/{id}/grants/{subject}', () => {
  it('creates or replaces the grant of the subject, recorded on channel api, and answers its id', async () => {
    const expiresAt = new Date(Date.now() + DAY_MS)

    const { status, body } = await put({ level: 'write', expiresAt: expiresAt.toISOString() })

    expect(status).toBe(200)
    expect(body).toEqual({ id: 'grant-1' })
    expect(set).toHaveBeenCalledWith(
      'tenant-install',
      'user-alice',
      'api',
      {
        connectionId: 'conn-orders',
        subject: 'kc-bob',
        subjectUsername: 'bob',
        subjectEmail: 'bob@libredb.test',
        level: 'write',
        expiresAt,
      },
      expect.any(Date),
      SMALL_LICENSE_ACTIVE,
    )
  })

  it('takes a null expiry for a grant that does not expire', async () => {
    const { status } = await put({ level: 'read', expiresAt: null })

    expect(status).toBe(200)
    expect(set.mock.calls[0][3]).toMatchObject({ level: 'read', expiresAt: null })
  })

  it('answers 404 NOT_FOUND for a connection the install tenant does not have', async () => {
    findById.mockRejectedValue(new NotFoundError('Connection'))

    const { status, body } = await put({ level: 'read', expiresAt: null }, BOB.id, 'conn-unknown')

    expect(status).toBe(404)
    expect(body).toEqual({ error: { code: 'NOT_FOUND', message: 'Connection not found' } })
    expect(set).not.toHaveBeenCalled()
  })

  it('refuses write on a connection without a write credential with 400 on level', async () => {
    findById.mockResolvedValue({ id: 'conn-orders', hasWriteCredential: false })

    const { status, body } = await put({ level: 'write', expiresAt: null })

    expect(status).toBe(400)
    expect(body.error).toMatchObject({ code: 'VALIDATION_FAILED', fieldErrors: { level: [expect.any(String)] } })
    expect(set).not.toHaveBeenCalled()
  })

  it('refuses a subject Keycloak does not know, or one that is disabled, with 400 on subject', async () => {
    const unknown = await put({ level: 'read', expiresAt: null }, 'kc-nobody')
    expect(unknown.status).toBe(400)
    expect(unknown.body.error).toMatchObject({
      code: 'VALIDATION_FAILED',
      fieldErrors: { subject: ['Keycloak has no user with this id'] },
    })

    directory.getUser.mockResolvedValue({ ...BOB, enabled: false })
    const disabled = await put({ level: 'read', expiresAt: null })
    expect(disabled.status).toBe(400)
    expect(disabled.body.error).toMatchObject({
      code: 'VALIDATION_FAILED',
      fieldErrors: { subject: ['bob is disabled in Keycloak'] },
    })
    expect(set).not.toHaveBeenCalled()
  })

  it('refuses an expiry that is not in the future with 400 on expiresAt', async () => {
    const { status, body } = await put({ level: 'read', expiresAt: new Date(Date.now() - 1_000).toISOString() })

    expect(status).toBe(400)
    expect(body.error).toMatchObject({ code: 'VALIDATION_FAILED', fieldErrors: { expiresAt: ['must be in the future'] } })
    expect(set).not.toHaveBeenCalled()
  })

  it('refuses a malformed body with 400 VALIDATION_FAILED', async () => {
    const wrongLevel = await put({ level: 'admin', expiresAt: null })
    expect(wrongLevel.status).toBe(400)
    expect(wrongLevel.body.error.fieldErrors).toEqual({ level: [expect.any(String)] })

    const noExpiry = await put({ level: 'read' })
    expect(noExpiry.status).toBe(400)
    expect(noExpiry.body.error.fieldErrors).toEqual({ expiresAt: [expect.any(String)] })

    // The path names the connection and the subject, so the body cannot name them again.
    const extra = await put({ level: 'read', expiresAt: null, subject: 'kc-dave' })
    expect(extra.status).toBe(400)
    expect(extra.body.error.code).toBe('VALIDATION_FAILED')

    const notJson = await put('{level')
    expect(notJson.status).toBe(400)
    expect(notJson.body.error).toMatchObject({ code: 'VALIDATION_FAILED', fieldErrors: { body: [expect.any(String)] } })

    const tooLong = await put({ level: 'read', expiresAt: null }, 'x'.repeat(513))
    expect(tooLong.status).toBe(400)
    expect(tooLong.body.error.fieldErrors).toEqual({ subject: [expect.any(String)] })

    expect(directory.getUser).not.toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()
  })

  it('answers 503 DIRECTORY_UNAVAILABLE while Keycloak does not answer', async () => {
    directory.getUser.mockRejectedValue(new KeycloakUnavailableError('Keycloak Admin API GET /users/{id} did not answer within 5 s'))

    const { status, body } = await put({ level: 'read', expiresAt: null })

    expect(status).toBe(503)
    expect(body).toEqual({ error: { code: 'DIRECTORY_UNAVAILABLE', message: 'The service is temporarily unavailable' } })
    expect(set).not.toHaveBeenCalled()
  })

  it.each(['LICENSE_USER_SEATS', 'LICENSE_EXPIRED', 'LICENSE_INVALID'] as const)(
    'answers a seat refusal of the license with 403 %s',
    async (code) => {
      set.mockRejectedValue(new LicenseLimitError(code))

      const { status, body } = await put({ level: 'read', expiresAt: null })

      expect(status).toBe(403)
      expect(body).toEqual({ error: { code, message: expect.any(String) } })
    },
  )
})

describe('DELETE /api/v1/connections/{id}/grants/{grantId}', () => {
  it('revokes the grant of the connection, recorded on channel api, and answers 204', async () => {
    const response = await remove('grant-1')

    expect(response.status).toBe(204)
    expect(await response.text()).toBe('')
    expect(revoke).toHaveBeenCalledWith('tenant-install', 'grant-1', 'user-alice', 'api', 'conn-orders')
  })

  it('answers 404 NOT_FOUND for a grant the connection does not have', async () => {
    revoke.mockRejectedValue(new NotFoundError('Grant'))

    const response = await remove('grant-unknown')

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Grant not found' } })
  })
})
