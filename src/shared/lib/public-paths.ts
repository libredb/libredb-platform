import type { DeploymentMode } from './deployment'

// Path prefixes the proxy serves without a session.
// Registration and password reset exist only in cloud mode.
const PUBLIC_PATHS: Readonly<Record<DeploymentMode, readonly string[]>> = {
  cloud: ['/login', '/register', '/forgot-password', '/api/auth', '/api/health'],
  'self-hosted': ['/login', '/api/auth', '/api/health'],
}

/** The path prefixes the proxy serves without a session in `mode`. */
export function publicPathsFor(mode: DeploymentMode): readonly string[] {
  return PUBLIC_PATHS[mode]
}

/** True when the proxy serves `pathname` without a session in `mode`. */
export function isPublicPath(pathname: string, mode: DeploymentMode): boolean {
  return publicPathsFor(mode).some(path => pathname.startsWith(path))
}
