// Credentials of the cloud e2e suite, read from the environment of the Playwright run, because no default password exists.
// E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD are the platform admin that the production seed creates from
// BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD, and E2E_USER_PASSWORD is the SEED_USER_PASSWORD of the development seed.

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} must be set for the cloud e2e suite`)
  return value
}

export function adminCredentials(): { email: string; password: string } {
  return { email: required('E2E_ADMIN_EMAIL'), password: required('E2E_ADMIN_PASSWORD') }
}

/** A user of the development seed, who signs in with SEED_USER_PASSWORD. */
export function seedUserCredentials(email: string): { email: string; password: string } {
  return { email, password: required('E2E_USER_PASSWORD') }
}
