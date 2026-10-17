import { describe, it, expect } from 'vitest'
import { keycloakAdminConfig, type KeycloakEnv } from './config'
import { KeycloakConfigError } from './errors'
import { ConfigError } from '../errors'

const CLIENT = {
  AUTH_KEYCLOAK_ID: 'libredb-platform',
  AUTH_KEYCLOAK_SECRET: 'client-secret-value',
}

const ISSUER = 'https://auth.libredb.test/realms/libredb'

function configError(env: KeycloakEnv): KeycloakConfigError {
  try {
    keycloakAdminConfig(env)
  } catch (error) {
    if (error instanceof KeycloakConfigError) return error
    throw error
  }
  throw new Error('expected a KeycloakConfigError')
}

describe('keycloakAdminConfig', () => {
  it('derives the admin base and the token endpoint from the issuer', () => {
    expect(keycloakAdminConfig({ ...CLIENT, AUTH_KEYCLOAK_ISSUER: ISSUER })).toEqual({
      realm: 'libredb',
      adminBaseUrl: 'https://auth.libredb.test/admin/realms/libredb',
      tokenEndpoint: 'https://auth.libredb.test/realms/libredb/protocol/openid-connect/token',
      clientId: 'libredb-platform',
      clientSecret: 'client-secret-value',
    })

    // A Keycloak served under a context path, such as /auth before Keycloak 17, keeps that path.
    expect(keycloakAdminConfig({ ...CLIENT, AUTH_KEYCLOAK_ISSUER: 'http://localhost:58080/auth/realms/corp' })).toMatchObject({
      realm: 'corp',
      adminBaseUrl: 'http://localhost:58080/auth/admin/realms/corp',
      tokenEndpoint: 'http://localhost:58080/auth/realms/corp/protocol/openid-connect/token',
    })
  })

  it('uses KEYCLOAK_ADMIN_URL for both when it is set', () => {
    for (const adminUrl of ['http://keycloak:8080', 'http://keycloak:8080/']) {
      expect(keycloakAdminConfig({ ...CLIENT, AUTH_KEYCLOAK_ISSUER: ISSUER, KEYCLOAK_ADMIN_URL: adminUrl })).toEqual({
        realm: 'libredb',
        adminBaseUrl: 'http://keycloak:8080/admin/realms/libredb',
        tokenEndpoint: 'http://keycloak:8080/realms/libredb/protocol/openid-connect/token',
        clientId: 'libredb-platform',
        clientSecret: 'client-secret-value',
      })
    }

    expect(keycloakAdminConfig({ ...CLIENT, AUTH_KEYCLOAK_ISSUER: ISSUER, KEYCLOAK_ADMIN_URL: 'http://keycloak:8080/auth/' }))
      .toMatchObject({
        adminBaseUrl: 'http://keycloak:8080/auth/admin/realms/libredb',
        tokenEndpoint: 'http://keycloak:8080/auth/realms/libredb/protocol/openid-connect/token',
      })
  })

  it('rejects an issuer without /realms/<name>', () => {
    for (const issuer of [
      'https://auth.libredb.test',
      'https://auth.libredb.test/',
      'https://auth.libredb.test/libredb',
      'https://auth.libredb.test/realms',
      'https://auth.libredb.test/realms/',
      'https://auth.libredb.test/realms/libredb/',
      'https://auth.libredb.test/realms/libredb/account',
      'https://auth.libredb.test/realms/libredb?kc_idp_hint=corp',
      'https://auth.libredb.test/realms/libredb#top',
      'https://user:password@auth.libredb.test/realms/libredb',
      'auth.libredb.test/realms/libredb',
      'ftp://auth.libredb.test/realms/libredb',
    ]) {
      const error = configError({ ...CLIENT, AUTH_KEYCLOAK_ISSUER: issuer })

      expect(error).toBeInstanceOf(ConfigError)
      expect(error.message).toMatch(/AUTH_KEYCLOAK_ISSUER must be an absolute http\(s\) URL ending in \/realms\/<realm>/)
      expect(error.message).not.toContain('auth.libredb.test')
    }
  })

  it('requires the issuer, the client id and the secret, and rejects a KEYCLOAK_ADMIN_URL that is not a plain http(s) URL', () => {
    const missing = configError({}).message
    for (const name of ['AUTH_KEYCLOAK_ISSUER', 'AUTH_KEYCLOAK_ID', 'AUTH_KEYCLOAK_SECRET']) {
      expect(missing).toContain(`${name} is required`)
    }
    expect(configError({ ...CLIENT, AUTH_KEYCLOAK_ISSUER: ISSUER, AUTH_KEYCLOAK_SECRET: '' }).message)
      .toMatch(/AUTH_KEYCLOAK_SECRET is required/)

    for (const adminUrl of [
      'keycloak:8080',
      '/keycloak',
      'ftp://keycloak:8080',
      'http://keycloak:8080/?realm=libredb',
      'http://keycloak:8080/#admin',
      'http://admin:password@keycloak:8080',
    ]) {
      const error = configError({ ...CLIENT, AUTH_KEYCLOAK_ISSUER: ISSUER, KEYCLOAK_ADMIN_URL: adminUrl })

      expect(error.message).toMatch(/KEYCLOAK_ADMIN_URL must be an absolute http\(s\) URL/)
      expect(error.message).not.toContain('password')
    }
  })
})
