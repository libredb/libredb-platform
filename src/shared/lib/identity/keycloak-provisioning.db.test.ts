import { randomUUID } from 'crypto'
import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { connectSuperuser, fixtureUrl } from '../../../../tests/db/connect'

// Just-in-time provisioning writes platform.users through the shared Prisma client as libredb_platform, the way the
// jwt callback does at a Keycloak sign-in.
describe('provisionKeycloakUser on PostgreSQL', () => {
  let db: typeof import('@/shared/lib/db').db
  let provisionKeycloakUser: typeof import('./keycloak-provisioning').provisionKeycloakUser
  let superuser: Client

  async function usersWithEmail(email: string) {
    const result = await superuser.query<{ id: string; keycloakId: string | null; name: string | null }>(
      `SELECT id, "keycloakId", name FROM platform.users WHERE email = $1`,
      [email],
    )
    return result.rows
  }

  beforeAll(async () => {
    // The shared Prisma client reads DATABASE_URL when its module loads.
    vi.stubEnv('DATABASE_URL', `${fixtureUrl('platform')}?schema=platform`)
    ;({ db } = await import('@/shared/lib/db'))
    ;({ provisionKeycloakUser } = await import('./keycloak-provisioning'))
    superuser = await connectSuperuser()
  })

  afterAll(async () => {
    await db.$disconnect()
    await superuser.end()
    vi.unstubAllEnvs()
  })

  it('concurrent first sign-ins of one account create one user', async () => {
    const sub = randomUUID()
    const email = `first-${sub}@libredb.test`

    const users = await Promise.all(
      Array.from({ length: 8 }, (_, attempt) => provisionKeycloakUser(db, { sub, email, name: `Attempt ${attempt}` })),
    )

    expect(new Set(users.map(user => user.id)).size).toBe(1)
    expect(await usersWithEmail(email)).toEqual([{ id: users[0].id, keycloakId: sub, name: expect.stringMatching(/^Attempt /) }])
  })

  it('a later sign-in with a changed email updates the row of the account and leaves a row with that email alone', async () => {
    const sub = randomUUID()
    const oldEmail = `old-${sub}@libredb.test`
    const newEmail = `new-${sub}@libredb.test`
    const cloudUserId = `cloud_${sub.replace(/-/g, '')}`
    await superuser.query(
      `INSERT INTO platform.users (id, email, name, "updatedAt") VALUES ($1, $2, 'Cloud user', now())`,
      [cloudUserId, newEmail],
    )

    const first = await provisionKeycloakUser(db, { sub, email: oldEmail, name: 'Alice Admin' })
    const second = await provisionKeycloakUser(db, { sub, email: newEmail, name: 'Alice Example' })

    expect(second.id).toBe(first.id)
    expect(await usersWithEmail(oldEmail)).toEqual([])
    const sharing = await usersWithEmail(newEmail)
    expect(sharing).toHaveLength(2)
    expect(sharing).toEqual(expect.arrayContaining([
      { id: cloudUserId, keycloakId: null, name: 'Cloud user' },
      { id: first.id, keycloakId: sub, name: 'Alice Example' },
    ]))
  })
})
