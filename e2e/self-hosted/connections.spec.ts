import { randomUUID } from 'node:crypto'
import { test, expect } from '@playwright/test'
import { Client } from 'pg'
import { FIXTURE_USERS, signInThroughKeycloak } from './helpers/keycloak-login'

// The connection form seals each credential to Studio's key, the list shows the engine and the host
// summary and never a credential, and bridge.connections_v1 publishes the row Studio reads.
// This process reads DATABASE_URL from e2e/self-hosted/platform.env, as the server does.

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} must be set for the self-hosted e2e suite, as in e2e/self-hosted/platform.env`)
  return value
}

interface PublishedConnection {
  engine: string
  definition: unknown
  read_secret: string
  write_secret: string | null
}

/** The rows bridge.connections_v1 publishes under a name, read as the runtime role of DATABASE_URL. */
async function publishedConnections(name: string): Promise<PublishedConnection[]> {
  const url = new URL(required('DATABASE_URL'))
  // schema=platform tells Platform's tools the schema; the query names it itself.
  url.searchParams.delete('schema')
  const client = new Client({ connectionString: url.toString() })
  await client.connect()
  try {
    const result = await client.query<PublishedConnection>(
      'SELECT engine, definition, read_secret, write_secret FROM bridge.connections_v1 WHERE name = $1',
      [name],
    )
    return result.rows
  } finally {
    await client.end()
  }
}

test.describe('Connections in self-hosted mode', () => {
  test('alice creates a postgres connection with read and write credentials, sees it listed without secrets, and bridge.connections_v1 holds the row', async ({ page }) => {
    const suffix = randomUUID().slice(0, 8)
    const name = `E2E Orders ${suffix}`
    const readPassword = `read-secret-${suffix}`
    const writePassword = `write-secret-${suffix}`

    await signInThroughKeycloak(page, FIXTURE_USERS.alice)
    await expect(page).toHaveURL(url => url.pathname === '/connections')

    await page.getByRole('link', { name: 'New Connection' }).click()
    await expect(page).toHaveURL(url => url.pathname === '/connections/new')

    await page.getByLabel('Name', { exact: true }).fill(name)
    await page.getByLabel('Engine', { exact: true }).selectOption('postgres')
    await page.getByLabel('Host', { exact: true }).fill('db.internal')
    await page.getByLabel('Port', { exact: true }).fill('5432')
    await page.getByLabel('Database', { exact: true }).fill('orders')
    await expect(page.getByTestId('least-privilege-sql')).toContainText('GRANT SELECT ON ALL TABLES IN SCHEMA')

    const read = page.getByRole('group', { name: 'Read credential' })
    await read.getByLabel('User', { exact: true }).fill('libredb_read')
    await read.getByLabel('Password', { exact: true }).fill(readPassword)

    await page.getByLabel('Write credential', { exact: true }).selectOption('set')
    const write = page.getByRole('group', { name: 'New write credential' })
    await write.getByLabel('User', { exact: true }).fill('libredb_write')
    await write.getByLabel('Password', { exact: true }).fill(writePassword)

    const create = page.getByRole('button', { name: 'Create connection' })
    await expect(create).toBeDisabled()
    await page.getByLabel(/I confirm that the read credential can only read/).check()
    await create.click()

    await expect(page).toHaveURL(url => url.pathname === '/connections')
    // A clickable row of the data table has the role button, so the row is found by its element.
    const row = page.locator('tbody tr').filter({ hasText: name })
    await expect(row).toContainText('PostgreSQL')
    await expect(row).toContainText('db.internal:5432/orders')
    await expect(row).toContainText('Read and write')

    const html = await page.content()
    for (const secret of [readPassword, writePassword, 'lsb1.']) expect(html).not.toContain(secret)

    const rows = await publishedConnections(name)
    expect(rows).toHaveLength(1)
    const [published] = rows
    expect(published.engine).toBe('postgres')
    expect(published.definition).toEqual({ host: 'db.internal', port: 5432, database: 'orders' })
    expect(published.read_secret).toMatch(/^lsb1\./)
    expect(published.write_secret).toMatch(/^lsb1\./)
    for (const secret of [published.read_secret, published.write_secret]) {
      expect(secret).not.toContain(readPassword)
      expect(secret).not.toContain(writePassword)
    }

    // The edit form shows the definition and never a credential.
    await row.getByText(name).click()
    await expect(page.getByLabel('Host', { exact: true })).toHaveValue('db.internal')
    await expect(page.getByRole('group', { name: 'Read credential' }).getByLabel('Password', { exact: true })).toHaveValue('')
    const detail = await page.content()
    for (const secret of [readPassword, writePassword, 'lsb1.']) expect(detail).not.toContain(secret)
  })
})
