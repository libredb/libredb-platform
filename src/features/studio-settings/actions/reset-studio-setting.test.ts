import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

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
      findUnique: vi.fn(async ({ where }: { where: { key: string } }) =>
        tables.studioSetting.find((row) => row.key === where.key) ?? null),
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
    $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>): Promise<unknown> => run(db)),
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

import { resetStudioSetting } from './reset-studio-setting'

beforeEach(() => {
  vi.stubEnv('DEPLOYMENT_MODE', 'self-hosted')
  caller.permissions = ['settings.view', 'settings.edit']
  tables.studioSettingKey = [
    { key: 'query.timeoutMs', valueType: 'integer', allowedValues: null, minValue: BigInt(1000), maxValue: BigInt(3600000), description: 'Timeout' },
  ]
  tables.studioSetting = [{ key: 'query.timeoutMs', value: 120000, updatedBy: 'user-bob' }]
  tables.adminAction = []
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('resetStudioSetting', () => {
  it('deletes the row so Studio applies its default', async () => {
    const result = await resetStudioSetting({ key: 'query.timeoutMs' })

    expect(result).toEqual({ success: true, data: { key: 'query.timeoutMs' } })
    expect(db.$transaction).toHaveBeenCalledTimes(1)
    expect(tables.studioSetting).toEqual([])
    expect(tables.adminAction).toHaveLength(1)
    expect(tables.adminAction[0]).toMatchObject({
      actorId: 'user-alice',
      channel: 'web',
      action: 'settings.reset',
      targetType: 'studio_setting',
      targetId: 'query.timeoutMs',
      before: { value: 120000 },
    })
  })

  it('records nothing when the key already takes Studio default', async () => {
    tables.studioSetting = []

    const result = await resetStudioSetting({ key: 'query.timeoutMs' })

    expect(result).toEqual({ success: true, data: { key: 'query.timeoutMs' } })
    expect(tables.adminAction).toEqual([])
  })

  it('an unknown key is refused', async () => {
    const result = await resetStudioSetting({ key: 'export.maxRows' })

    expect(result).toEqual({
      success: false,
      error: 'Validation failed',
      fieldErrors: { key: ['export.maxRows is not an allowlisted Studio setting'] },
    })
  })

  it('requires settings.edit', async () => {
    caller.permissions = ['settings.view']

    const result = await resetStudioSetting({ key: 'query.timeoutMs' })

    expect(result).toEqual({ success: false, error: 'Permission denied: settings.edit' })
    expect(tables.studioSetting).toHaveLength(1)
  })
})
