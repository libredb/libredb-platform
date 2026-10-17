import { afterEach, describe, expect, it, vi } from 'vitest'

const VALID_ENV = {
  DEPLOYMENT_MODE: 'self-hosted',
  DATABASE_URL: 'postgresql://libredb_platform:db-password@db.internal:5432/libredb?schema=platform',
  AUTH_SECRET: 'auth-secret-value-of-at-least-32-characters',
  STUDIO_PUBLIC_URL: 'https://studio.example.test',
  AUTH_KEYCLOAK_ISSUER: 'https://auth.example.test/realms/libredb',
  AUTH_KEYCLOAK_ID: 'libredb-platform',
  AUTH_KEYCLOAK_SECRET: 'keycloak-client-secret-value',
  BRIDGE_SEAL_PUBLIC_KEY: 'b6-f045B6re3Ue7V8Cr5jO9ApZzyOxGk659gM3tn5wE',
}

async function loadRegistry(env: Record<string, string | undefined>) {
  for (const [name, value] of Object.entries({ ...VALID_ENV, DIRECTORY_SYNC_INTERVAL_SEC: undefined, ...env })) {
    vi.stubEnv(name, value)
  }
  vi.resetModules()
  return import('./registry')
}

describe('TASKS', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('registers directory sync, which reads DIRECTORY_SYNC_INTERVAL_SEC when the scheduler starts', async () => {
    const { TASKS } = await loadRegistry({})
    expect(TASKS.map(task => task.name)).toEqual(['query-event-retention', 'heartbeat-cleanup', 'directory-sync'])
    expect(TASKS.find(task => task.name === 'directory-sync')!.intervalMs).toBe(60_000)

    const custom = await loadRegistry({ DIRECTORY_SYNC_INTERVAL_SEC: '45' })
    expect(custom.TASKS.find(task => task.name === 'directory-sync')!.intervalMs).toBe(45_000)

    // Loading the registry reads no configuration, so register() reports an invalid one with every other variable.
    const invalid = await loadRegistry({ DIRECTORY_SYNC_INTERVAL_SEC: '0' })
    expect(() => invalid.TASKS.find(task => task.name === 'directory-sync')!.intervalMs)
      .toThrow(/DIRECTORY_SYNC_INTERVAL_SEC must be a positive integer of at most 86400/)
  })
})
