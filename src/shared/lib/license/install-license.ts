/**
 * The license of this install: PLATFORM_LICENSE verified against the keys compiled into this build and the host of
 * AUTH_URL once per process, with its state computed from the clock on every read. Licensing applies only in
 * self-hosted mode, so cloud mode has no license status. docs/deploy/platform-runtime.md describes the variable.
 *
 * Server code only, because it reads the runtime configuration; index.ts exports the part of the module that reads
 * none.
 */
import { ConfigError } from '../errors'
import { logger } from '../logger'
import { getRuntimeConfig, type RuntimeConfig } from '../runtime-config'
import { LICENSE_KEYS } from './keys'
import { licenseStatus, type LicenseState, type LicenseStatus } from './state'
import { licenseKeyring, verifyLicenseToken, type LicenseVerification } from './token'

/** The outcome of verifying PLATFORM_LICENSE in this process, or undefined before the first read. */
let installVerification: LicenseVerification | undefined

function verifyInstallLicense(config: Pick<RuntimeConfig, 'PLATFORM_LICENSE' | 'AUTH_URL'>): LicenseVerification {
  if (installVerification === undefined) {
    // readRuntimeConfig requires PLATFORM_LICENSE in self-hosted mode; this guards any other caller, so that an install
    // without a token never reads as a state.
    if (config.PLATFORM_LICENSE === undefined) throw new ConfigError('PLATFORM_LICENSE is required in self-hosted mode')
    installVerification = verifyLicenseToken(config.PLATFORM_LICENSE, {
      keyring: licenseKeyring(LICENSE_KEYS),
      // The runtime configuration accepts only an absolute AUTH_URL, and URL#hostname gives its host in lowercase and
      // without port.
      host: config.AUTH_URL === undefined ? null : new URL(config.AUTH_URL).hostname,
    })
  }
  return installVerification
}

/**
 * The license status of this install at `now`, or null in cloud mode, where licensing does not apply. The token is
 * verified on first use and the outcome kept for the life of the process, while the state follows `now` on every read.
 * Whatever the token, it does not throw: only a key list that licenseKeyring refuses, a defect of the build, an invalid
 * runtime configuration, such as a self-hosted one without PLATFORM_LICENSE, through the ConfigError of
 * getRuntimeConfig, and in self-hosted mode a `now` that is not a valid date, through the RangeError of licenseStatus,
 * make it throw.
 */
export function getLicenseStatus(now: Date = new Date()): LicenseStatus | null {
  const config = getRuntimeConfig()
  if (config.DEPLOYMENT_MODE !== 'self-hosted') return null
  return licenseStatus(verifyInstallLicense(config), now)
}

/** The line logged at start in each state: at info when nobody needs to act, at warn when an admin should. */
const START_LINES: Record<LicenseState, { readonly level: 'info' | 'warn'; readonly message: string }> = {
  invalid: { level: 'warn', message: 'License invalid, no seat can be added' },
  active: { level: 'info', message: 'License active' },
  expiring: { level: 'warn', message: 'License expiring within 30 days' },
  grace: { level: 'warn', message: 'License expired, in its 14-day grace period' },
  expired: { level: 'warn', message: 'License expired, no seat can be added' },
}

/** The fields of the start line: the state, with the failure code of an invalid token or the license of a valid one. */
function startFields(status: LicenseStatus): Record<string, string> {
  if (status.state === 'invalid') return { state: status.state, code: status.code }
  return {
    state: status.state,
    licenseId: status.license.id,
    customer: status.license.customer,
    expiresAt: new Date(status.license.expiresAt * 1000).toISOString(),
  }
}

/**
 * Logs the license status of this install in one line, as register() does once at start, and nothing in cloud mode.
 * It never throws and never logs the token, so no token, valid or not, stops Platform from starting: a failure to read
 * the license, which at start only a defective key list can cause, because register() has checked the runtime
 * configuration first, is logged as an error instead.
 */
export function logLicenseStatus(): void {
  let status: LicenseStatus | null
  try {
    status = getLicenseStatus()
  } catch (error) {
    logger.error('Reading the license failed', error instanceof Error ? error : new Error(String(error)))
    return
  }
  if (status === null) return
  const line = START_LINES[status.state]
  logger[line.level](line.message, startFields(status))
}
