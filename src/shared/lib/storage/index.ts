import type { IStorageProvider, StorageConfig, StorageProviderType } from './types'
import { LocalStorageProvider } from './local-provider'
import { S3StorageProvider } from './s3-provider'
import { randomUUID } from 'crypto'

export type { IStorageProvider, StorageConfig }

function getConfig(): StorageConfig {
  const provider = (process.env.STORAGE_PROVIDER ?? 'LOCAL') as StorageProviderType
  return {
    provider,
    local: { path: process.env.STORAGE_LOCAL_PATH ?? './uploads' },
    s3: process.env.STORAGE_S3_ACCESS_KEY ? {
      accessKey: process.env.STORAGE_S3_ACCESS_KEY,
      secretKey: process.env.STORAGE_S3_SECRET_KEY!,
      endpoint: process.env.STORAGE_S3_ENDPOINT,
      region: process.env.STORAGE_S3_REGION ?? 'us-east-1',
      bucket: process.env.STORAGE_S3_BUCKET ?? 'libredb-uploads',
      keyPrefix: process.env.STORAGE_S3_KEY_PREFIX,
    } : undefined,
  }
}

let storageInstance: IStorageProvider | null = null

export function getStorage(): IStorageProvider {
  if (storageInstance) return storageInstance

  const config = getConfig()
  switch (config.provider) {
    case 'LOCAL':
      storageInstance = new LocalStorageProvider(config.local!.path)
      break
    case 'AWS':
    case 'DIGITALOCEAN':
    case 'MINIO':
      if (!config.s3) throw new Error('S3 configuration required')
      storageInstance = new S3StorageProvider(config.s3)
      break
    default:
      throw new Error(`Unknown storage provider: ${config.provider}`)
  }
  return storageInstance
}

export function generateStorageKey(
  tenantId: string,
  domain: string,
  entityId: string,
  ext: string,
): string {
  const timestamp = Date.now()
  const uuid = randomUUID().split('-')[0]
  return `${tenantId}/${domain}/${entityId}/${timestamp}_${uuid}.${ext}`
}
