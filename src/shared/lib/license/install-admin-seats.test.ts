import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeAdminDirectory } from '../../../../tests/license/admin-directory'
import { answerSeatStatement, type SeatTables } from '../../../../tests/license/seat-statements'
import { KeycloakUnavailableError } from '../keycloak/errors'

// The database, the Keycloak directory and the runtime configuration of the process, which each test sets.
const serverProcess = vi.hoisted(() => ({
  queryRaw: undefined as unknown as (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>,
  directory: undefined as unknown,
  config: {} as Record<string, unknown>,
}))
vi.mock('../db', () => ({
  db: { $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => serverProcess.queryRaw(strings, ...values) },
}))
vi.mock('../keycloak/directory', () => ({ getKeycloakDirectory: () => serverProcess.directory }))
vi.mock('../runtime-config', () => ({ getRuntimeConfig: () => serverProcess.config }))

const SELF_HOSTED = { DEPLOYMENT_MODE: 'self-hosted', PLATFORM_ADMIN_ROLE: 'admin' }
const NOW = new Date('2027-01-01T08:00:00Z')

// alice is an admin in Keycloak, and carol's admin role was removed.
const TABLES: SeatTables = {
  tenant: [{ id: 'tenant-install' }],
  databaseConnection: [],
  connectionGrant: [],
  user: [
    { id: 'user-alice', keycloakId: 'kc-alice', email: 'alice@libredb.test', name: 'Alice' },
    { id: 'user-carol', keycloakId: 'kc-carol', email: 'carol@libredb.test', name: 'Carol' },
  ],
}

/**
 * The module of a new server process with this configuration, over TABLES and a directory of alice and carol, because
 * a process keeps its reading of the admin seats. The clock stands at NOW until a test moves it.
 */
async function startProcess(config: Record<string, unknown> = SELF_HOSTED) {
  const statements: string[] = []
  serverProcess.queryRaw = async (strings, ...values) => {
    statements.push(strings.join('?'))
    return answerSeatStatement(TABLES, strings, values)
  }
  const directory = fakeAdminDirectory({
    'kc-alice': { enabled: true, roles: ['admin'] },
    'kc-carol': { enabled: true, roles: ['user'] },
  })
  serverProcess.directory = directory
  serverProcess.config = config
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  vi.resetModules()
  const { getAdminSeatUsage } = await import('./install-admin-seats')
  return { getAdminSeatUsage, directory, statements }
}

function at(milliseconds: number): void {
  vi.setSystemTime(NOW.getTime() + milliseconds)
}

const USAGE = {
  seatsInUse: 1,
  identities: [
    { userId: 'user-alice', keycloakId: 'kc-alice', email: 'alice@libredb.test', name: 'Alice', state: 'admin' },
    { userId: 'user-carol', keycloakId: 'kc-carol', email: 'carol@libredb.test', name: 'Carol', state: 'role-removed' },
  ],
}

afterEach(() => {
  vi.useRealTimers()
})

describe('getAdminSeatUsage', () => {
  it('is null in cloud mode, where licensing does not apply, without reading the database or Keycloak', async () => {
    const { getAdminSeatUsage, directory, statements } = await startProcess({ DEPLOYMENT_MODE: 'cloud', PLATFORM_ADMIN_ROLE: 'admin' })

    await expect(getAdminSeatUsage()).resolves.toBeNull()
    expect(statements).toEqual([])
    expect(directory.calls).toEqual([])
  })

  it('reads every admin identity with its Keycloak state through the database and the directory of the process', async () => {
    const { getAdminSeatUsage, directory, statements } = await startProcess()

    await expect(getAdminSeatUsage()).resolves.toEqual(USAGE)
    expect(statements).toHaveLength(1)
    expect([...directory.calls].sort()).toEqual([
      'getEffectiveRoles kc-alice',
      'getEffectiveRoles kc-carol',
      'getUser kc-alice',
      'getUser kc-carol',
    ])
  })

  it('keeps a reading for 60 seconds, so Keycloak is asked again only once it is older', async () => {
    const { getAdminSeatUsage, directory, statements } = await startProcess()
    const first = await getAdminSeatUsage()

    at(59_999)
    expect(await getAdminSeatUsage()).toBe(first)
    expect(statements).toHaveLength(1)
    expect(directory.getUser).toHaveBeenCalledTimes(2)

    at(60_000)
    const second = await getAdminSeatUsage()
    expect(second).not.toBe(first)
    expect(second).toEqual(USAGE)
    expect(statements).toHaveLength(2)
    expect(directory.getUser).toHaveBeenCalledTimes(4)
  })

  it('shares one reading between reads that overlap, and forgets a reading that failed', async () => {
    const { getAdminSeatUsage, directory } = await startProcess()

    const [one, other] = await Promise.all([getAdminSeatUsage(), getAdminSeatUsage()])
    expect(other).toBe(one)
    expect(directory.getUser).toHaveBeenCalledTimes(2)

    // Keycloak cannot be read: the failure reaches the caller and is not kept, so the next read asks again.
    at(60_000)
    const unreachable = new KeycloakUnavailableError('Keycloak Admin API GET /users/{id} answered 503')
    directory.getUser.mockRejectedValueOnce(unreachable)
    await expect(getAdminSeatUsage()).rejects.toBe(unreachable)
    at(60_001)
    await expect(getAdminSeatUsage()).resolves.toEqual(USAGE)
  })
})
