// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DirectoryUser } from '@/shared/lib/keycloak/directory'
import { KeycloakUnavailableError } from '@/shared/lib/keycloak/errors'

vi.mock('@/shared/lib/bearer/with-bearer', async () => (await import('../../../../../../tests/api/fake-bearer')).fakeBearerModule())
vi.mock('@/shared/lib/auth-utils', async () => (await import('../../../../../../tests/api/fake-bearer')).fakeAuthUtilsModule())
vi.mock('@/shared/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('@/shared/lib/runtime-config', () => ({
  getRuntimeConfig: () => ({ PLATFORM_ADMIN_ROLE: 'admin', STUDIO_USER_ROLE: 'user' }),
}))

const directory = vi.hoisted(() => ({ searchUsers: vi.fn(), countUsers: vi.fn(), getEffectiveRoles: vi.fn() }))
vi.mock('@/shared/lib/keycloak/directory', () => ({ getKeycloakDirectory: () => directory }))

const license = vi.hoisted(() => ({ status: null as unknown }))
vi.mock('@/shared/lib/license/install-license', () => ({ getLicenseStatus: () => license.status }))
const userSeatHolders = vi.hoisted(() => vi.fn())
vi.mock('@/features/connections/lib/grant.repository', () => ({ ConnectionGrantRepository: { userSeatHolders } }))

import { SMALL_LICENSE_ACTIVE } from '../../../../../../tests/license/statuses'
import { GET } from './route'

const BOB: DirectoryUser = {
  id: 'kc-bob',
  username: 'bob',
  email: 'bob@libredb.test',
  firstName: 'Bob',
  lastName: null,
  enabled: true,
}
const FRANK: DirectoryUser = { ...BOB, id: 'kc-frank', username: 'frank', email: null, enabled: false }

async function get(query: string) {
  const response = await GET(new Request(`http://localhost:3100/api/v1/directory/users${query}`), {
    params: Promise.resolve({}),
  })
  return { status: response.status, body: await response.json() }
}

beforeEach(() => {
  license.status = SMALL_LICENSE_ACTIVE
  directory.searchUsers.mockReset().mockResolvedValue([BOB, FRANK])
  directory.countUsers.mockReset().mockResolvedValue(42)
  directory.getEffectiveRoles.mockReset().mockImplementation(async (id: string) => (id === BOB.id ? ['user'] : []))
  userSeatHolders.mockReset().mockResolvedValue(new Set([BOB.id]))
})

describe('GET /api/v1/directory/users', () => {
  it('answers the page of searchDirectoryUsers, with the Studio role, enabled flag and seat mark of each user', async () => {
    const { status, body } = await get('?q=b&page=2')

    expect(status).toBe(200)
    expect(body).toEqual({
      users: [
        { ...BOB, studioRole: 'user', needsSeat: false },
        { ...FRANK, studioRole: null, needsSeat: true },
      ],
      page: 2,
      total: 42,
    })
    expect(directory.searchUsers).toHaveBeenCalledWith({ search: '*b*', first: 20, max: 20 })
    expect(directory.countUsers).toHaveBeenCalledWith('*b*')
  })

  it('lists the first page of every user without a query', async () => {
    const { status, body } = await get('')

    expect(status).toBe(200)
    expect(body).toMatchObject({ page: 1, total: 42 })
    expect(directory.searchUsers).toHaveBeenCalledWith({ search: undefined, first: 0, max: 20 })
  })

  it.each(['0', 'two', '1.5', ''])('refuses page=%s with 400 VALIDATION_FAILED on page', async (page) => {
    const { status, body } = await get(`?page=${page}`)

    expect(status).toBe(400)
    expect(body).toEqual({
      error: { code: 'VALIDATION_FAILED', message: 'Validation failed', fieldErrors: { page: [expect.any(String)] } },
    })
    expect(directory.searchUsers).not.toHaveBeenCalled()
  })

  it('refuses a query longer than 255 characters with 400 VALIDATION_FAILED on q', async () => {
    const { status, body } = await get(`?q=${'x'.repeat(256)}`)

    expect(status).toBe(400)
    expect(body.error.fieldErrors).toEqual({ q: [expect.any(String)] })
  })

  it('answers 503 DIRECTORY_UNAVAILABLE while Keycloak does not answer', async () => {
    directory.countUsers.mockRejectedValue(new KeycloakUnavailableError('Keycloak Admin API GET /users/count did not answer within 5 s'))

    const { status, body } = await get('?q=b')

    expect(status).toBe(503)
    expect(body).toEqual({ error: { code: 'DIRECTORY_UNAVAILABLE', message: 'The service is temporarily unavailable' } })
  })
})
