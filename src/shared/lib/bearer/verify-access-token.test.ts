// @vitest-environment node
import { beforeAll, describe, expect, it } from 'vitest'
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  UnsecuredJWT,
  type CryptoKey,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose'
import { AdminRoleRequiredError, BearerInvalidError, IdentityProviderUnavailableError } from './errors'
import { verifyAccessToken, type AccessTokenSettings } from './verify-access-token'

// Keys generated here and published through a local JWKS, so no test reaches an identity provider.

const ISSUER = 'https://auth.example.test/realms/libredb'
const NOW = new Date('2026-10-23T12:00:00.000Z')
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000)

const SETTINGS: AccessTokenSettings = {
  issuer: ISSUER,
  audience: 'libredb-platform-api',
  clientIds: ['libredb-mobile', 'libredb-cli'],
  roleClaim: 'libredb_roles',
  adminRole: 'admin',
}

const CLAIMS: JWTPayload & Record<string, unknown> = {
  iss: ISSUER,
  aud: ['libredb-studio-api', 'libredb-platform-api'],
  azp: 'libredb-mobile',
  sub: 'kc-alice',
  sid: 'session-alice',
  email: 'alice@libredb.test',
  name: 'Alice Admin',
  preferred_username: 'alice',
  libredb_roles: ['admin'],
  iat: NOW_SECONDS - 60,
  exp: NOW_SECONDS + 240,
}

let signingKey: CryptoKey
let otherKey: CryptoKey
let keys: JWTVerifyGetKey

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true })
  signingKey = pair.privateKey
  otherKey = (await generateKeyPair('RS256')).privateKey
  keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'key-1', alg: 'RS256', use: 'sig' }] })
})

function sign(claims: Record<string, unknown>, key: CryptoKey = signingKey, alg = 'RS256'): Promise<string> {
  return new SignJWT(claims).setProtectedHeader({ alg, kid: 'key-1', typ: 'JWT' }).sign(key)
}

function withClaims(changes: Record<string, unknown>): Record<string, unknown> {
  const claims: Record<string, unknown> = { ...CLAIMS, ...changes }
  for (const [name, value] of Object.entries(changes)) if (value === undefined) delete claims[name]
  return claims
}

function verify(token: string, getKey: JWTVerifyGetKey = keys) {
  return verifyAccessToken(token, SETTINGS, getKey, NOW)
}

async function refusal(token: string): Promise<unknown> {
  try {
    await verify(token)
  } catch (error) {
    return error
  }
  throw new Error('expected the token to be refused')
}

async function expectBearerInvalid(token: string): Promise<void> {
  const error = await refusal(token)
  expect(error).toBeInstanceOf(BearerInvalidError)
  // A refusal never repeats the token.
  expect((error as Error).message).not.toContain(token)
}

describe('verifyAccessToken', () => {
  it('returns the identity of a valid access token with the admin role', async () => {
    await expect(verify(await sign(CLAIMS))).resolves.toEqual({
      sub: 'kc-alice',
      sid: 'session-alice',
      email: 'alice@libredb.test',
      name: 'Alice Admin',
      username: 'alice',
      roles: ['admin'],
    })
  })

  it('accepts a token of each client of PLATFORM_API_CLIENT_IDS and a single audience', async () => {
    await expect(verify(await sign(withClaims({ azp: 'libredb-cli', aud: 'libredb-platform-api' })))).resolves.toMatchObject({
      sub: 'kc-alice',
    })
  })

  it('refuses a token signed by another key', async () => {
    await expectBearerInvalid(await sign(CLAIMS, otherKey))
  })

  it('refuses a token whose key the issuer does not publish', async () => {
    const token = await new SignJWT(CLAIMS).setProtectedHeader({ alg: 'RS256', kid: 'key-unknown' }).sign(signingKey)
    await expectBearerInvalid(token)
  })

  it('refuses an unsecured token with alg none', async () => {
    await expectBearerInvalid(new UnsecuredJWT(CLAIMS).encode())
  })

  it('refuses a token with a symmetric algorithm', async () => {
    const secret = new TextEncoder().encode('a-shared-secret-of-at-least-32-bytes!!')
    const token = await new SignJWT(CLAIMS).setProtectedHeader({ alg: 'HS256', kid: 'key-1' }).sign(secret)
    await expectBearerInvalid(token)
  })

  it('refuses a value that is not a JWT', async () => {
    await expectBearerInvalid('not-a-jwt')
  })

  it('refuses a token of another issuer', async () => {
    await expectBearerInvalid(await sign(withClaims({ iss: 'https://auth.example.test/realms/other' })))
  })

  it('refuses a token without the audience PLATFORM_API_AUDIENCE', async () => {
    await expectBearerInvalid(await sign(withClaims({ aud: ['libredb-studio-api', 'account'] })))
  })

  it('refuses a token whose azp is not in PLATFORM_API_CLIENT_IDS', async () => {
    await expectBearerInvalid(await sign(withClaims({ azp: 'libredb-platform' })))
  })

  it('refuses a token without azp', async () => {
    await expectBearerInvalid(await sign(withClaims({ azp: undefined })))
  })

  it('refuses a token that expired more than 30 seconds ago and accepts one within the skew', async () => {
    await expectBearerInvalid(await sign(withClaims({ exp: NOW_SECONDS - 31 })))
    await expect(verify(await sign(withClaims({ exp: NOW_SECONDS - 25 })))).resolves.toMatchObject({ sub: 'kc-alice' })
  })

  it('refuses a token without exp', async () => {
    await expectBearerInvalid(await sign(withClaims({ exp: undefined })))
  })

  it('refuses a token whose nbf is more than 30 seconds ahead and accepts one within the skew', async () => {
    await expectBearerInvalid(await sign(withClaims({ nbf: NOW_SECONDS + 31 })))
    await expect(verify(await sign(withClaims({ nbf: NOW_SECONDS + 25 })))).resolves.toMatchObject({ sub: 'kc-alice' })
  })

  it('refuses a token without sub', async () => {
    await expectBearerInvalid(await sign(withClaims({ sub: undefined })))
  })

  it('refuses a token without the email that provisioning needs', async () => {
    await expectBearerInvalid(await sign(withClaims({ email: undefined })))
  })

  it('refuses a token whose role claim is not a list of role names', async () => {
    await expectBearerInvalid(await sign(withClaims({ libredb_roles: 'admin' })))
  })

  it('answers ADMIN_ROLE_REQUIRED for a valid token whose role claim lacks PLATFORM_ADMIN_ROLE', async () => {
    expect(await refusal(await sign(withClaims({ libredb_roles: ['user'] })))).toBeInstanceOf(AdminRoleRequiredError)
    expect(await refusal(await sign(withClaims({ libredb_roles: undefined })))).toBeInstanceOf(AdminRoleRequiredError)
  })

  it('passes on IdentityProviderUnavailableError from the keys, never a 401', async () => {
    const unavailable: JWTVerifyGetKey = async () => {
      throw new IdentityProviderUnavailableError()
    }
    await expect(verify(await sign(CLAIMS), unavailable)).rejects.toBeInstanceOf(IdentityProviderUnavailableError)
  })
})
