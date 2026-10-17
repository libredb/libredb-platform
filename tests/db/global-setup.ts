import { Client } from 'pg'
import { FIXTURE_HOST, FIXTURE_PORT, fixtureUrl } from './connect'
import { migrate } from './migrate'

const TIMEOUT_MS = 60_000
const INTERVAL_MS = 500

// Waits until the fixture server from docker-compose.test.yml accepts a
// connection as the superuser to database libredb, which exists only once
// the bootstrap has run. Fails the run with the last error on timeout.
async function waitForServer(): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS
  let lastError: unknown
  while (Date.now() < deadline) {
    const client = new Client({ connectionString: fixtureUrl('superuser'), connectionTimeoutMillis: 2_000 })
    try {
      await client.connect()
      await client.query('SELECT 1')
      await client.end()
      return
    } catch (error) {
      lastError = error
      await client.end().catch(() => undefined)
      await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS))
    }
  }
  const reason = lastError instanceof Error ? lastError.message : String(lastError)
  throw new Error(
    `PostgreSQL fixture server at ${FIXTURE_HOST}:${FIXTURE_PORT} is not ready after ${TIMEOUT_MS} ms: ${reason}. ` +
      'Start it with `docker compose -f docker-compose.test.yml up -d --wait postgres` or run `npm run test:db`.',
  )
}

export default async function setup(): Promise<void> {
  await waitForServer()
  await migrate()
}
