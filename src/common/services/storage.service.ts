// src/common/services/storage.service.ts
import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  CreateBucketCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { Readable } from 'stream';

export interface UploadInput {
  bucket: string;
  key: string;
  body: Buffer | Readable;
  contentType?: string;
  cacheControl?: string;
  /**
   * `attachment; filename=…` — файл по прямому переходу скачивается, а не
   * открывается страницей на нашем домене (файлы переписки, chat-files).
   */
  contentDisposition?: string;
  /**
   * Обрывает загрузку: срок на файл, бюджет хода (chat-files). Без него send
   * зовётся как раньше, одним аргументом.
   */
  abortSignal?: AbortSignal;
}

export interface DownloadInput {
  bucket: string;
  key: string;
  /** Обрывает скачивание: срок на одну миниатюру (thumbnail.service.ts). */
  abortSignal?: AbortSignal;
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

export interface ListPageInput {
  bucket: string;
  prefix: string;
  continuationToken?: string;
  maxKeys?: number;
}

export interface ListPage {
  keys: string[];
  /** Ответ усечён (IsTruncated): за этой страницей есть ещё ключи. */
  truncated: boolean;
  /** Токен следующей страницы; приходит только вместе с truncated. */
  nextContinuationToken?: string;
}

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private s3!: S3Client;
  private publicBaseUrl!: string;
  /** Бакеты, наличие которых уже подтверждено в этом процессе (createBucketIfAbsent). */
  private readonly ensuredBuckets = new Set<string>();

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

