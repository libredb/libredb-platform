import { createHash, randomUUID } from 'node:crypto'
import { test, expect, type Page } from '@playwright/test'
import { Client } from 'pg'
import { allowPlatformRedirects } from './helpers/keycloak-admin'
import { FIXTURE_USERS, signInThroughKeycloak, type FixtureUser } from './helpers/keycloak-login'
import { startPlatformServer } from './helpers/platform-server'

// The license of a self-hosted install, as docs/deploy/platform-runtime.md describes it. The run's server has no
// PLATFORM_LICENSE, so it runs on the free tier of 1 admin seat and 3 user seats. The second test starts another
// server from the same build with a malformed PLATFORM_LICENSE, which shares the run's database and Keycloak, so a
// grant made and a query event recorded under the first server stay in effect and listed under the second.
// This process reads DATABASE_URL from e2e/self-hosted/platform.env, as the server does.

/** The port of the second server; SELF_HOSTED_LICENSE_PORT moves it. */
const SECOND_SERVER_PORT = Number(process.env.SELF_HOSTED_LICENSE_PORT ?? '3101')

// Not a license token: the format's prefix without a kid, a payload or a signature, which the server refuses as
// LICENSE_MALFORMED.
const MALFORMED_LICENSE = 'ldl1.malformed'

