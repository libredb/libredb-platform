/**
 * The admin seats of this install as the License page shows them: every admin identity with how Keycloak reports it,
 * read through the database and the Keycloak directory of this process. A reading is kept for 60 seconds, so showing
 * the page again asks Keycloak about each admin at most once a minute, while the first sign-in of a new admin asks it
 * every time (identity/keycloak-provisioning.ts). Licensing applies only in self-hosted mode, so cloud mode has none.
 *
 * Server code only, because it reads the runtime configuration, the database and Keycloak.
 */
import { db } from '../db'
import { getKeycloakDirectory } from '../keycloak/directory'
import { getRuntimeConfig } from '../runtime-config'
import { readAdminSeats, type AdminSeatUsage } from './admin-seats'

/** How long a reading of the admin seats is shown before Keycloak is asked again, in milliseconds. */
const READING_KEPT_MS = 60_000

/** The last reading of this process, which reads that overlap share while it runs. */
let lastReading: { readonly startedAt: number; readonly usage: Promise<AdminSeatUsage> } | undefined

/**
 * The admin seats of this install from a reading at most 60 seconds old, or null in cloud mode. A reading that fails
 * reaches its callers and is not kept, so the next call asks again.
 */
export async function getAdminSeatUsage(): Promise<AdminSeatUsage | null> {
  const config = getRuntimeConfig()
  if (config.DEPLOYMENT_MODE !== 'self-hosted') return null
  const now = Date.now()
  let reading = lastReading
  if (reading === undefined || now - reading.startedAt >= READING_KEPT_MS) {
    const started = { startedAt: now, usage: readAdminSeats(db, getKeycloakDirectory(), config.PLATFORM_ADMIN_ROLE) }
    lastReading = started
    started.usage.catch(() => {
      if (lastReading === started) lastReading = undefined
    })
    reading = started
  }
  return reading.usage
}