  /**
   * Бакет есть или создан. Сначала HeadBucket: у ключа приложения на проде
   * может не быть s3:CreateBucket, а MinIO проверяет право раньше
   * существования — голый CreateBucket падал бы AccessDenied и на
   * существующем бакете. CreateBucket — только если HeadBucket ответил
   * «нет такого» (NotFound / NoSuchBucket / 404); BucketAlready* при этом не
   * ошибка — бакет мог создать соседний вызов. Прочие ошибки HeadBucket
   * (403, сеть, 5xx) — наружу.
   *
   * Успех запоминается на бакет до конца процесса: повторный вызов в сеть не
   * ходит. Сбой не запоминается — следующий вызов проверит заново.
   */
  async createBucketIfAbsent(bucket: string): Promise<void> {
    if (this.ensuredBuckets.has(bucket)) return;
    try {
      await this.s3.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch (e: any) {
      if (!isMissingBucket(e)) throw e;
      try {
        await this.s3.send(new CreateBucketCommand({ Bucket: bucket }));
      } catch (createError: any) {
        const code = createError?.name || createError?.Code || createError?.code || '';
        if (!/BucketAlready/.test(code)) throw createError;
      }
    }
    this.ensuredBuckets.add(bucket);
  }

  async upload(input: UploadInput): Promise<string> {
    const cmd = new PutObjectCommand({
      Bucket: input.bucket,
      Key: input.key,
      Body: input.body,
      ContentType: input.contentType,
      CacheControl: input.cacheControl,
      ContentDisposition: input.contentDisposition,
    });
    if (input.abortSignal) await this.s3.send(cmd, { abortSignal: input.abortSignal });
    else await this.s3.send(cmd);
    return `${this.publicBaseUrl}/${input.bucket}/${input.key}`;
  }

  async download(input: DownloadInput): Promise<Buffer> {
    const cmd = new GetObjectCommand({ Bucket: input.bucket, Key: input.key });
    const res = input.abortSignal
      ? await this.s3.send(cmd, { abortSignal: input.abortSignal })
      : await this.s3.send(cmd);
    const stream = res.Body as Readable;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }

  async downloadStream(input: DownloadInput): Promise<Readable> {
    const cmd = new GetObjectCommand({ Bucket: input.bucket, Key: input.key });
    const res = input.abortSignal
      ? await this.s3.send(cmd, { abortSignal: input.abortSignal })
      : await this.s3.send(cmd);
    return res.Body as Readable;
  }

  async delete(input: DeleteInput): Promise<void> {
    await this.s3.send(
      new DeleteObjectCommand({ Bucket: input.bucket, Key: input.key }),
    );
  }

  /**
   * Удаление с подтверждённым исходом (account-deletion, Task 11):
   * 'deleted' — MinIO принял удаление; 'absent' — объекта уже нет
   * (NotFound/NoSuchKey/404), что для очистки тоже успех (идемпотентно).
   * Любая прочая ошибка — наружу: пёрж обязан отличать «объекта нет» от
   * «запрос не прошёл», иначе retry потеряет объект. NoSuchBucket не
   * считается отсутствием объекта: это рассогласование конфигурации.
   */
  async deleteConfirmed(input: DeleteInput): Promise<'deleted' | 'absent'> {
    try {
      await this.s3.send(
        new DeleteObjectCommand({ Bucket: input.bucket, Key: input.key }),
      );
      return 'deleted';
    } catch (e: any) {
      if (e?.name === 'NoSuchBucket') throw e;
      if (
        e?.name === 'NotFound'
        || e?.name === 'NoSuchKey'
        || e?.$metadata?.httpStatusCode === 404
      ) {
        return 'absent';
      }
      throw e;
    }
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

  /**
   * Одна страница ListObjectsV2 по префиксу — с признаком усечения и токеном
   * продолжения (account-deletion K4: обход video-uploads/<userId>/). В
   * отличие от list, хвост не теряется молча: цикл по страницам ведёт
   * вызывающий, пока truncated. Ошибки MinIO — наружу, классифицирует
   * вызывающий.
   */
  async listPage(input: ListPageInput): Promise<ListPage> {
    const res = await this.s3.send(
      new ListObjectsV2Command({
        Bucket: input.bucket,
        Prefix: input.prefix,
        ContinuationToken: input.continuationToken,
        MaxKeys: input.maxKeys ?? 1000,
      }),
    );
    const keys = (res.Contents ?? [])
      .map((o) => o.Key)
      .filter((key): key is string => typeof key === 'string' && key.length > 0);
    const truncated = res.IsTruncated === true;
    return {
      keys,
      truncated,
      nextContinuationToken: truncated ? res.NextContinuationToken : undefined,
    };
  }

  /** Размер и тип объекта; null — объекта нет. Прочие ошибки MinIO бросает. */
  async head(
    bucket: string,
    key: string,
    abortSignal?: AbortSignal,
  ): Promise<{ size: number; contentType?: string } | null> {
    try {
      const cmd = new HeadObjectCommand({ Bucket: bucket, Key: key });
      const res = abortSignal ? await this.s3.send(cmd, { abortSignal }) : await this.s3.send(cmd);
      return { size: Number(res.ContentLength ?? 0), contentType: res.ContentType };
    } catch (e: any) {
      if (e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404) return null;
      throw e;
    }
  }

  /**
   * Сколько объектов и байт в бакете — постранично, весь бакет.
   *
   * abortSignal — на каждую страницу: без него список большого бакета, повисший
   * на одной из страниц, ничем не ограничен (ручка статистики админки ждала бы
   * MinIO вечно).
   */
  async bucketStats(bucket: string, abortSignal?: AbortSignal): Promise<{ objects: number; bytes: number }> {
    let objects = 0;
    let bytes = 0;
    let token: string | undefined;
    do {
      const cmd = new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token });
      const res: any = abortSignal ? await this.s3.send(cmd, { abortSignal }) : await this.s3.send(cmd);
      for (const o of res.Contents ?? []) {
        objects += 1;
        bytes += Number(o.Size ?? 0);
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return { objects, bytes };
  }

  publicUrl(bucket: string, key: string): string {
    return `${this.publicBaseUrl}/${bucket}/${key}`;
  }
}

/** HeadBucket ответил «бакета нет»: у HeadBucket нет тела, SDK даёт NotFound и 404. */
function isMissingBucket(e: any): boolean {
  return (
    e?.name === 'NotFound'
    || e?.name === 'NoSuchBucket'
    || e?.Code === 'NoSuchBucket'
    || e?.$metadata?.httpStatusCode === 404
  );
}
