import { describe, expect, it } from 'vitest'
import { IdentityClaimError, readKeycloakClaims } from './keycloak-claims'

const ROLE_CLAIM = 'libredb_roles'

// The ID-token claims of alice in the test realm (tests/fixtures/keycloak/libredb-test-realm.json).
const ALICE = {
  iss: 'http://localhost:58080/realms/libredb',
  aud: 'libredb-platform',
  sub: '00000000-0000-4000-8000-00000000a11c',
  sid: 'b7f1e5a2-0c6d-4f3e-9a51-6f2d8c4e1a90',
  email: 'alice@libredb.test',
  email_verified: true,
  name: 'Alice Admin',
  preferred_username: 'alice',
  given_name: 'Alice',
  family_name: 'Admin',
  libredb_roles: ['admin'],
}

// A copy of the claims without the named claims, as an ID token that never carried them.
function without(claims: Record<string, unknown>, ...names: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(claims).filter(([name]) => !names.includes(name)))
}

function claimError(profile: Record<string, unknown>): IdentityClaimError {
  try {
    readKeycloakClaims(profile, ROLE_CLAIM)
  } catch (error) {
    if (error instanceof IdentityClaimError) return error
    throw error
  }
  throw new Error('expected an IdentityClaimError')
}

describe('readKeycloakClaims', () => {
  it('reads the roles from the flat libredb_roles claim', () => {
    expect(readKeycloakClaims(ALICE, ROLE_CLAIM)).toEqual({
      sub: '00000000-0000-4000-8000-00000000a11c',
      sid: 'b7f1e5a2-0c6d-4f3e-9a51-6f2d8c4e1a90',
      email: 'alice@libredb.test',
      name: 'Alice Admin',
      username: 'alice',
      roles: ['admin'],
    })
    expect(readKeycloakClaims({ ...ALICE, libredb_roles: ['user', 'admin'] }, ROLE_CLAIM).roles).toEqual(['user', 'admin'])
  })

  it('reads only the flat claim that PLATFORM_ROLE_CLAIM names, never a nested path', () => {
    const profile = { ...ALICE, libredb_roles: undefined, groups: ['admin'], realm_access: { roles: ['admin'] } }

    expect(readKeycloakClaims(profile, 'groups').roles).toEqual(['admin'])
    expect(readKeycloakClaims(profile, ROLE_CLAIM).roles).toEqual([])
    expect(readKeycloakClaims(profile, 'realm_access.roles').roles).toEqual([])
  })

  it('a missing role claim yields no roles', () => {
    const carol = without({ ...ALICE, email: 'carol@libredb.test' }, 'libredb_roles')

    expect(readKeycloakClaims(carol, ROLE_CLAIM).roles).toEqual([])
    expect(readKeycloakClaims({ ...carol, libredb_roles: null }, ROLE_CLAIM).roles).toEqual([])
    expect(readKeycloakClaims({ ...carol, libredb_roles: [] }, ROLE_CLAIM).roles).toEqual([])
  })

  it('a role claim that is not a list of role names throws IdentityClaimError naming the claim', () => {
    for (const value of ['admin', 42, { admin: true }, ['admin', 7]]) {
      const error = claimError({ ...ALICE, libredb_roles: value })
      expect(error.claim).toBe(ROLE_CLAIM)
      expect(error.message).toContain(ROLE_CLAIM)
    }
  })

  it('a missing email throws IdentityClaimError', () => {
    const withoutEmail = without(ALICE, 'email')

    for (const profile of [withoutEmail, { ...ALICE, email: '' }, { ...ALICE, email: null }, { ...ALICE, email: 7 }]) {
      const error = claimError(profile)
      expect(error.claim).toBe('email')
      expect(error.message).toContain('email')
    }
  })

  it('a missing sub throws IdentityClaimError', () => {
    const withoutSub = without(ALICE, 'sub')

    for (const profile of [withoutSub, { ...ALICE, sub: '' }]) {
      expect(claimError(profile).claim).toBe('sub')
    }
    expect(() => readKeycloakClaims(undefined, ROLE_CLAIM)).toThrow(IdentityClaimError)
  })

  it('reads the optional sid, name and preferred_username as null when they are absent', () => {
    const minimal = without(ALICE, 'sid', 'name', 'preferred_username')

    expect(readKeycloakClaims(minimal, ROLE_CLAIM)).toMatchObject({ sid: null, name: null, username: null })
  })

  it('never repeats a claim value in the error message', () => {
    const withoutEmail = without(ALICE, 'email')

    expect(claimError(withoutEmail).message).not.toContain(ALICE.sub)
    expect(claimError({ ...ALICE, libredb_roles: 'secret-role-value' }).message).not.toContain('secret-role-value')
  })
})
