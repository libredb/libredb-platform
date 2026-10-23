import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Prisma } from '@prisma/client'

type Row = Record<string, unknown>

const caller = vi.hoisted(() => ({
  id: 'user-alice',
  email: 'alice@libredb.test',
  name: 'Alice',
  currentTenantId: 'tenant-1',
  membershipId: 'member-1',
  roles: ['PLATFORM_ADMIN'],
  permissions: ['settings.view', 'settings.edit'] as string[],
  accessibleTenants: [],
}))

// An in-memory stand-in for the three tables the action touches; $transaction runs its callback on the same tables
// and restores them when the callback throws, as a rolled back transaction would.
const { db, tables } = vi.hoisted(() => {
  const tables: { studioSettingKey: Row[]; studioSetting: Row[]; adminAction: Row[] } = {
    studioSettingKey: [],
    studioSetting: [],
    adminAction: [],
  }
  const db = {
    studioSettingKey: {
      findUnique: vi.fn(async ({ where }: { where: { key: string } }) =>
        tables.studioSettingKey.find((row) => row.key === where.key) ?? null),
    },
    studioSetting: {
      // A copy, as Prisma returns a fresh object, so a later write does not change a row read before it.
      findUnique: vi.fn(async ({ where }: { where: { key: string } }) => {
        const row = tables.studioSetting.find((candidate) => candidate.key === where.key)
        return row ? { ...row } : null
      }),
      upsert: vi.fn(async ({ where, create, update }: { where: { key: string }; create: Row; update: Row }) => {
        const existing = tables.studioSetting.find((row) => row.key === where.key)
        if (existing) return Object.assign(existing, update)
        const row = { ...create }
        tables.studioSetting.push(row)
        return row
      }),
      deleteMany: vi.fn(async ({ where }: { where: { key: string } }) => {
        const kept = tables.studioSetting.filter((row) => row.key !== where.key)
        const count = tables.studioSetting.length - kept.length
        tables.studioSetting = kept
        return { count }
      }),
    },
    adminAction: {
      create: vi.fn(async ({ data }: { data: Row }) => {
        tables.adminAction.push(data)
        return data
      }),
    },
    $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
      const saved = { studioSetting: [...tables.studioSetting], adminAction: [...tables.adminAction] }
      try {
        return await run(db)
      } catch (error) {
        Object.assign(tables, saved)
        throw error
      }
    }),
  }
  return { db, tables }
})

vi.mock('@/shared/lib/db', () => ({ db }))

const requirePermission = vi.hoisted(() =>
  vi.fn(async (user: { permissions: string[] }, permission: string) => {
    if (!user.permissions.includes(permission)) {
      const { ForbiddenError } = await import('@/shared/lib/errors')
      throw new ForbiddenError(permission)
    }
  }),
)

vi.mock('@/shared/lib/auth-utils', () => ({
  getCurrentUser: vi.fn(async () => caller),
  requirePermission,
}))

