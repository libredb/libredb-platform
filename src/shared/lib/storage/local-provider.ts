import fs from 'fs/promises'
import path from 'path'
import type { IStorageProvider } from './types'

export class LocalStorageProvider implements IStorageProvider {
  constructor(private basePath: string) {}

  private resolvePath(key: string): string {
    // The base path is runtime data (STORAGE_LOCAL_PATH). Without turbopackIgnore, the output tracing of `next build`
    // takes these dynamic paths for files of this directory and copies its sources into the standalone server.
    const resolved = path.resolve(/* turbopackIgnore: true */ this.basePath, key)
    if (!resolved.startsWith(path.resolve(/* turbopackIgnore: true */ this.basePath))) {
      throw new Error('Path traversal detected')
    }
    return resolved
  }

  async upload(key: string, body: Buffer, _contentType: string): Promise<void> {
    const filePath = this.resolvePath(key)
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, body)
  }

  async download(key: string): Promise<Buffer> {
    return fs.readFile(this.resolvePath(key))
  }

  async delete(key: string): Promise<void> {
    await fs.unlink(this.resolvePath(key)).catch(() => {})
  }

  async getSignedUrl(_key: string): Promise<string> {
    throw new Error('local storage has no signed URLs; stream with download()')
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fs.access(this.resolvePath(key))
      return true
    } catch {
      return false
    }
  }
}
