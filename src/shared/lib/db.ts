import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

// An explicit pool size and client timeouts: one replica holds these 10 connections plus the scheduler lock pool
// (src/shared/lib/jobs/lock-pool.ts, same timeouts), the budget that docs/deploy/platform-runtime.md counts.
const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL!,
  max: 10,
  connectionTimeoutMillis: 5_000,
  query_timeout: 30_000,
  keepAlive: true,
})
export const db = globalForPrisma.prisma ?? new PrismaClient({
  adapter,
  log: process.env.NODE_ENV === 'development'
    ? ['query', 'error', 'warn']
    : ['error'],
})

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = db
}

export function createTenantClient(tenantId: string) {
  return db.$extends({
    query: {
      $allModels: {
        async findMany({ args, query }) {
          args.where = { ...args.where, tenantId }
          return query(args)
        },
        async findFirst({ args, query }) {
          args.where = { ...args.where, tenantId }
          return query(args)
        },
        async findUnique({ args, query }) {
          return query(args)
        },
        async create({ args, query }) {
          args.data = { ...args.data, tenantId } as typeof args.data
          return query(args)
        },
        async update({ args, query }) {
          args.where = { ...args.where, tenantId } as typeof args.where
          return query(args)
        },
        async delete({ args, query }) {
          args.where = { ...args.where, tenantId } as typeof args.where
          return query(args)
        },
        async count({ args, query }) {
          args.where = { ...args.where, tenantId }
          return query(args)
        },
      },
    },
  })
}

export type TenantPrismaClient = ReturnType<typeof createTenantClient>
