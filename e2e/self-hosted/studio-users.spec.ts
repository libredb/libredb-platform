import { test, expect } from '@playwright/test'
import { Client } from 'pg'
import { FIXTURE_USERS, signInThroughKeycloak } from './helpers/keycloak-login'

// The Studio users page lists the members of the admin and user roles from the Keycloak directory,
// and "Revoke Studio sessions" inserts a session revocation, which Studio reads through bridge.session_revocations_v1.
// This process reads DATABASE_URL from e2e/self-hosted/platform.env, as the server does.

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} must be set for the self-hosted e2e suite, as in e2e/self-hosted/platform.env`)
  return value
}

/** Runs `query` as the runtime role of DATABASE_URL. */
async function asRuntimeRole<T>(query: (client: Client) => Promise<T>): Promise<T> {
  const url = new URL(required('DATABASE_URL'))
  // schema=platform tells Platform's tools the schema; the queries name it themselves.
  url.searchParams.delete('schema')
  const client = new Client({ connectionString: url.toString() })
  await client.connect()
  try {
    return await query(client)
  } finally {
    await client.end()
  }
}

/** The database clock, so that a fresh revocation is compared with the clock that stamped it. */
function databaseNow(): Promise<number> {
  return asRuntimeRole(async client => (await client.query<{ now: Date }>('SELECT now() AS now')).rows[0].now.getTime())
}

/** The revoked_before that bridge.session_revocations_v1 publishes for a subject, in milliseconds, or null. */
function publishedRevokedBefore(subject: string): Promise<number | null> {
  return asRuntimeRole(async client => {
    const result = await client.query<{ revoked_before: Date }>(
      'SELECT revoked_before FROM bridge.session_revocations_v1 WHERE subject = $1',
      [subject],
    )
    return result.rows.length === 0 ? null : result.rows[0].revoked_before.getTime()
  })
}

test.describe('Studio users in self-hosted mode', () => {
  test("alice revokes bob's Studio sessions and bridge.session_revocations_v1 shows bob with a fresh revoked_before", async ({ page }) => {
    await signInThroughKeycloak(page, FIXTURE_USERS.alice)
    await expect(page).toHaveURL(url => url.pathname === '/connections')

    await page.locator('[data-sidebar="sidebar"]').getByRole('link', { name: 'Studio Users' }).click()
    await expect(page).toHaveURL(url => url.pathname === '/studio-users')
    await expect(page.getByText('A role held only through a composite role is not listed.')).toBeVisible()

    // The fixture realm: alice holds admin directly and grace through group dba; bob holds user directly, dave
    // through group analysts and erin through its subgroup juniors; frank holds user and is disabled; carol holds neither.
    const table = page.getByRole('table')
    for (const username of ['alice', 'grace', 'bob', 'dave', 'erin', 'frank']) {
      await expect(table.getByRole('row', { name: new RegExp(`\\b${username}\\b`) })).toHaveCount(1)
    }
    await expect(table.getByRole('row', { name: /\bcarol\b/ })).toHaveCount(0)
    await expect(table.getByRole('row', { name: /\bgrace\b/ })).toContainText('Admin')
    await expect(table.getByRole('row', { name: /\bfrank\b/ })).toContainText('Disabled')

    await page.getByRole('searchbox', { name: 'Search Studio users' }).fill('bob')
    await page.getByRole('button', { name: 'Search' }).click()
    await expect(page).toHaveURL(url => url.pathname === '/studio-users' && url.searchParams.get('q') === 'bob')
    await expect(table.getByRole('row', { name: /\balice\b/ })).toHaveCount(0)
    const bob = table.getByRole('row', { name: /\bbob\b/ })
    await expect(bob).toContainText('User')

    const before = await databaseNow()
    await bob.getByRole('button', { name: 'Revoke Studio sessions' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('Revoke the Studio sessions of bob?')
    await dialog.getByRole('button', { name: 'Revoke sessions' }).click()
    await expect(page.getByText("bob's Studio sessions are revoked")).toBeVisible()
    await expect(dialog).toHaveCount(0)

    await expect.poll(() => publishedRevokedBefore(FIXTURE_USERS.bob.keycloakId)).toBeGreaterThanOrEqual(before)

    // The revocation names alice as the admin who made it, with the reason admin, and the admin action log records it.
    const recorded = await asRuntimeRole(async client => {
      const result = await client.query<{ reason: string; actor: string; logged: number }>(
        `SELECT r.reason, u."keycloakId" AS actor,
                (SELECT count(*)::int FROM platform.admin_actions a
                  WHERE a.action = 'revocation.create' AND a."targetId" = r.id AND a."actorId" = r."createdById") AS logged
           FROM platform.session_revocations r
           JOIN platform.users u ON u.id = r."createdById"
          WHERE r.subject = $1
          ORDER BY r."revokedBefore" DESC
          LIMIT 1`,
        [FIXTURE_USERS.bob.keycloakId],
      )
      return result.rows
    })
    expect(recorded).toEqual([{ reason: 'admin', actor: FIXTURE_USERS.alice.keycloakId, logged: 1 }])
  })
})
