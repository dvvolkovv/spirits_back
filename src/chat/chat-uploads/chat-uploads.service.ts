import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import { PgService } from '../../common/services/pg.service';
import { StorageService } from '../../common/services/storage.service';
import { safeFileName } from '../chat-files/file-meta';

export interface ChatUploadInputFile {
  buffer: Buffer;
  originalname: string;
  mimetype?: string;
}

export interface ChatUploadRecord {
  id: string;
  userId: string;
  sessionId: string;
  originalName: string;
  mime: string;
  sizeBytes: number;
  sha256: string;
  storageKey: string;
  createdAt: string;
}

export interface SaveOriginalsResult {
  saved: ChatUploadRecord[];
  failed: string[];
}

export interface ChatUploadDownload {
  body: Readable;
  originalName: string;
  mime: string;
  sizeBytes: number;
}

const BUCKET = 'linkeon-chat-uploads';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLUMNS = 'id, user_id, session_id, original_name, mime, size_bytes, sha256, storage_key, created_at';

@Injectable()
export class ChatUploadsService {
  private readonly logger = new Logger(ChatUploadsService.name);
  private bucketEnsured = false;

  constructor(
    private readonly pg: PgService,
    private readonly storage: StorageService,
  ) {}

  /**
   * Создать таблицу реестра при старте модуля (образец — alert-bot.store.ts).
   * nest-cli не копирует .sql в dist, поэтому второй кандидат читает файл из
   * src: после сборки сервис лежит в dist/chat/chat-uploads, и «..» ровно три.
   */
  async migrate(): Promise<void> {
    const candidates = [
      path.join(__dirname, 'migrations', '001_chat_uploads.sql'),
      path.join(__dirname, '..', '..', '..', 'src', 'chat', 'chat-uploads', 'migrations', '001_chat_uploads.sql'),
    ];
    const migrationPath = candidates.find((candidate) => fs.existsSync(candidate));
    if (!migrationPath) throw new Error('chat-uploads migration 001_chat_uploads.sql not found');
    const sql = fs.readFileSync(migrationPath, 'utf8');
    await this.pg.query(sql);
  }

  async saveOriginals(input: {
    userId: string;
    sessionId: string;
    files: ChatUploadInputFile[];
  }): Promise<SaveOriginalsResult> {
    if (!this.bucketEnsured) {
      await this.storage.createBucketIfAbsent(BUCKET);
      this.bucketEnsured = true;
    }
    const result: SaveOriginalsResult = { saved: [], failed: [] };

    for (const file of input.files) {
      const storageKey = `${randomUUID()}/${safeFileName(file.originalname)}`;
      try {
        const sha256 = createHash('sha256').update(file.buffer).digest('hex');
        await this.storage.upload({
          bucket: BUCKET,
          key: storageKey,
          body: file.buffer,
          contentType: file.mimetype || 'application/octet-stream',
          cacheControl: 'private, no-store',
        });
        const { rows } = await this.pg.query(
          `INSERT INTO chat_uploads
             (user_id, session_id, original_name, mime, size_bytes, sha256, storage_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING ${COLUMNS}`,
          [
            input.userId,
            input.sessionId,
            file.originalname,
            file.mimetype || 'application/octet-stream',
            file.buffer.length,
            sha256,
            storageKey,
          ],
        );
        result.saved.push(this.row(rows[0]));
      } catch (e: any) {
        this.logger.warn(
          `saveOriginals: failed to persist file "${file.originalname}": ${this.errDetail(e)}`,
        );
        try {
          await this.storage.delete({ bucket: BUCKET, key: storageKey });
        } catch (cleanupError: any) {
          // Best-effort cleanup: the original upload failure is reported by name.
          this.logger.warn(
            `saveOriginals: best-effort cleanup delete failed for "${file.originalname}": ${this.errDetail(cleanupError)}`,
          );
        }
        result.failed.push(file.originalname);
      }
    }

    return result;
  }

  ownerUrl(id: string): string {
    return `/webhook/chat-uploads/${id}`;
  }

  assistantUrl(id: string, nowSeconds = Date.now() / 1000): string {
    const exp = Math.floor(nowSeconds) + 3600;
    const sig = this.signature(id, exp);
    const base = (process.env.BACKEND_URL || 'https://my.linkeon.io').replace(/\/+$/, '');
    return `${base}${this.ownerUrl(id)}?exp=${exp}&sig=${sig}`;
  }

