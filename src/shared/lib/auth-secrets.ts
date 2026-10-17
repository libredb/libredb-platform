import type { RuntimeConfig } from './runtime-config'

export type AuthSecretConfig = Pick<RuntimeConfig, 'AUTH_SECRET' | 'AUTH_SECRET_PREVIOUS'>

/**
 * The secrets Auth.js signs and reads session tokens with: the current one first, then the previous one during a rotation.
 * Auth.js encodes with the first secret and decodes with any of them (`@auth/core/jwt`).
 * The list is explicit because next-auth 5.0.0-beta.30 never reads `AUTH_SECRET_1..3` when `AUTH_SECRET` is set.
 */
export function getAuthSecrets(config: AuthSecretConfig): [string] | [string, string] {
  return config.AUTH_SECRET_PREVIOUS === undefined
    ? [config.AUTH_SECRET]
    : [config.AUTH_SECRET, config.AUTH_SECRET_PREVIOUS]
}
