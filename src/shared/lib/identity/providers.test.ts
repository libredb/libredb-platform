import { describe, expect, it, vi } from 'vitest'
import type { Provider } from 'next-auth/providers'
import { ConfigError } from '../errors'
import { buildProviders, type ProviderConfig } from './providers'

// The Keycloak client of the test realm (tests/fixtures/keycloak/libredb-test-realm.json).
const SELF_HOSTED: ProviderConfig = {
  DEPLOYMENT_MODE: 'self-hosted',
  AUTH_KEYCLOAK_ISSUER: 'http://localhost:58080/realms/libredb',
  AUTH_KEYCLOAK_ID: 'libredb-platform',
  AUTH_KEYCLOAK_SECRET: 'libredb-platform-test-secret',
}

const CLOUD: ProviderConfig = { DEPLOYMENT_MODE: 'cloud' }

// The provider objects that Auth.js reads. A factory such as Keycloak() returns its defaults with the options it was
// given under `options`, which Auth.js merges over the defaults.
function resolved(providers: Provider[]) {
  return providers.map(provider => (typeof provider === 'function' ? provider() : provider))
}

describe('buildProviders', () => {
  it('self-hosted registers only keycloak with checks pkce, state and nonce', () => {
    const providers = resolved(buildProviders(SELF_HOSTED, { authorizeCredentials: vi.fn() }))

    expect(providers.map(provider => provider.id)).toEqual(['keycloak'])
    expect(providers[0]).toMatchObject({
      type: 'oidc',
      options: {
        issuer: 'http://localhost:58080/realms/libredb',
        clientId: 'libredb-platform',
        clientSecret: 'libredb-platform-test-secret',
        checks: ['pkce', 'state', 'nonce'],
      },
    })
  })

  it('cloud registers only credentials', async () => {
    const user = { id: 'user-bob', email: 'bob@example.com', name: 'Bob User' }
    const authorizeCredentials = vi.fn(async () => user as never)

    const providers = resolved(buildProviders(CLOUD, { authorizeCredentials }))

    expect(providers.map(provider => provider.id)).toEqual(['credentials'])
    expect(providers[0].type).toBe('credentials')
    // The provider's authorize step is the injected one, which checks the password against password_credentials.
    const { authorize } = providers[0].options as { authorize: (credentials: unknown, request: Request) => Promise<unknown> }
    const credentials = { email: 'bob@example.com', password: 'a password' }
    await expect(authorize(credentials, new Request('http://localhost/api/auth/callback/credentials'))).resolves.toBe(user)
    expect(authorizeCredentials).toHaveBeenCalledWith(credentials)
  })

  it('self-hosted without the Keycloak client throws ConfigError naming each missing variable', () => {
    const build = () => buildProviders({ ...SELF_HOSTED, AUTH_KEYCLOAK_ID: undefined, AUTH_KEYCLOAK_SECRET: undefined }, {
      authorizeCredentials: vi.fn(),
    })

    expect(build).toThrow(ConfigError)
    expect(build).toThrow('AUTH_KEYCLOAK_ID is required in self-hosted mode; AUTH_KEYCLOAK_SECRET is required in self-hosted mode')
  })
})
