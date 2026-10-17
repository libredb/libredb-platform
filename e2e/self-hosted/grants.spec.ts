import { randomUUID } from 'node:crypto'
import { test, expect } from '@playwright/test'
import { Client } from 'pg'
import { FIXTURE_USERS, signInThroughKeycloak } from './helpers/keycloak-login'

// The access panel of a connection grants a Keycloak user picked from the directory, and
// bridge.grants_v1 publishes the grant Studio enforces until the panel revokes it.
// This process reads DATABASE_URL from e2e/self-hosted/platform.env, as the server does.

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} must be set for the self-hosted e2e suite, as in e2e/self-hosted/platform.env`)
  return value
}

interface PublishedGrant {
  subject: string
  level: string
  downgraded: boolean
}

/** The rows bridge.grants_v1 publishes for a connection, read as the runtime role of DATABASE_URL. */
async function publishedGrants(connectionId: string): Promise<PublishedGrant[]> {
  const url = new URL(required('DATABASE_URL'))
  // schema=platform tells Platform's tools the schema; the query names it itself.
  url.searchParams.delete('schema')
  const client = new Client({ connectionString: url.toString() })
  await client.connect()
  try {
    const result = await client.query<PublishedGrant>(
      'SELECT subject, level, downgraded FROM bridge.grants_v1 WHERE connection_id = $1 ORDER BY subject',
      [connectionId],
    )
    return result.rows
  } finally {
    await client.end()
  }
}

test.describe('Grants in self-hosted mode', () => {
  test("alice grants bob read on a connection, bridge.grants_v1 shows bob's id with level read, and revoking removes the row", async ({ page }) => {
    const name = `E2E Grants ${randomUUID().slice(0, 8)}`

    await signInThroughKeycloak(page, FIXTURE_USERS.alice)
    await expect(page).toHaveURL(url => url.pathname === '/connections')

    // A connection with a read credential only, so the panel offers read and disables write.
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
    const connectionId = new URL(page.url()).pathname.split('/').pop()!

    const panel = page.getByRole('region', { name: 'Access' })
    await expect(panel).toContainText('No user holds a grant on this connection.')

    await panel.getByRole('button', { name: 'Grant access' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('radio', { name: 'Write' })).toBeDisabled()
    await dialog.getByRole('searchbox', { name: 'Search the directory' }).fill('bob')
    await dialog.getByRole('button', { name: 'Search' }).click()
    const bobOption = dialog.getByRole('radio', { name: /\bbob\b/ })
    await expect(bobOption).toBeVisible()
    await expect(dialog.getByRole('radio', { name: /\balice\b/ })).toHaveCount(0)
    await bobOption.check()
    await expect(dialog.getByRole('radio', { name: 'Read' })).toBeChecked()
    await dialog.getByRole('button', { name: 'Grant', exact: true }).click()
    await expect(dialog).toHaveCount(0)

    const bobRow = panel.getByRole('row', { name: /\bbob\b/ })
    await expect(bobRow).toContainText('bob@libredb.test')
    await expect(bobRow).toContainText('User')
    await expect(bobRow).toContainText('Read')
    await expect(bobRow).toContainText('Never')

    await expect
      .poll(() => publishedGrants(connectionId))
      .toEqual([{ subject: FIXTURE_USERS.bob.keycloakId, level: 'read', downgraded: false }])

    await bobRow.getByRole('button', { name: 'Revoke' }).click()
    const confirm = page.getByRole('dialog')
    await expect(confirm).toContainText('Revoke the access of bob?')
    await confirm.getByRole('button', { name: 'Revoke access' }).click()
    await expect(confirm).toHaveCount(0)
    await expect(panel).toContainText('No user holds a grant on this connection.')

    await expect.poll(() => publishedGrants(connectionId)).toEqual([])
  })
})
