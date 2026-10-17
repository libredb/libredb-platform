import { describe, it, expect, vi, beforeEach } from 'vitest'

const findUnique = vi.fn()
const download = vi.fn()
const getSignedUrl = vi.fn()

vi.mock('@/shared/lib/auth-utils', () => ({
  requireAuth: vi.fn().mockResolvedValue({
    id: 'user-1',
    email: 'user@acme.com',
    name: 'User',
    currentTenantId: 'tenant-1',
    membershipId: 'member-1',
    roles: ['TENANT_MEMBER'],
    permissions: [],
    accessibleTenants: [],
  }),
}))

vi.mock('@/shared/lib/db', () => ({
  db: { supportAttachment: { findUnique: (...args: unknown[]) => findUnique(...args) } },
}))

vi.mock('@/shared/lib/storage', () => ({
  getStorage: () => ({ download, getSignedUrl }),
}))

vi.mock('@/features/support/lib/support-permissions', () => ({
  canViewTicket: vi.fn().mockReturnValue(true),
}))

import { GET } from './route'

describe('GET /support/api/attachments/[id]/download', () => {
  beforeEach(() => {
    findUnique.mockReset()
    download.mockReset()
    getSignedUrl.mockReset()
    findUnique.mockResolvedValue({
      id: 'att-1',
      storageKey: 'support/tenant-1/abc-report.txt',
      fileName: 'report.txt',
      mimeType: 'text/plain',
      message: {
        isInternal: false,
        ticket: { tenantId: 'tenant-1', createdByUserId: 'user-1', assignedToUserId: null },
      },
    })
  })

  it('streams the attachment through download() when the provider has no signed URL', async () => {
    getSignedUrl.mockRejectedValue(new Error('local storage has no signed URLs; stream with download()'))
    download.mockResolvedValue(Buffer.from('attachment bytes'))

    const res = await GET(new Request('http://localhost/support/api/attachments/att-1/download'), {
      params: Promise.resolve({ id: 'att-1' }),
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/plain')
    expect(res.headers.get('Location')).toBeNull()
    expect(await res.text()).toBe('attachment bytes')
    expect(download).toHaveBeenCalledWith('support/tenant-1/abc-report.txt')
  })

  it('redirects to an absolute signed URL', async () => {
    getSignedUrl.mockResolvedValue('https://bucket.example.com/support/tenant-1/abc-report.txt?sig=1')

    const res = await GET(new Request('http://localhost/support/api/attachments/att-1/download'), {
      params: Promise.resolve({ id: 'att-1' }),
    })

    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('https://bucket.example.com/support/tenant-1/abc-report.txt?sig=1')
    expect(download).not.toHaveBeenCalled()
  })
})
