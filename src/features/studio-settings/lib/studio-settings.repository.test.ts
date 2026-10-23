import { describe, it, expect, vi, beforeEach } from 'vitest'

type Row = Record<string, unknown>

// An in-memory stand-in for platform.studio_settings and platform.admin_actions.
const { db, tables } = vi.hoisted(() => {
  const tables: { studioSetting: Row[]; adminAction: Row[] } = { studioSetting: [], adminAction: [] }
  const db = {
    studioSetting: {
      findUnique: vi.fn(async ({ where }: { where: { key: string } }) =>
        tables.studioSetting.find((row) => row.key === where.key) ?? null),
      upsert: vi.fn(async ({ create }: { create: Row }) => {
        tables.studioSetting = [...tables.studioSetting.filter((row) => row.key !== create.key), create]
        return create
      }),
      deleteMany: vi.fn(async ({ where }: { where: { key: string } }) => {
        tables.studioSetting = tables.studioSetting.filter((row) => row.key !== where.key)
        return { count: 1 }
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

import { StudioSettingsRepository } from './studio-settings.repository'

beforeEach(() => {
  tables.studioSetting = []
  tables.adminAction = []
})

describe('StudioSettingsRepository', () => {
  it('set and reset record the channel their caller names', async () => {
    await StudioSettingsRepository.set('query.timeoutMs', 60000, 'user-alice', 'api')
    await StudioSettingsRepository.reset('query.timeoutMs', 'user-alice', 'api')

    expect(tables.adminAction.map((action) => [action.action, action.channel])).toEqual([
      ['settings.update', 'api'],
      ['settings.reset', 'api'],
    ])
  })
})
