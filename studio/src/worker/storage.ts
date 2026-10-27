import fs from 'node:fs';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { MinioConfig } from '../config';

/** Файлы заданий: снимки съёмки, кадры и клипы сценок, видео и обложка (ключи — в jobs.ts). */
export interface Storage {
  put(key: string, file: string, contentType: string): Promise<void>;
  get(key: string, dest: string): Promise<void>;
  /**
   * Файл, которого может и не быть (кадр, клип прошлых попыток). false — ключа
   * нет; сетевой сбой — ошибка: принять его за «нет» значило бы заплатить за
   * клип второй раз.
   */
  getIfExists(key: string, dest: string): Promise<boolean>;
  /** Удалить ключ; ключа нет — не ошибка (S3 так и отвечает). */
  remove(key: string): Promise<void>;
}

/**
 * Тело — во временный файл рядом, на место — переименованием: обрыв посреди
 * скачивания не оставит половину raw.mp4, которую следующий захват принял бы
 * за скачанную и забраковал — с новой оплатой Omni.
 */
async function download(body: Readable, dest: string): Promise<void> {
  const part = `${dest}.part-${process.pid}`;
  try {
    await pipeline(body, fs.createWriteStream(part));
  } catch (e) {
    fs.rmSync(part, { force: true });
    throw e;
  }
  fs.renameSync(part, dest);
}

/**
 * MinIO по протоколу S3 — как StorageService бэкенда: path-style, регион
 * любой. Файл целиком в памяти: ролик — около 13 МБ, снимки — единицы МБ.
 * client — для тестов.
 */
export function s3Storage(cfg: MinioConfig, client?: { send(cmd: any): Promise<any> }): Storage {
  const s3 =
    client ??
    new S3Client({
      endpoint: cfg.endpoint,
      region: 'us-east-1',
      credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
      forcePathStyle: true,
    });
  return {
    async put(key, file, contentType) {
      await s3.send(new PutObjectCommand({ Bucket: cfg.bucket, Key: key, Body: fs.readFileSync(file), ContentType: contentType }));
    },
    async get(key, dest) {
      const res = await s3.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
      await download(res.Body as Readable, dest);
    },
    async getIfExists(key, dest) {
      let res: any;
      try {
        res = await s3.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
      } catch (e: any) {
        // 404 без бакета — не «ключа нет»: так конвейер молча снимал бы всё заново.
        if (e?.name === 'NoSuchKey' || (e?.$metadata?.httpStatusCode === 404 && e?.name !== 'NoSuchBucket')) return false;
        throw e;
      }
      await download(res.Body as Readable, dest);
      return true;
    },
    async remove(key) {
      await s3.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }));
    },
  };
}
