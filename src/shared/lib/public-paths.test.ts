import { describe, it, expect } from 'vitest'
import { isPublicPath, publicPathsFor } from './public-paths'

describe('public paths', () => {
  it('cloud mode treats sign-in, registration, password reset, Auth.js and health as public', () => {
    expect(publicPathsFor('cloud')).toEqual(['/login', '/register', '/forgot-password', '/api/auth', '/api/health'])
    for (const path of ['/login', '/register', '/forgot-password', '/api/auth/session', '/api/health/live']) {
      expect(isPublicPath(path, 'cloud')).toBe(true)
    }
  })

  it('self-hosted mode does not treat /register and /forgot-password as public', () => {
    expect(publicPathsFor('self-hosted')).toEqual(['/login', '/api/auth', '/api/health'])
    expect(isPublicPath('/register', 'self-hosted')).toBe(false)
    expect(isPublicPath('/forgot-password', 'self-hosted')).toBe(false)
    expect(isPublicPath('/login', 'self-hosted')).toBe(true)
    expect(isPublicPath('/api/auth/callback/keycloak', 'self-hosted')).toBe(true)
  })

  it('neither mode treats an application page as public', () => {
    expect(isPublicPath('/connections', 'cloud')).toBe(false)
    expect(isPublicPath('/connections', 'self-hosted')).toBe(false)
  })
})
