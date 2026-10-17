import { test as setup } from '@playwright/test'
import { allowPlatformRedirects } from './helpers/keycloak-admin'

// The fixture realm lets the libredb-platform client redirect only to http://localhost:3100, the self-hosted project's
// default. Before the specs sign in, the run registers the redirect URIs of the Platform that AUTH_URL names through
// the Admin REST API of the Keycloak it started, so Platform can listen on any port and the realm file stays as it is.
setup("the libredb-platform client redirects to the run's Platform", async () => {
  await allowPlatformRedirects()
})
