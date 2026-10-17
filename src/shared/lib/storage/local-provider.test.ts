import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { LocalStorageProvider } from './local-provider'

describe('LocalStorageProvider', () => {
  let basePath: string
  let provider: LocalStorageProvider

  beforeEach(async () => {
    basePath = await fs.mkdtemp(path.join(os.tmpdir(), 'local-provider-'))
    provider = new LocalStorageProvider(basePath)
  })

  afterEach(async () => {
    await fs.rm(basePath, { recursive: true, force: true })
  })

  it('getSignedUrl rejects and names download()', async () => {
    await provider.upload('support/t1/file.txt', Buffer.from('secret'), 'text/plain')

    await expect(provider.getSignedUrl('support/t1/file.txt')).rejects.toThrow(
      'local storage has no signed URLs; stream with download()',
    )
  })

  it('download returns the uploaded bytes', async () => {
    await provider.upload('support/t1/file.txt', Buffer.from('secret'), 'text/plain')

    await expect(provider.download('support/t1/file.txt')).resolves.toEqual(Buffer.from('secret'))
  })
})
