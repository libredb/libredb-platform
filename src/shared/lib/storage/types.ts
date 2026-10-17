export type StorageProviderType = 'LOCAL' | 'AWS' | 'DIGITALOCEAN' | 'MINIO'

export interface IStorageProvider {
  upload(key: string, body: Buffer, contentType: string): Promise<void>
  download(key: string): Promise<Buffer>
  delete(key: string): Promise<void>
  getSignedUrl(key: string, expiresIn?: number): Promise<string>
  exists(key: string): Promise<boolean>
}

export interface StorageConfig {
  provider: StorageProviderType
  local?: { path: string }
  s3?: {
    accessKey: string
    secretKey: string
    endpoint?: string
    region: string
    bucket: string
    keyPrefix?: string
  }
}
