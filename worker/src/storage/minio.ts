// worker/src/storage/minio.ts
import * as fs from 'fs/promises';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { createReadStream } from 'fs';
import { config } from '../config';
import { logger } from '../logger';

let _s3: S3Client | null = null;
function s3(): S3Client {
  if (_s3) return _s3;
  _s3 = new S3Client({
    endpoint: config.minio.endpoint,
    region: 'us-east-1',
    credentials: { accessKeyId: config.minio.accessKey, secretAccessKey: config.minio.secretKey },
    forcePathStyle: true,
  });
  return _s3;
}

function publicUrl(bucket: string, key: string): string {
  const base = config.minio.publicUrl.replace(/\/$/, '');
  return `${base}/${bucket}/${key}`;
}

async function uploadFile(localPath: string, bucket: string, key: string, contentType: string): Promise<string> {
  const body = await fs.readFile(localPath);
  await s3().send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
  const url = publicUrl(bucket, key);
  logger.debug({ url, bytes: body.length }, 'minio upload ok');
  return url;
}

async function uploadFileStreaming(localPath: string, bucket: string, key: string, contentType: string): Promise<string> {
  const fileStream = createReadStream(localPath);
  const upload = new Upload({
    client: s3(),
    params: { Bucket: bucket, Key: key, Body: fileStream, ContentType: contentType },
  });
  await upload.done();
  return publicUrl(bucket, key);
}

export async function uploadAudioToMinio(localPath: string, keyPrefix: string): Promise<string> {
  const ext = localPath.endsWith('.mp3') ? 'mp3' : 'pcm';
  return uploadFile(
    localPath,
    config.minio.bucketVideos,
    `${keyPrefix}.${ext}`,
    ext === 'mp3' ? 'audio/mpeg' : 'audio/L16',
  );
}

export async function uploadImageToMinio(localPath: string, keyPrefix: string): Promise<string> {
  return uploadFile(localPath, config.minio.bucketVideos, `${keyPrefix}.png`, 'image/png');
}

export async function uploadVideoToMinio(localPath: string, keyPrefix: string): Promise<string> {
  return uploadFileStreaming(localPath, config.minio.bucketVideos, `${keyPrefix}.mp4`, 'video/mp4');
}

export async function uploadFinalMp4(localPath: string, keyPrefix: string): Promise<string> {
  return uploadFileStreaming(localPath, config.minio.bucketVideos, keyPrefix, 'video/mp4');
}