vi.mock('@/shared/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { updateStudioSetting } from './update-studio-setting'

// The allowlist rows of the generated studio_settings migration that these tests use.
const KEYS: Row[] = [
  { key: 'ai.enabled', valueType: 'boolean', allowedValues: null, minValue: null, maxValue: null, description: 'AI' },
  { key: 'agent.enabled', valueType: 'boolean', allowedValues: null, minValue: null, maxValue: null, description: 'Agent' },
  { key: 'mcp.enabled', valueType: 'boolean', allowedValues: null, minValue: null, maxValue: null, description: 'MCP' },
  { key: 'query.timeoutMs', valueType: 'integer', allowedValues: null, minValue: BigInt(1000), maxValue: BigInt(3600000), description: 'Timeout' },
  {
    key: 'queryLog.statementCapture',
    valueType: 'string',
    allowedValues: ['none', 'redacted', 'full'],
    minValue: null,
    maxValue: null,
    description: 'Capture',
  },
]

beforeEach(() => {
  vi.stubEnv('DEPLOYMENT_MODE', 'self-hosted')
  caller.permissions = ['settings.view', 'settings.edit']
  tables.studioSettingKey = KEYS.map((row) => ({ ...row }))
  tables.studioSetting = []
  tables.adminAction = []
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('updateStudioSetting', () => {
  it('an unknown key is refused', async () => {
    const result = await updateStudioSetting({ key: 'export.maxRows', value: 10 })

    expect(result).toEqual({
      success: false,
      error: 'Validation failed',
      fieldErrors: { key: ['export.maxRows is not an allowlisted Studio setting'] },
    })
    expect(tables.studioSetting).toEqual([])
    expect(tables.adminAction).toEqual([])
  })

  it('a wrong type, an out-of-range integer and a value outside the allowed set are refused with field errors', async () => {
    const cases: [string, unknown, string][] = [
      ['ai.enabled', 'yes', 'must be a boolean'],
      ['query.timeoutMs', '120000', 'must be a whole number'],
      ['query.timeoutMs', 1500.5, 'must be a whole number'],
      ['query.timeoutMs', 999, 'must be between 1000 and 3600000'],
      ['query.timeoutMs', 3600001, 'must be between 1000 and 3600000'],
      ['queryLog.statementCapture', 7, 'must be a string'],
      ['queryLog.statementCapture', 'everything', 'must be one of none, redacted, full'],
    ]

    for (const [key, value, message] of cases) {
      const result = await updateStudioSetting({ key, value: value as never })

      expect(result, `${key} = ${JSON.stringify(value)}`).toEqual({
        success: false,
        error: 'Validation failed',
        fieldErrors: { value: [message] },
      })
    }
    expect(tables.studioSetting).toEqual([])
    expect(tables.adminAction).toEqual([])
  })

  it('requires settings.edit', async () => {
    caller.permissions = ['settings.view']

    const result = await updateStudioSetting({ key: 'query.timeoutMs', value: 120000 })

    expect(result).toEqual({ success: false, error: 'Permission denied: settings.edit' })
    expect(requirePermission).toHaveBeenCalledWith(caller, 'settings.edit')
    expect(tables.studioSetting).toEqual([])
  })

  it('is refused in cloud mode, where no Studio reads the settings', async () => {
    vi.stubEnv('DEPLOYMENT_MODE', 'cloud')

    const result = await updateStudioSetting({ key: 'query.timeoutMs', value: 120000 })

    expect(result).toEqual({ success: false, error: 'Permission denied: not available in cloud mode' })
    expect(tables.studioSetting).toEqual([])
  })

  it('stores the jsonb value with updatedBy and records an admin action', async () => {
    tables.studioSetting = [{ key: 'query.timeoutMs', value: 60000, updatedBy: 'user-bob' }]

    const result = await updateStudioSetting({ key: 'query.timeoutMs', value: 120000 })

    expect(result).toEqual({ success: true, data: { key: 'query.timeoutMs' } })
    expect(db.$transaction).toHaveBeenCalledTimes(1)
    expect(tables.studioSetting).toEqual([{ key: 'query.timeoutMs', value: 120000, updatedBy: 'user-alice' }])
    expect(tables.adminAction).toEqual([
      {
        actorId: 'user-alice',
        channel: 'web',
        action: 'settings.update',
        targetType: 'studio_setting',
        targetId: 'query.timeoutMs',
        before: { value: 60000 },
        after: { value: 120000 },
      },
    ])

    const created = await updateStudioSetting({ key: 'queryLog.statementCapture', value: 'full' })
    expect(created).toEqual({ success: true, data: { key: 'queryLog.statementCapture' } })
    expect(tables.studioSetting).toContainEqual({ key: 'queryLog.statementCapture', value: 'full', updatedBy: 'user-alice' })
    expect(tables.adminAction[1]).toMatchObject({ action: 'settings.update', after: { value: 'full' } })
    expect(tables.adminAction[1].before).toBe(Prisma.DbNull)
  })

  it('refuses agent.enabled and mcp.enabled while they are held', async () => {
    for (const key of ['agent.enabled', 'mcp.enabled']) {
      const result = await updateStudioSetting({ key, value: true })

      expect(result).toEqual({
        success: false,
        error: 'Validation failed',
        fieldErrors: { key: [`${key} is held off in governance mode until MCP and agent governance ship`] },
      })
    }
    expect(tables.studioSetting).toEqual([])
    expect(tables.adminAction).toEqual([])
  })
})
