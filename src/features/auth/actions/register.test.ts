import { Prisma } from '@prisma/client'
import bcrypt from 'bcryptjs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// An in-memory platform schema: users and password_credentials, with text compared exactly, as PostgreSQL does.
const store = vi.hoisted(() => ({
  users: [] as { id: string; email: string; name: string }[],
  credentials: new Map<string, { userId: string; email: string; passwordHash: string }>(),
}))

const signIn = vi.hoisted(() => vi.fn())

const tx = vi.hoisted(() => ({
  passwordCredential: {
    findUnique: vi.fn(),
    create: vi.fn(),
  },
  user: { create: vi.fn() },
  tenant: { create: vi.fn() },
  tenantMember: { create: vi.fn() },
  userRole: { create: vi.fn() },
}))

const db = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  planConfig: { findUnique: vi.fn() },
  role: { findFirst: vi.fn() },
  tenant: { findUnique: vi.fn() },
  $transaction: vi.fn(),
}))

vi.mock('@/shared/lib/auth', () => ({ signIn }))
vi.mock('@/shared/lib/db', () => ({ db }))
vi.mock('@/shared/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { registerAction } from './register'

const DUPLICATE = { error: 'An account with this email already exists' }

function uniqueEmailViolation() {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`email`)', {
    code: 'P2002',
    clientVersion: Prisma.prismaVersion.client,
    meta: { modelName: 'PasswordCredential', target: ['email'] },
  })
}

function registration(email: string): FormData {
  const form = new FormData()
  form.set('name', 'Alice Example')
  form.set('email', email)
  form.set('password', 'a long enough password')
  form.set('tenantName', 'Example Org')
  return form
}

describe('registerAction', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('DEPLOYMENT_MODE', 'cloud')
    store.users = []
    store.credentials = new Map()

    db.user.findUnique.mockImplementation(async ({ where }: { where: { email: string } }) =>
      store.users.find(user => user.email === where.email) ?? null)
    db.planConfig.findUnique.mockResolvedValue({ id: 'plan-free' })
    db.role.findFirst.mockResolvedValue({ id: 'role-tenant-admin' })
    db.tenant.findUnique.mockResolvedValue(null)
    db.$transaction.mockImplementation(async (work: (client: typeof tx) => Promise<unknown>) => work(tx))

    tx.passwordCredential.findUnique.mockImplementation(async ({ where }: { where: { email: string } }) =>
      store.credentials.get(where.email) ?? null)
    tx.passwordCredential.create.mockImplementation(async ({ data }: { data: { userId: string; email: string; passwordHash: string } }) => {
      if (store.credentials.has(data.email)) throw uniqueEmailViolation()
      store.credentials.set(data.email, data)
      return data
    })
    tx.user.create.mockImplementation(async ({ data }: { data: { email: string; name: string } }) => {
      const user = { id: `user-${store.users.length + 1}`, email: data.email, name: data.name }
      store.users.push(user)
      return user
    })
    tx.tenant.create.mockResolvedValue({ id: 'tenant-new' })
    tx.tenantMember.create.mockResolvedValue({ id: 'membership-new' })
    tx.userRole.create.mockResolvedValue({})
  })

  it('refuses an email that differs only in case', async () => {
    store.users.push({ id: 'user-alice', email: 'alice@example.com', name: 'Alice' })
    store.credentials.set('alice@example.com', { userId: 'user-alice', email: 'alice@example.com', passwordHash: 'existing-hash' })

    const result = await registerAction({ error: null }, registration('Alice@Example.COM'))

    expect(result).toEqual(DUPLICATE)
    expect(store.users).toHaveLength(1)
    expect(store.credentials.get('alice@example.com')?.passwordHash).toBe('existing-hash')
    expect(signIn).not.toHaveBeenCalled()
  })

  it('creates the user and its password credential under the lower-cased email in one transaction', async () => {
    await registerAction({ error: null }, registration('Bob@Example.com'))

    expect(db.$transaction).toHaveBeenCalledTimes(1)
    expect(store.users).toEqual([{ id: 'user-1', email: 'bob@example.com', name: 'Alice Example' }])
    expect(tx.user.create.mock.calls[0][0].data).not.toHaveProperty('passwordHash')

    const credential = store.credentials.get('bob@example.com')
    expect(credential?.userId).toBe('user-1')
    expect(await bcrypt.compare('a long enough password', credential!.passwordHash)).toBe(true)

    expect(tx.tenantMember.create).toHaveBeenCalledWith({
      data: { tenantId: 'tenant-new', userId: 'user-1', isDefault: true, active: true },
    })
    expect(signIn).toHaveBeenCalledWith('credentials', {
      email: 'bob@example.com',
      password: 'a long enough password',
      redirectTo: '/',
    })
  })

  it('answers that the account exists when a concurrent registration takes the email first', async () => {
    // The check inside the transaction ran before the other registration committed; the unique email decides.
    tx.passwordCredential.findUnique.mockResolvedValueOnce(null)
    store.credentials.set('carol@example.com', { userId: 'user-carol', email: 'carol@example.com', passwordHash: 'winner-hash' })

    const result = await registerAction({ error: null }, registration('carol@example.com'))

    expect(result).toEqual(DUPLICATE)
    expect(store.credentials.get('carol@example.com')?.passwordHash).toBe('winner-hash')
    expect(signIn).not.toHaveBeenCalled()
  })

  it('self-hosted: returns Registration is disabled without a database call', async () => {
    vi.stubEnv('DEPLOYMENT_MODE', 'self-hosted')

    const result = await registerAction({ error: null }, registration('dave@example.com'))

    expect(result).toEqual({ error: 'Registration is disabled' })
    for (const call of [db.user.findUnique, db.planConfig.findUnique, db.role.findFirst, db.tenant.findUnique, db.$transaction]) {
      expect(call).not.toHaveBeenCalled()
    }
    expect(signIn).not.toHaveBeenCalled()
  })
})