  verifyAssistant(
    id: string,
    exp: string | number,
    sig: string,
    nowSeconds = Date.now() / 1000,
  ): boolean {
    if (!/^\d+$/.test(String(exp))) return false;
    const expires = Number(exp);
    if (!Number.isSafeInteger(expires)) return false;
    const current = Math.floor(nowSeconds);
    if (expires < current || expires > current + 3600 || !sig) return false;

    const expected = Buffer.from(this.signature(id, expires), 'utf8');
    const actual = Buffer.from(String(sig), 'utf8');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  async openDownload(input: {
    id: string;
    userId?: string;
    exp?: string;
    sig?: string;
  }): Promise<ChatUploadDownload> {
    try {
      if (!UUID_RE.test(input.id)) throw new NotFoundException('Upload not found');
      const { rows } = await this.pg.query(
        `SELECT ${COLUMNS} FROM chat_uploads WHERE id = $1`,
        [input.id],
      );
      const record = this.row(rows[0]);
      const owner = input.userId !== undefined && input.userId === record.userId;
      const assistant = input.exp !== undefined && input.sig !== undefined
        && this.verifyAssistant(record.id, input.exp, input.sig);
      if (!owner && !assistant) throw new NotFoundException('Upload not found');

      return {
        body: await this.storage.downloadStream({ bucket: BUCKET, key: record.storageKey }),
        originalName: record.originalName,
        mime: record.mime,
        sizeBytes: record.sizeBytes,
      };
    } catch (e: any) {
      const id = String(input.id).slice(0, 64);
      if (e instanceof NotFoundException) {
        this.logger.debug(`openDownload: not found (id=${id})`);
      } else {
        this.logger.error(`openDownload: internal failure (id=${id}): ${this.errDetail(e)}`);
      }
      throw new NotFoundException('Upload not found');
    }
  }

  async recentForSession(
    userId: string,
    sessionId: string,
    excludeIds: string[] = [],
  ): Promise<ChatUploadRecord[]> {
    const { rows } = await this.pg.query(
      `SELECT ${COLUMNS} FROM chat_uploads
       WHERE user_id = $1 AND session_id = $2 AND NOT (id = ANY($3::uuid[]))
       ORDER BY created_at DESC
       LIMIT 10`,
      [userId, sessionId, excludeIds],
    );
    return rows.map((row) => this.row(row));
  }

  /**
   * Исходники пользователя для find_files (origin=upload). LIMIT 200 выбран
   * согласованно с SEARCH_ROWS_LIMIT истории чата (chat-files.service.ts):
   * столько же строк читает поиск по ответам ассистентов — 200 свежих
   * загрузок с запасом покрывают реального пользователя, а конвейер find_files
   * всё равно режет выдачу своим limit (≤30).
   */
  async searchOriginals(userId: string, days?: number): Promise<ChatUploadRecord[]> {
    const { rows } = await this.pg.query(
      `SELECT ${COLUMNS} FROM chat_uploads
       WHERE user_id = $1
         AND ($2::int IS NULL OR created_at >= now() - make_interval(days => $2::int))
       ORDER BY created_at DESC
       LIMIT 200`,
      [userId, days ?? null],
    );
    return rows.map((row) => this.row(row));
  }

  async deleteForUser(userId: string): Promise<void> {
    const { rows } = await this.pg.query(
      'SELECT storage_key FROM chat_uploads WHERE user_id = $1',
      [userId],
    );
    for (const row of rows) {
      try {
        await this.storage.delete({ bucket: BUCKET, key: row.storage_key });
      } catch (e: any) {
        if (this.isNotFound(e)) {
          // Account deletion must continue even when an object is already absent.
          this.logger.warn(
            `deleteForUser: object already absent (user=${userId}, key=${row.storage_key}): ${this.errDetail(e)}`,
          );
          continue;
        }
        // storage_key — единственный указатель на байты: без успешного удаления
        // строки нельзя терять, иначе при восстановлении MinIO байты останутся
        // навсегда. Ошибка уходит наверх, удаление аккаунта повторяется позже.
        this.logger.error(
          `deleteForUser: storage delete failed (user=${userId}): ${this.errDetail(e)}; DB rows kept for retry`,
        );
        throw e;
      }
    }
    await this.pg.query('DELETE FROM chat_uploads WHERE user_id = $1', [userId]);
  }

  assistantBlock(records: ChatUploadRecord[] | null | undefined): string {
    if (process.env.CHAT_UPLOADS_ENABLED !== 'true' || !records?.length) return '';
    return `Earlier user uploads:\n${records
      .map((record) => `- ${record.originalName}: ${this.assistantUrl(record.id)}`)
      .join('\n')}`;
  }

  private isNotFound(e: any): boolean {
    return (
      e?.name === 'NotFound' ||
      e?.name === 'NoSuchKey' ||
      e?.$metadata?.httpStatusCode === 404
    );
  }

  /** Вид и сообщение ошибки — без байтов, подписей и секретов. */
  private errDetail(e: any): string {
    const name = e?.name || 'Error';
    const message = typeof e?.message === 'string' ? e.message : '';
    return `${name}: ${message}`.slice(0, 300);
  }

  private row(row: any): ChatUploadRecord {
    if (!row) throw new NotFoundException('Upload not found');
    return {
      id: String(row.id),
      userId: String(row.user_id),
      sessionId: String(row.session_id),
      originalName: String(row.original_name),
      mime: String(row.mime),
      sizeBytes: Number(row.size_bytes),
      sha256: String(row.sha256),
      storageKey: String(row.storage_key),
      createdAt: new Date(row.created_at).toISOString(),
    };
  }

  private signature(id: string, exp: number): string {
    return createHmac('sha256', this.secret())
      .update(`chat-upload:v1:${id}:${exp}`)
      .digest('hex');
  }

  private secret(): string {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error('JWT_SECRET required');
    return secret;
  }
}
