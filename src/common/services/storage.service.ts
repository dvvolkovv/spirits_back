// src/common/services/storage.service.ts
import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { Readable } from 'stream';

export interface UploadInput {
  bucket: string;
  key: string;
  body: Buffer | Readable;
  contentType?: string;
  cacheControl?: string;
}

export interface DownloadInput {
  bucket: string;
  key: string;
}

export interface DeleteInput {
  bucket: string;
  key: string;
}

export interface ListInput {
  bucket: string;
  prefix?: string;
  maxKeys?: number;
}

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private s3!: S3Client;
  private publicBaseUrl!: string;

  onModuleInit(): void {
    const endpoint = process.env.MINIO_ENDPOINT;
    const accessKey = process.env.MINIO_ACCESS_KEY;
    const secretKey = process.env.MINIO_SECRET_KEY;
    const publicUrl = process.env.MINIO_PUBLIC_URL;

    if (!endpoint || !accessKey || !secretKey || !publicUrl) {
      throw new Error(
        'StorageService: MINIO_ENDPOINT / MINIO_ACCESS_KEY / MINIO_SECRET_KEY / MINIO_PUBLIC_URL must be set',
      );
    }

    this.s3 = new S3Client({
      endpoint,
      region: 'us-east-1', // MinIO ignores region but SDK requires one
      credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
      forcePathStyle: true, // MinIO uses path-style: http://endpoint/bucket/key
    });
    this.publicBaseUrl = publicUrl.replace(/\/$/, '');
    this.logger.log(`StorageService initialized: endpoint=${endpoint} publicBase=${this.publicBaseUrl}`);
  }

  async upload(input: UploadInput): Promise<string> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: input.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
        CacheControl: input.cacheControl,
      }),
    );
    return `${this.publicBaseUrl}/${input.bucket}/${input.key}`;
  }

  async download(input: DownloadInput): Promise<Buffer> {
    const res = await this.s3.send(
      new GetObjectCommand({ Bucket: input.bucket, Key: input.key }),
    );
    const stream = res.Body as Readable;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }

  async delete(input: DeleteInput): Promise<void> {
    await this.s3.send(
      new DeleteObjectCommand({ Bucket: input.bucket, Key: input.key }),
    );
  }

  async list(input: ListInput): Promise<string[]> {
    const res = await this.s3.send(
      new ListObjectsV2Command({
        Bucket: input.bucket,
        Prefix: input.prefix,
        MaxKeys: input.maxKeys ?? 1000,
      }),
    );
    return (res.Contents ?? []).map((o) => o.Key as string);
  }

  publicUrl(bucket: string, key: string): string {
    return `${this.publicBaseUrl}/${bucket}/${key}`;
  }
}
