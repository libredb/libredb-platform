import Credentials from 'next-auth/providers/credentials'
import Keycloak from 'next-auth/providers/keycloak'
import type { Provider } from 'next-auth/providers'
import { ConfigError } from '../errors'
import type { RuntimeConfig } from '../runtime-config'
import type { CredentialsUser } from './authorize-credentials'

/** The variables of the validated runtime configuration (`getRuntimeConfig()`) that choose and configure the providers. */
export type ProviderConfig = Pick<RuntimeConfig, 'DEPLOYMENT_MODE'> &
  Partial<Pick<RuntimeConfig, 'AUTH_KEYCLOAK_ISSUER' | 'AUTH_KEYCLOAK_ID' | 'AUTH_KEYCLOAK_SECRET'>>

export interface ProviderDeps {
  /** The authorize step of the Credentials provider, which checks the password against password_credentials. */
  authorizeCredentials(credentials: Partial<Record<'email' | 'password', unknown>>): Promise<CredentialsUser | null>
}

const KEYCLOAK_CLIENT_VARIABLES = ['AUTH_KEYCLOAK_ISSUER', 'AUTH_KEYCLOAK_ID', 'AUTH_KEYCLOAK_SECRET'] as const

/**
 * The sign-in providers of a deployment mode: Keycloak alone in self-hosted mode, with PKCE, state
 * and nonce, and the Credentials provider alone in cloud mode.
 * It reads only its arguments and imports nothing from Next.js, so vitest loads it.
 */
export function buildProviders(config: ProviderConfig, deps: ProviderDeps): Provider[] {
  if (config.DEPLOYMENT_MODE === 'self-hosted') {
    const { AUTH_KEYCLOAK_ISSUER: issuer, AUTH_KEYCLOAK_ID: clientId, AUTH_KEYCLOAK_SECRET: clientSecret } = config
    // readRuntimeConfig requires the three in self-hosted mode; this guards any other caller.
    if (!issuer || !clientId || !clientSecret) {
      const missing = KEYCLOAK_CLIENT_VARIABLES.filter(name => !config[name])
      throw new ConfigError(missing.map(name => `${name} is required in self-hosted mode`).join('; '))
    }
    return [Keycloak({ issuer, clientId, clientSecret, checks: ['pkce', 'state', 'nonce'] })]
  }

  return [
    Credentials({
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      authorize: credentials => deps.authorizeCredentials(credentials),
    }),
  ]
}
