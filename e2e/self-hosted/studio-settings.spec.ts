import { test, expect } from '@playwright/test'
import { Client } from 'pg'
import { FIXTURE_USERS, signInThroughKeycloak } from './helpers/keycloak-login'

// The Studio settings page writes platform.studio_settings, which Studio reads through
// bridge.settings_v1, and a reset deletes the row so Studio applies its default.
// This process reads DATABASE_URL from e2e/self-hosted/platform.env, as the server does.

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} must be set for the self-hosted e2e suite, as in e2e/self-hosted/platform.env`)
  return value
}

/** The values bridge.settings_v1 publishes for a key, read as the runtime role of DATABASE_URL. */
async function publishedValues(key: string): Promise<unknown[]> {
  const url = new URL(required('DATABASE_URL'))
  // schema=platform tells Platform's tools the schema; the query names it itself.
  url.searchParams.delete('schema')
  const client = new Client({ connectionString: url.toString() })
  await client.connect()
  try {
    const result = await client.query<{ value: unknown }>('SELECT value FROM bridge.settings_v1 WHERE key = $1', [key])
    return result.rows.map(row => row.value)
  } finally {
    await client.end()
  }
}

test.describe('Studio settings in self-hosted mode', () => {
  test('alice sets query.timeoutMs to 120000, bridge.settings_v1 shows it, and reset returns it to Studio default', async ({ page }) => {
    await signInThroughKeycloak(page, FIXTURE_USERS.alice)
    await expect(page).toHaveURL(url => url.pathname === '/connections')

    await page.locator('[data-sidebar="sidebar"]').getByRole('link', { name: 'Studio Settings' }).click()
    await expect(page).toHaveURL(url => url.pathname === '/studio-settings')

    const row = page.getByRole('group', { name: 'query.timeoutMs' })
    await expect(row.getByTestId('current-value')).toHaveText('Studio default')

    await row.getByRole('spinbutton', { name: 'query.timeoutMs' }).fill('120000')
    await row.getByRole('button', { name: 'Save query.timeoutMs' }).click()
    await expect(row.getByTestId('current-value')).toHaveText('120000')
    await expect.poll(() => publishedValues('query.timeoutMs')).toEqual([120000])

    // The held keys are read-only.
    const agent = page.getByRole('group', { name: 'agent.enabled' })
    await expect(agent.getByText('Held off in governance mode until MCP and agent governance ship.')).toBeVisible()
    await expect(agent.getByRole('button', { name: 'Save agent.enabled' })).toHaveCount(0)

    await row.getByRole('button', { name: 'Reset query.timeoutMs' }).click()
    await expect(row.getByTestId('current-value')).toHaveText('Studio default')
    await expect.poll(() => publishedValues('query.timeoutMs')).toEqual([])
  })
})
