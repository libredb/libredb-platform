import { defineConfig } from '@playwright/test'

// Each project reads its base URL from the environment, so parallel runs and CI can choose a port.
// cloud: a cloud-mode server, by default the dev server on port 3000.
// self-hosted: a self-hosted server started with e2e/self-hosted/platform.env, by default on port 3100, the port of
// the libredb-platform redirect URI in tests/fixtures/keycloak/libredb-test-realm.json. A run on another port sets
// SELF_HOSTED_BASE_URL and AUTH_URL, and the project self-hosted-setup registers that Platform's redirect URIs first.
const cloudBaseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000'
const selfHostedBaseURL = process.env.SELF_HOSTED_BASE_URL ?? 'http://localhost:3100'

export default defineConfig({
  timeout: 30000,
  retries: 0,
  use: {
    headless: true,
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'cloud',
      testDir: './e2e',
      testIgnore: 'self-hosted/**',
      use: { browserName: 'chromium', baseURL: cloudBaseURL },
    },
    {
      name: 'self-hosted-setup',
      testDir: './e2e/self-hosted',
      testMatch: 'keycloak.setup.ts',
    },
    {
      name: 'self-hosted',
      testDir: './e2e/self-hosted',
      dependencies: ['self-hosted-setup'],
      // The specs share the fixture users, and session-recheck.spec.ts removes alice's admin role for a few seconds,
      // which ends every session of hers, so the project runs one test at a time.
      workers: 1,
      use: { browserName: 'chromium', baseURL: selfHostedBaseURL },
    },
  ],
  // The server is already running, don't start another
  // webServer: { command: 'npm run dev', port: 3000 },
})
