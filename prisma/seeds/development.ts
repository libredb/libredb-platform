import { createHash, randomUUID } from 'crypto'
import { Client } from 'pg'
import { PrismaClient, type Prisma } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import bcrypt from 'bcryptjs'

import { TENANTS } from './data/tenants'
import { PLATFORM_USERS, TENANT_USERS, type SeedUser } from './data/users'
import { CONNECTIONS } from './data/connections'
import { QUERY_EVENTS } from './data/query-events'
import { TICKETS } from './data/tickets'
import { SHARED_QUERIES } from './data/shared-queries'
import { USER_ACHIEVEMENTS } from './data/achievements'
import { SYSTEM_ROLES } from '../../src/shared/lib/permissions'
import { ConfigError } from '../../src/shared/lib/errors'
import { sealSecret } from '../../src/shared/lib/sealing/lsb1'
import { parseSealPublicKey, type SealKey } from '../../src/shared/lib/sealing/seal-key'
import { developmentSealKeyPair } from '../../scripts/dev/gen-seal-keypair.mjs'

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! })
const db = new PrismaClient({ adapter })

export async function seedDevelopment() {
  console.log('Seeding development data...')

  // Every seeded user signs in with SEED_USER_PASSWORD, and no default password exists.
  const password = process.env.SEED_USER_PASSWORD
  if (!password) throw new ConfigError('SEED_USER_PASSWORD is required for the development seed')
  // The sample query events go in as Studio writes them: as libredb_studio, through bridge.query_events_v1.
  const studioDatabaseUrl = process.env.SEED_STUDIO_DATABASE_URL
  if (!studioDatabaseUrl) {
    throw new ConfigError('SEED_STUDIO_DATABASE_URL, the libredb_studio URL, is required for the development seed')
  }
  const passwordHash = await bcrypt.hash(password, 12)

  // ─── Tenants ───────────────────────────────────────────
  const tenantMap = new Map<string, string>() // slug -> id

  for (const t of TENANTS) {
    const plan = await db.planConfig.findUnique({ where: { code: t.planCode } })
    if (!plan) throw new Error(`Plan ${t.planCode} not found: run production seed first`)

    const tenant = await db.tenant.upsert({
      where: { slug: t.slug },
      update: { name: t.name, settings: t.settings as object, planConfigId: plan.id },
      create: { name: t.name, slug: t.slug, settings: t.settings as object, planConfigId: plan.id },
    })
    tenantMap.set(t.slug, tenant.id)
  }
  console.log('  - Tenants (3)')

  // ─── Subscriptions ────────────────────────────────────
  for (const t of TENANTS) {
    const tenantId = tenantMap.get(t.slug)!
    const existing = await db.subscription.findUnique({ where: { tenantId } })
    if (!existing) {
      await db.subscription.create({
        data: {
          tenantId,
          status: 'active',
          currentPeriodStart: new Date(),
          currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
      })
    }
  }
  console.log('  - Subscriptions')

  // ─── Users & Memberships ──────────────────────────────
  const userMap = new Map<string, string>() // email -> id
  const membershipMap = new Map<string, string>() // `${email}:${tenantSlug}` -> membershipId

  // Platform users
  for (const u of PLATFORM_USERS) {
    const userId = await upsertPasswordUser(u, passwordHash)
    userMap.set(u.email, userId)

    // Assign platform role
    const roleCode = u.email === 'admin@libredb.example' ? SYSTEM_ROLES.PLATFORM_ADMIN : SYSTEM_ROLES.PLATFORM_TECH
    await assignPlatformRole(userId, roleCode)
  }
  console.log('  - Platform users (2)')

  // Tenant users
  for (const u of TENANT_USERS) {
    const userId = await upsertPasswordUser(u, passwordHash, {
      lastLoginAt: new Date(Date.now() - Math.floor(Math.random() * 7) * 24 * 60 * 60 * 1000),
    })
    userMap.set(u.email, userId)

    // Create memberships
    for (const m of u.memberships) {
      const tenantId = tenantMap.get(m.tenantSlug)
      if (!tenantId) continue

      const membership = await db.tenantMember.upsert({
        where: { tenantId_userId: { tenantId, userId } },
        update: { isDefault: m.isDefault, active: true },
        create: { tenantId, userId, isDefault: m.isDefault, active: true },
      })
      membershipMap.set(`${u.email}:${m.tenantSlug}`, membership.id)

      // Assign tenant role
      const role = await db.role.findFirst({ where: { code: m.roleCode, isSystem: true } })
      if (role) {
        const existing = await db.userRole.findFirst({
          where: { membershipId: membership.id, roleId: role.id },
        })
        if (!existing) {
          await db.userRole.create({ data: { membershipId: membership.id, roleId: role.id } })
        }
      }
    }
  }
  console.log('  - Tenant users (12) with memberships')

  // ─── Connections ──────────────────────────────────────
  const connectionMap = await seedConnections(tenantMap, userMap)
  console.log(`  - Database connections (${CONNECTIONS.length}) sealed to the development seal key`)

  // ─── Grants ───────────────────────────────────────────
  await seedGrants(connectionMap, userMap)
  console.log(`  - Grants of ${SEED_GRANTEES.map((g) => g.username).join(' and ')} on the ${CONNECTIONS.length} connections`)

  // ─── Sample Query Events ──────────────────────────────
  await seedQueryEvents(studioDatabaseUrl, connectionMap)
  console.log(`  - Sample query events (${QUERY_EVENTS.length})`)

  // ─── Support Tickets ──────────────────────────────────
  let ticketNum = 1000
  for (const t of TICKETS) {
    ticketNum++
    const tenantId = tenantMap.get(t.tenantSlug)!
    const createdByUserId = userMap.get(t.createdByEmail)!
    const assignedToUserId = t.assignedToEmail ? userMap.get(t.assignedToEmail) : undefined

    const createdAt = new Date()
    createdAt.setDate(createdAt.getDate() - t.daysAgo)

    const ticketNumber = `TK-${ticketNum}`
    // Ticket numbers are unique per tenant, not globally (@@unique([tenantId, ticketNumber])): lookup by both parts.
    let ticket = await db.supportTicket.findUnique({
      where: { tenantId_ticketNumber: { tenantId, ticketNumber } },
    })
    if (!ticket) {
      ticket = await db.supportTicket.create({
        data: {
          tenantId,
          ticketNumber,
          subject: t.subject,
          description: t.description,
          status: t.status,
          priority: t.priority,
          category: t.category,
          createdByUserId,
          assignedToUserId: assignedToUserId ?? null,
          resolvedAt: t.status === 'RESOLVED' || t.status === 'CLOSED' ? new Date() : null,
          closedAt: t.status === 'CLOSED' ? new Date() : null,
          createdAt,
        },
      })
    }

    // Messages
    for (const msg of t.messages) {
      const senderUserId = userMap.get(msg.senderEmail)!
      const msgCreatedAt = new Date(createdAt.getTime() + msg.hoursAfterCreation * 60 * 60 * 1000)

      // Check if message already exists (idempotency by content+sender+ticket)
      const existingMsg = await db.supportMessage.findFirst({
        where: { ticketId: ticket.id, senderUserId, content: msg.content },
      })
      if (!existingMsg) {
        await db.supportMessage.create({
          data: {
            ticketId: ticket.id,
            senderUserId,
            content: msg.content,
            isInternal: msg.isInternal,
            createdAt: msgCreatedAt,
          },
        })
      }
    }
  }
  console.log('  - Support tickets (6) with messages')

  // ─── Shared Queries ───────────────────────────────────
  for (const sq of SHARED_QUERIES) {
    const tenantId = tenantMap.get(sq.tenantSlug)!
    const connectionId = connectionMap.get(`${sq.tenantSlug}:${sq.connectionName}`)
    const createdByUserId = userMap.get(sq.createdByEmail)!

    const existing = await db.sharedQuery.findFirst({
      where: { tenantId, name: sq.name },
    })
    if (!existing) {
      await db.sharedQuery.create({
        data: {
          tenantId,
          name: sq.name,
          description: sq.description,
          sql: sq.sql,
          connectionId: connectionId ?? null,
          createdByUserId,
        },
      })
    }
  }
  console.log('  - Shared queries (6)')

  // ─── User Achievements ────────────────────────────────
  for (const ua of USER_ACHIEVEMENTS) {
    const userId = userMap.get(ua.userEmail)
    if (!userId) continue

    const achievement = await db.achievement.findUnique({ where: { code: ua.achievementCode } })
    if (!achievement) continue

    await db.userAchievement.upsert({
      where: { userId_achievementId: { userId, achievementId: achievement.id } },
      update: {
        progress: ua.progress,
        unlockedAt: ua.unlocked ? new Date() : null,
      },
      create: {
        userId,
        achievementId: achievement.id,
        progress: ua.progress,
        unlockedAt: ua.unlocked ? new Date() : null,
      },
    })
  }
  console.log('  - User achievements')

  // ─── User Streaks ─────────────────────────────────────
  const streakData = [
    { email: 'sarah.chen@acme.com', current: 7, longest: 12, totalDays: 28 },
    { email: 'james.wilson@acme.com', current: 5, longest: 9, totalDays: 22 },
    { email: 'maria.garcia@acme.com', current: 3, longest: 5, totalDays: 14 },
    { email: 'tom.reed@startuplabs.io', current: 2, longest: 6, totalDays: 15 },
    { email: 'dev@example.com', current: 1, longest: 3, totalDays: 8 },
  ]
  for (const s of streakData) {
    const userId = userMap.get(s.email)
    if (!userId) continue
    await db.userStreak.upsert({
      where: { userId },
      update: {
        currentStreak: s.current,
        longestStreak: s.longest,
        lastActiveDate: new Date(),
        totalActiveDays: s.totalDays,
      },
      create: {
        userId,
        currentStreak: s.current,
        longestStreak: s.longest,
        lastActiveDate: new Date(),
        totalActiveDays: s.totalDays,
      },
    })
  }
  console.log('  - User streaks')

  // ─── Notifications (sample) ───────────────────────────
  const notificationUsers = ['sarah.chen@acme.com', 'james.wilson@acme.com', 'tom.reed@startuplabs.io']
  for (const email of notificationUsers) {
    const userId = userMap.get(email)!
    const membership = [...membershipMap.entries()].find(([key]) => key.startsWith(`${email}:`))
    const tenantId = membership ? tenantMap.get(membership[0].split(':')[1]) : undefined

    await db.notification.create({
      data: {
        userId,
        tenantId: tenantId ?? null,
        type: 'SUCCESS',
        title: 'Achievement Unlocked: First Query',
        message: 'Execute your first query',
        link: '/profile',
        read: true,
        createdAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      },
    })
    await db.notification.create({
      data: {
        userId,
        tenantId: tenantId ?? null,
        type: 'INFO',
        title: 'Welcome to LibreDB Platform',
        message: 'Get started by connecting your first database.',
        link: '/connections',
        read: false,
      },
    })
  }
  console.log('  - Sample notifications')

  // ─── Support Phase 1 Fixtures ──────────────────────────
  await seedSupportPhase1(tenantMap, userMap)

  console.log('Development seed complete')
}

// ─── Support Phase 1 ─────────────────────────────────────

// The fixtures are tickets of two customers, each in their own tenant, answered by a platform staff member. They are
// named here, because the first tenant by creation date is the "LibreDB Platform" tenant of the production seed.
const SUPPORT_FIXTURE_PEOPLE = {
  customer1: { tenantSlug: 'acme-corp', email: 'sarah.chen@acme.com' },
  customer2: { tenantSlug: 'startup-labs', email: 'tom.reed@startuplabs.io' },
  agentEmail: 'admin@libredb.example',
} as const

async function seedSupportPhase1(tenantMap: Map<string, string>, userMap: Map<string, string>) {
  const seeded = (map: Map<string, string>, key: string): string => {
    const id = map.get(key)
    if (!id) throw new Error(`Support Phase 1 fixtures: ${key} is not seeded`)
    return id
  }
  const { customer1, customer2, agentEmail } = SUPPORT_FIXTURE_PEOPLE
  const tenant1Id = seeded(tenantMap, customer1.tenantSlug)
  const customer1Id = seeded(userMap, customer1.email)
  const tenant2Id = seeded(tenantMap, customer2.tenantSlug)
  const customer2Id = seeded(userMap, customer2.email)
  const agentId = seeded(userMap, agentEmail)

  // Avoid duplicate re-seed
  const existing = await db.supportTicket.findUnique({
    where: { tenantId_ticketNumber: { tenantId: tenant1Id, ticketNumber: 'TKT-SEED-001' } },
  })
  if (existing) {
    console.log('  - Support Phase 1 fixtures already present')
    return
  }

  const bugTag = await db.supportTag.findFirst({ where: { name: 'bug', tenantId: null } })
  const billingTag = await db.supportTag.findFirst({ where: { name: 'billing', tenantId: null } })

  // Ticket 1: URGENT OPEN with messages + activity + bug tag
  const t1 = await db.supportTicket.create({
    data: {
      tenantId: tenant1Id,
      ticketNumber: 'TKT-SEED-001',
      subject: 'Database unreachable',
      descriptionRich: '<p>I have not been able to connect since this morning, and I get an <strong>ETIMEDOUT</strong> error.</p>',
      descriptionPlain: 'I have not been able to connect since this morning, and I get an ETIMEDOUT error.',
      status: 'OPEN',
      priority: 'URGENT',
      category: 'TECHNICAL',
      createdByUserId: customer1Id,
      assignedToUserId: agentId,
      lastActivityAt: new Date(),
    },
  })

  await db.supportMessage.create({
    data: {
      ticketId: t1.id,
      senderUserId: customer1Id,
      bodyRich: '<p>I have not been able to connect since this morning.</p>',
      bodyPlain: 'I have not been able to connect since this morning.',
      isInternal: false,
    },
  })

  await db.supportMessage.create({
    data: {
      ticketId: t1.id,
      senderUserId: agentId,
      bodyRich: '<p>Hello, I am looking into it right away. Could you share the connection string?</p>',
      bodyPlain: 'Hello, I am looking into it right away. Could you share the connection string?',
      isInternal: false,
    },
  })

  if (bugTag) {
    await db.supportTicketTag.create({
      data: { ticketId: t1.id, tagId: bugTag.id, createdByUserId: agentId },
    })
  }

  await db.supportActivity.create({
    data: {
      ticketId: t1.id,
      actorUserId: agentId,
      type: 'ASSIGNED',
      metadata: { toUserId: agentId },
    },
  })

  // Ticket 2: RESOLVED with CSAT 5-star rating + billing tag
  const t2 = await db.supportTicket.create({
    data: {
      tenantId: tenant1Id,
      ticketNumber: 'TKT-SEED-002',
      subject: 'Billing period change',
      descriptionRich: '<p>I would like to switch from monthly to yearly billing.</p>',
      descriptionPlain: 'I would like to switch from monthly to yearly billing.',
      status: 'RESOLVED',
      priority: 'MEDIUM',
      category: 'BILLING',
      createdByUserId: customer1Id,
      assignedToUserId: agentId,
      resolvedAt: new Date(Date.now() - 24 * 3600_000),
      firstResponseAt: new Date(Date.now() - 48 * 3600_000),
      satisfactionRating: 5,
      satisfactionComment: 'Thanks for the quick reply',
      satisfactionAt: new Date(),
      lastActivityAt: new Date(Date.now() - 24 * 3600_000),
    },
  })

  if (billingTag) {
    await db.supportTicketTag.create({
      data: { ticketId: t2.id, tagId: billingTag.id, createdByUserId: agentId },
    })
  }

  // Ticket 3: HIGH IN_PROGRESS on tenant2
  await db.supportTicket.create({
    data: {
      tenantId: tenant2Id,
      ticketNumber: 'TKT-SEED-003',
      subject: 'AI query suggestions not working',
      descriptionRich: '<p>It gives no suggestions when I inspect the schema.</p>',
      descriptionPlain: 'It gives no suggestions when I inspect the schema.',
      status: 'IN_PROGRESS',
      priority: 'HIGH',
      category: 'TECHNICAL',
      createdByUserId: customer2Id,
      lastActivityAt: new Date(Date.now() - 2 * 3600_000),
    },
  })

  console.log('  - Support Phase 1 fixtures (3 tickets)')
}

// ─── Helpers ──────────────────────────────────────────────

// A seeded user signs in through a password credential under its email, which the seed data keeps in lower case.
// A later run finds the user through that credential and resets the name, the flags and the password hash.
async function upsertPasswordUser(
  u: SeedUser,
  passwordHash: string,
  createOnly: { lastLoginAt?: Date } = {},
): Promise<string> {
  const credential = await db.passwordCredential.findUnique({
    where: { email: u.email },
    select: { userId: true },
  })
  if (credential) {
    await db.user.update({
      where: { id: credential.userId },
      data: { name: u.name, active: true, emailVerified: true, passwordCredential: { update: { passwordHash } } },
    })
    return credential.userId
  }

  const user = await db.user.create({
    data: {
      email: u.email,
      name: u.name,
      active: true,
      emailVerified: true,
      ...createOnly,
      passwordCredential: { create: { email: u.email, passwordHash } },
    },
  })
  return user.id
}

async function assignPlatformRole(userId: string, roleCode: string) {
  // Platform users need a "virtual" membership to hold their role.
  // We find or create a membership for the first tenant, but for platform roles
  // we just assign the role directly without a tenant membership.
  const role = await db.role.findFirst({ where: { code: roleCode, isSystem: true } })
  if (!role) return

  // Platform users don't belong to tenants. Check if they already have the role
  // via any membership. If no membership exists, we skip (platform roles are
  // checked differently in the auth layer).
}

// ─── Connections and query events ────────────────────────

/** The development seal key of scripts/dev/gen-seal-keypair.mjs, whose private key a development Studio holds. */
function developmentSealKey(): SealKey {
  const key = parseSealPublicKey(developmentSealKeyPair().publicKey)
  if (key === null) throw new Error('scripts/dev/gen-seal-keypair.mjs printed a public key that is not a seal key')
  return key
}

// Creates each development connection that its tenant does not have yet, under an id generated before sealing, because
// the AAD of each envelope binds the id with the engine and the definition. An existing connection is kept as it is.
// Returns the ids by `${tenantSlug}:${name}`.
async function seedConnections(
  tenantMap: Map<string, string>,
  userMap: Map<string, string>,
): Promise<Map<string, string>> {
  const key = developmentSealKey()
  const connectionMap = new Map<string, string>()

  for (const c of CONNECTIONS) {
    const tenantId = tenantMap.get(c.tenantSlug)
    if (!tenantId) throw new Error(`Connection ${c.name}: tenant ${c.tenantSlug} is not seeded`)
    const createdById = userMap.get(c.createdByEmail)
    if (!createdById) throw new Error(`Connection ${c.name}: user ${c.createdByEmail} is not seeded`)

    const existing = await db.databaseConnection.findFirst({
      where: { tenantId, name: c.name, deletedAt: null },
      select: { id: true },
    })
    if (existing) {
      connectionMap.set(`${c.tenantSlug}:${c.name}`, existing.id)
      continue
    }

    const id = randomUUID()
    const binding = { connectionId: id, engine: c.engine, definition: c.definition }
    await db.databaseConnection.create({
      data: {
        id,
        tenantId,
        name: c.name,
        engine: c.engine,
        environment: c.environment,
        definition: c.definition as Prisma.InputJsonObject,
        readSecret: sealSecret({ ...binding, level: 'read', plaintext: c.readCredential }, key.publicKey),
        writeSecret: c.writeCredential
          ? sealSecret({ ...binding, level: 'write', plaintext: c.writeCredential }, key.publicKey)
          : null,
        createdById,
      },
    })
    connectionMap.set(`${c.tenantSlug}:${c.name}`, id)
  }
  return connectionMap
}

/**
 * The users of the fixture realm tests/fixtures/keycloak/libredb-test-realm.json that the seed grants on every development
 * connection, keyed by their fixed Keycloak ids: alice, a LibreDB admin, writes where the connection has a
 * write credential and reads elsewhere, and bob, a LibreDB user, reads.
 */
const SEED_GRANTEES = [
  { subject: '00000000-0000-4000-8000-00000000a11c', username: 'alice', email: 'alice@libredb.test', level: 'write' },
  { subject: '00000000-0000-4000-8000-000000000b0b', username: 'bob', email: 'bob@libredb.test', level: 'read' },
] as const

// Grants each fixture user on each development connection, set by the user who created the connection, so Studio
// signed in through the fixture realm lists the connections. A grant that exists is set again to the same
// values, so a second run keeps its grant time.
async function seedGrants(connectionMap: Map<string, string>, userMap: Map<string, string>) {
  for (const c of CONNECTIONS) {
    const connectionId = connectionMap.get(`${c.tenantSlug}:${c.name}`)
    if (!connectionId) throw new Error(`Grant: connection ${c.tenantSlug}:${c.name} is not seeded`)
    const grantedById = userMap.get(c.createdByEmail)
    if (!grantedById) throw new Error(`Grant: user ${c.createdByEmail} is not seeded`)

    for (const grantee of SEED_GRANTEES) {
      const fields = {
        subjectUsername: grantee.username,
        subjectEmail: grantee.email,
        level: grantee.level === 'write' && c.writeCredential ? 'write' : 'read',
        expiresAt: null,
        grantedById,
      } as const
      const key = { connectionId, subjectKind: 'user', subject: grantee.subject }
      await db.connectionGrant.upsert({
        where: { connectionId_subjectKind_subject: key },
        create: { ...key, ...fields },
        update: fields,
      })
    }
  }
}

/** A UUID that the connection id and the position of the event fix, so a second run conflicts instead of duplicating. */
function sampleEventId(connectionId: string, index: number): string {
  const hex = createHash('sha256').update(`libredb-seed-event:${connectionId}:${index}`).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

// Inserts the sample events as libredb_studio through bridge.query_events_v1 with ON CONFLICT DO NOTHING, as Studio's
// sink does. Each carries the bare id of its connection, which joins platform.database_connections.
async function seedQueryEvents(studioDatabaseUrl: string, connectionMap: Map<string, string>) {
  const studio = new Client({ connectionString: studioDatabaseUrl })
  await studio.connect()
  try {
    for (const [index, e] of QUERY_EVENTS.entries()) {
      const connectionId = connectionMap.get(`${e.tenantSlug}:${e.connectionName}`)
      if (!connectionId) {
        throw new Error(`Query event ${index}: connection ${e.tenantSlug}:${e.connectionName} is not seeded`)
      }
      const connection = CONNECTIONS.find((c) => c.tenantSlug === e.tenantSlug && c.name === e.connectionName)!
      const startedAt = new Date(Date.now() - e.minutesAgo * 60_000)
      const finishedAt = new Date(startedAt.getTime() + e.durationMs)
      const fingerprint = e.statement === null ? null : createHash('sha256').update(e.statement).digest('hex')

      await studio.query(
        `INSERT INTO "bridge".query_events_v1 (event_id, started_at, finished_at, studio_instance, subject, username,
           session_role, connection_id, connection_name, engine, access_level, source, statement_type,
           statement_capture, statement, statement_fingerprint, row_count, duration_ms, status, error_code)
         VALUES ($1, $2, $3, 'libredb-studio', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
         ON CONFLICT DO NOTHING`,
        [
          sampleEventId(connectionId, index),
          startedAt,
          finishedAt,
          e.subject,
          e.username,
          e.sessionRole,
          connectionId,
          e.connectionName,
          connection.engine,
          e.accessLevel,
          e.source,
          e.statementType,
          e.statementCapture,
          e.statement,
          fingerprint,
          e.rowCount,
          e.durationMs,
          e.status,
          e.errorCode ?? null,
        ],
      )
    }
  } finally {
    await studio.end()
  }
}
