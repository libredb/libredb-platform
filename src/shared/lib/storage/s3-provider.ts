import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type { IStorageProvider, StorageConfig } from './types'

export class S3StorageProvider implements IStorageProvider {
  private client: S3Client
  private bucket: string
  private keyPrefix: string

  constructor(config: NonNullable<StorageConfig['s3']>) {
    this.bucket = config.bucket
    this.keyPrefix = config.keyPrefix ?? ''
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      credentials: {
        accessKeyId: config.accessKey,
        secretAccessKey: config.secretKey,
      },
      forcePathStyle: !!config.endpoint,
    })
  }

  private fullKey(key: string): string {
    return this.keyPrefix ? `${this.keyPrefix}${key}` : key
  }

  async upload(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: this.fullKey(key),
      Body: body,
      ContentType: contentType,
    }))
  }

  async download(key: string): Promise<Buffer> {
    const response = await this.client.send(new GetObjectCommand({
      Bucket: this.bucket,
      Key: this.fullKey(key),
    }))
    return Buffer.from(await response.Body!.transformToByteArray())
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: this.fullKey(key),
    }))
  }

  async getSignedUrl(key: string, expiresIn = 604800): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: this.fullKey(key) }),
      { expiresIn },
    )
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: this.fullKey(key),
      }))
      return true
    } catch {
      return false
    }
  }
}