// Studio's database role, with the fixed development password that docker/postgres/init/01-bootstrap.sh gives it, as
// DATABASE_URL in e2e/self-hosted/platform.env carries the one of the runtime role. Platform never connects as it.
const STUDIO_ROLE = { user: 'libredb_studio', password: 'libredb_studio_dev' } as const

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} must be set for the self-hosted e2e suite, as in e2e/self-hosted/platform.env`)
  return value
}

/** Runs one statement on the database of DATABASE_URL, as its runtime role or, for `studio`, as Studio's role. */
async function query<T extends Record<string, unknown>>(
  sql: string,
  values: unknown[],
  role: 'platform' | 'studio' = 'platform',
): Promise<T[]> {
  const url = new URL(required('DATABASE_URL'))
  // schema=platform tells Platform's tools the schema; the statement names it itself.
  url.searchParams.delete('schema')
  if (role === 'studio') {
    url.username = STUDIO_ROLE.user
    url.password = STUDIO_ROLE.password
  }
  const client = new Client({ connectionString: url.toString() })
  await client.connect()
  try {
    return (await client.query<T>(sql, values)).rows
  } finally {
    await client.end()
  }
}

/** The grants bridge.grants_v1 publishes for a connection, as Studio reads them. */
function publishedGrants(connectionId: string) {
  return query<{ subject: string; level: string }>(
    'SELECT subject, level FROM bridge.grants_v1 WHERE connection_id = $1 ORDER BY subject',
    [connectionId],
  )
}

/**
 * Records a read query of `user` on the connection as Studio's sink does, and as the development seed's sample events
 * go in: as libredb_studio, through bridge.query_events_v1, which that role may insert into and never read back.
 * Returns the statement, which the audit log shows.
 */
async function recordStudioQuery(connectionId: string, connectionName: string, user: FixtureUser): Promise<string> {
  const statement = `SELECT 'license e2e ${randomUUID()}'`
  const finishedAt = new Date()
  const startedAt = new Date(finishedAt.getTime() - 12)
  await query(
    `INSERT INTO bridge.query_events_v1 (event_id, started_at, finished_at, studio_instance, subject, username,
       session_role, connection_id, connection_name, engine, access_level, source, statement_type, statement_capture,
       statement, statement_fingerprint, row_count, duration_ms, status)
     VALUES ($1, $2, $3, 'libredb-studio', $4, $5, 'user', $6, $7, 'postgres', 'read', 'editor', 'SELECT', 'full',
       $8, $9, 1, 12, 'success')`,
    [
      randomUUID(),
      startedAt,
      finishedAt,
      user.keycloakId,
      user.username,
      connectionId,
      connectionName,
      statement,
      createHash('sha256').update(statement).digest('hex'),
    ],
    'studio',
  )
  return statement
}

/** Creates a postgres connection with a read credential through the connection form and returns its id. */
async function createConnection(page: Page, name: string): Promise<string> {
  await page.goto('/connections')
  await page.getByRole('link', { name: 'New Connection' }).click()
  await page.getByLabel('Name', { exact: true }).fill(name)
  await page.getByLabel('Engine', { exact: true }).selectOption('postgres')
  await page.getByLabel('Host', { exact: true }).fill('db.internal')
  await page.getByLabel('Port', { exact: true }).fill('5432')
  await page.getByLabel('Database', { exact: true }).fill('orders')
  const read = page.getByRole('group', { name: 'Read credential' })
  await read.getByLabel('User', { exact: true }).fill('libredb_read')
  await read.getByLabel('Password', { exact: true }).fill(`read-secret-${randomUUID()}`)
  await page.getByLabel(/I confirm that the read credential can only read/).check()
  await page.getByRole('button', { name: 'Create connection' }).click()
  await expect(page).toHaveURL(url => url.pathname === '/connections')

  await page.locator('tbody tr').filter({ hasText: name }).getByText(name).click()
  await expect(page).toHaveURL(url => /^\/connections\/[^/]+$/.test(url.pathname))
  return new URL(page.url()).pathname.split('/').pop()!
}

test.describe('License in self-hosted mode', () => {
  test('without a key the License page shows the free tier, and the dashboard shows no license banner', async ({ page }) => {
    await signInThroughKeycloak(page, FIXTURE_USERS.alice)
    await expect(page).toHaveURL(url => url.pathname === '/connections')

    await page.locator('[data-sidebar="sidebar"]').getByRole('link', { name: 'License', exact: true }).click()
    await expect(page).toHaveURL(url => url.pathname === '/admin/license')

    const status = page.getByRole('region', { name: 'Status' })
    await expect(status.getByText('Free tier', { exact: true })).toBeVisible()
    await expect(status).toContainText('No license is installed, so the install runs on the free tier of 1 admin seat and 3 user seats.')
    // alice holds the free tier's one admin seat.
    await expect(page.getByRole('region', { name: 'Seats' })).toContainText('Admin seats1 / 1')
    await expect(page.getByRole('region', { name: 'Admins' }).getByRole('row', { name: /alice@libredb\.test/ })).toContainText('Admin')

    // A full load streams the layout's banner, if any, before the load event; within its limits the free tier has none.
    await page.goto('/admin/license')
    await expect(page.getByRole('region', { name: 'Status' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Open the License page' })).toHaveCount(0)
  })

  test('with a malformed PLATFORM_LICENSE the dashboard shows the invalid banner while existing grants and the audit log keep working', async ({ page, browser }) => {
    // Two sign-ins and the start of a second server.
    test.setTimeout(120_000)
    const name = `E2E License ${randomUUID().slice(0, 8)}`

    // Under the run's server, on the free tier: alice grants bob read on a new connection, which takes a user seat.
    await signInThroughKeycloak(page, FIXTURE_USERS.alice)
    await expect(page).toHaveURL(url => url.pathname === '/connections')
    const connectionId = await createConnection(page, name)
    const panel = page.getByRole('region', { name: 'Access' })
    await panel.getByRole('button', { name: 'Grant access' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('searchbox', { name: 'Search the directory' }).fill('bob')
    await dialog.getByRole('button', { name: 'Search' }).click()
    await dialog.getByRole('radio', { name: /\bbob\b/ }).check()
    await dialog.getByRole('button', { name: 'Grant', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    const bobGrant = [{ subject: FIXTURE_USERS.bob.keycloakId, level: 'read' }]
    await expect.poll(() => publishedGrants(connectionId)).toEqual(bobGrant)
    // bob runs a query in Studio with that grant, and Studio records it for the audit log.
    const statement = await recordStudioQuery(connectionId, name, FIXTURE_USERS.bob)

    const server = await startPlatformServer(SECOND_SERVER_PORT, { PLATFORM_LICENSE: MALFORMED_LICENSE })
    try {
      await allowPlatformRedirects(server.baseURL)
      const context = await browser.newContext({ baseURL: server.baseURL })
      try {
        const invalid = await context.newPage()
        await signInThroughKeycloak(invalid, FIXTURE_USERS.alice)
        await expect(invalid).toHaveURL(url => url.pathname === '/connections')

        const banner = invalid.getByRole('status', { name: 'The license is invalid' })
        await expect(banner).toContainText('LICENSE_MALFORMED')
        await expect(banner).toContainText('the free tier of 1 admin seat and 3 user seats')

        await banner.getByRole('link', { name: 'Open the License page' }).click()
        await expect(invalid).toHaveURL(url => url.pathname === '/admin/license')
        const status = invalid.getByRole('region', { name: 'Status' })
        await expect(status.getByText('Invalid', { exact: true })).toBeVisible()
        await expect(status).toContainText('LICENSE_MALFORMED')
        await expect(invalid.getByRole('region', { name: 'Users with a seat' }).getByRole('row', { name: /\bbob\b/ })).toContainText('User')

        // The audit log still lists the query bob ran in Studio.
        await invalid.goto('/audit')
        const event = invalid.locator('tbody tr').filter({ hasText: statement })
        await expect(event).toHaveCount(1)
        await expect(event).toContainText('bob')
        await expect(event).toContainText(name)

        // The grant made before stays listed, and bridge.grants_v1 still publishes it to Studio.
        await invalid.goto(`/connections/${connectionId}`)
        const bobRow = invalid.getByRole('region', { name: 'Access' }).getByRole('row', { name: /\bbob\b/ })
        await expect(bobRow).toContainText('Read')
        expect(await publishedGrants(connectionId)).toEqual(bobGrant)

        // Revoking only narrows access, so the invalid license allows it.
        await bobRow.getByRole('button', { name: 'Revoke' }).click()
        const confirm = invalid.getByRole('dialog')
        await confirm.getByRole('button', { name: 'Revoke access' }).click()
        await expect(confirm).toHaveCount(0)
        await expect.poll(() => publishedGrants(connectionId)).toEqual([])
      } finally {
        await context.close()
      }

      // The second server logged its state and the failure code once at start, and never the value of PLATFORM_LICENSE.
      // LOG_FORMAT=json writes one JSON object per line, between the plain lines of `next start`.
      const lines = server
        .output()
        .split('\n')
        .filter(line => line.startsWith('{') && line.endsWith('}'))
        .map(line => JSON.parse(line) as Record<string, unknown>)
      expect(lines.filter(line => line.message === 'License invalid, running on the free tier')).toEqual([
        expect.objectContaining({ level: 'warn', state: 'invalid', code: 'LICENSE_MALFORMED' }),
      ])
      expect(server.output()).not.toContain(MALFORMED_LICENSE)
    } finally {
      await server.stop()
      // The free tier's user seats are shared by the whole run, so the seat goes back even when a step above failed.
      await query('DELETE FROM platform.connection_grants WHERE "connectionId" = $1', [connectionId])
    }
  })
})
