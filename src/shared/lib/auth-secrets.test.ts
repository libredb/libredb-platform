import { describe, it, expect } from 'vitest'
import { encode, decode } from '@auth/core/jwt'
import { getAuthSecrets } from './auth-secrets'

const CURRENT = 'current-auth-secret-of-at-least-32-characters'
const PREVIOUS = 'previous-auth-secret-of-at-least-32-characters'
// Auth.js salts the session token with the name of its cookie.
const SALT = 'authjs.session-token'

describe('getAuthSecrets', () => {
  it('returns the current secret alone when no previous value is set', () => {
    expect(getAuthSecrets({ AUTH_SECRET: CURRENT })).toEqual([CURRENT])
  })

  it('lists the current secret first and the previous one second', () => {
    expect(getAuthSecrets({ AUTH_SECRET: CURRENT, AUTH_SECRET_PREVIOUS: PREVIOUS })).toEqual([CURRENT, PREVIOUS])
  })

  it('a session token encoded with the previous secret decodes with the array', async () => {
    const token = await encode({ token: { sub: 'user-1' }, secret: PREVIOUS, salt: SALT })
    const secrets = getAuthSecrets({ AUTH_SECRET: CURRENT, AUTH_SECRET_PREVIOUS: PREVIOUS })

    expect(await decode({ token, secret: secrets, salt: SALT })).toMatchObject({ sub: 'user-1' })
    await expect(decode({ token, secret: getAuthSecrets({ AUTH_SECRET: CURRENT }), salt: SALT })).rejects.toThrow()
  })

  it('a new token is encoded with the current secret', async () => {
    const secrets = getAuthSecrets({ AUTH_SECRET: CURRENT, AUTH_SECRET_PREVIOUS: PREVIOUS })
    const token = await encode({ token: { sub: 'user-1' }, secret: secrets, salt: SALT })

    expect(await decode({ token, secret: CURRENT, salt: SALT })).toMatchObject({ sub: 'user-1' })
    await expect(decode({ token, secret: PREVIOUS, salt: SALT })).rejects.toThrow()
  })
})
