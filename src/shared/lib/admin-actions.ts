import { Prisma, type AdminActionChannel } from '@prisma/client'

// Keys whose values never reach the admin action log, at any depth.
// readSecret and writeSecret, the sealed connection credentials, match /secret/i.
const SECRET_KEY = /password|secret|credential|token|privateKey/i

// The client recordAdminAction() writes through: the transaction client of the
// change it records, so the log entry commits or rolls back with that change.
export type AdminActionClient = Pick<Prisma.TransactionClient, 'adminAction'>

export interface AdminActionEntry {
  actorId: string
  // `web` for a change made in the web console, `api` for one made through /api/v1.
  channel: AdminActionChannel
  // A lowercase dotted name such as `grant.create`; the database refuses any other form.
  action: string
  targetType: string
  targetId: string
  before?: Prisma.InputJsonValue | null
  after?: Prisma.InputJsonValue | null
}

function withoutSecrets(value: Prisma.InputJsonValue): Prisma.InputJsonValue {
  if (Array.isArray(value)) {
    return value.map((item) => (item === null ? null : withoutSecrets(item)))
  }
  if (typeof value === 'object' && value !== null) {
    const result: Record<string, Prisma.InputJsonValue | null> = {}
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEY.test(key) || item === undefined) continue
      result[key] = item === null ? null : withoutSecrets(item)
    }
    return result
  }
  return value
}

function snapshot(value: Prisma.InputJsonValue | null | undefined) {
  return value === null || value === undefined ? Prisma.DbNull : withoutSecrets(value)
}

// Appends one entry to platform.admin_actions. Every connection, grant, settings
// and revocation change calls it inside its own transaction.
export function recordAdminAction(tx: AdminActionClient, entry: AdminActionEntry) {
  return tx.adminAction.create({
    data: {
      actorId: entry.actorId,
      channel: entry.channel,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      before: snapshot(entry.before),
      after: snapshot(entry.after),
    },
  })
}
