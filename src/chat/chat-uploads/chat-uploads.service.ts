import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import { PgService } from '../../common/services/pg.service';
import { StorageService } from '../../common/services/storage.service';
import { safeFileName } from '../chat-files/file-meta';
import {
  UPLOAD_THUMB_CALL_BUDGET_MS,
  UPLOAD_THUMB_QUEUE_WAIT_MS,
  UploadThumbSlots,
  isThumbnailableMime,
  makeUploadThumb,
  uploadThumbKey,
} from './upload-thumb';

export interface ChatUploadInputFile {
  buffer: Buffer;
  originalname: string;
  mimetype?: string;
}

/** Откуда пришёл файл: web — веб и оба приложения, scan — PDF Маши, telegram — личка с ботом. */
export type ChatUploadSource = 'web' | 'scan' | 'telegram';

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
  source: ChatUploadSource;
  /** Ключ webp-миниатюры в том же бакете; null — миниатюры нет (не картинка или не получилась). */
  thumbKey: string | null;
  /** Комментарий ассистента (note_file), до 500 символов. */
  note: string | null;
  noteUpdatedAt: string | null;
  noteAssistantId: string | null;
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

/** Приватный бакет исходников; экспортирован для адаптера удаления аккаунта. */
export const CHAT_UPLOADS_BUCKET = 'linkeon-chat-uploads';
const BUCKET = CHAT_UPLOADS_BUCKET;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLUMNS =
  'id, user_id, session_id, original_name, mime, size_bytes, sha256, storage_key, created_at, '
  + 'source, thumb_key, note, note_updated_at, note_assistant_id';
/** Файлы миграций реестра — строго по порядку: 002 дополняет таблицу из 001. */
const MIGRATIONS = ['001_chat_uploads.sql', '002_chat_uploads_media_notes.sql'] as const;

/** Бюджет миниатюр одного вызова saveOriginals: срок и «дальше без миниатюр». */
interface ThumbCallBudget {
  deadline: number;
  exhausted: boolean;
}

@Injectable()
export class ChatUploadsService {
  private readonly logger = new Logger(ChatUploadsService.name);
  private bucketEnsured = false;
  /** Места под рендер миниатюр; undefined — общие на процесс (upload-thumb.ts). Подменяется в тестах. */
  private thumbSlots?: UploadThumbSlots;

  constructor(
    private readonly pg: PgService,
    private readonly storage: StorageService,
  ) {}

  /**
   * Создать и дополнить таблицу реестра при старте модуля (образец —
   * alert-bot.store.ts): 001, затем 002. nest-cli не копирует .sql в dist,
   * поэтому второй кандидат читает файл из src: после сборки сервис лежит в
   * dist/chat/chat-uploads, и «..» ровно три. Сначала находятся ВСЕ файлы и
   * только потом выполняются: пропавший 002 не оставляет старт «на полпути».
   */
  async migrate(): Promise<void> {
    const paths = MIGRATIONS.map((file) => {
      const candidates = [
        path.join(__dirname, 'migrations', file),
        path.join(__dirname, '..', '..', '..', 'src', 'chat', 'chat-uploads', 'migrations', file),
      ];
      const migrationPath = candidates.find((candidate) => fs.existsSync(candidate));
      if (!migrationPath) throw new Error(`chat-uploads migration ${file} not found`);
      return migrationPath;
    });
    for (const migrationPath of paths) {
      await this.pg.query(fs.readFileSync(migrationPath, 'utf8'));
    }
  }

  async saveOriginals(input: {
    userId: string;
    sessionId: string;
    files: ChatUploadInputFile[];
    /** Откуда файл; по умолчанию web (upload-and-chat: веб и оба приложения). */
    source?: ChatUploadSource;
  }): Promise<SaveOriginalsResult> {
    if (!this.bucketEnsured) {
      await this.storage.createBucketIfAbsent(BUCKET);
      this.bucketEnsured = true;
    }
    const result: SaveOriginalsResult = { saved: [], failed: [] };
    const source: ChatUploadSource = input.source ?? 'web';
    // Срок миниатюр считается от начала вызова: медленная загрузка
    // оригиналов тоже его съедает — миниатюры уступают оригиналам место в
    // бюджете сохранения хода.
    const thumbBudget: ThumbCallBudget = {
      deadline: Date.now() + UPLOAD_THUMB_CALL_BUDGET_MS,
      exhausted: false,
    };

    for (const file of input.files) {
      const storageKey = `${randomUUID()}/${safeFileName(file.originalname)}`;
      const mime = file.mimetype || 'application/octet-stream';
      let thumbKey: string | null = null;
      try {
        const sha256 = createHash('sha256').update(file.buffer).digest('hex');
        await this.storage.upload({
          bucket: BUCKET,
          key: storageKey,
          body: file.buffer,
          contentType: mime,
          cacheControl: 'private, no-store',
        });
        thumbKey = await this.saveThumb(file, mime, storageKey, thumbBudget);
        const { rows } = await this.pg.query(
          `INSERT INTO chat_uploads
             (user_id, session_id, original_name, mime, size_bytes, sha256, storage_key, source, thumb_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING ${COLUMNS}`,
          [
            input.userId,
            input.sessionId,
            file.originalname,
            mime,
            file.buffer.length,
            sha256,
            storageKey,
            source,
            thumbKey,
          ],
        );
        result.saved.push(this.row(rows[0]));
      } catch (e: any) {
        this.logger.warn(
          `saveOriginals: failed to persist file ${this.logName(file.originalname)}: ${this.errDetail(e)}`,
        );
        // Best-effort cleanup: оригинал и (если успела лечь) миниатюра —
        // строки нет, значит и объектов без неё оставлять незачем.
        for (const key of thumbKey ? [storageKey, thumbKey] : [storageKey]) {
          try {
            await this.storage.delete({ bucket: BUCKET, key });
          } catch (cleanupError: any) {
            // Best-effort cleanup: the original upload failure is reported by name.
            this.logger.warn(
              `saveOriginals: best-effort cleanup delete failed for ${this.logName(file.originalname)}: ${this.errDetail(cleanupError)}`,
            );
          }
        }
        result.failed.push(file.originalname);
      }
    }

    return result;
  }

  /**
   * WebP-миниатюра картинки рядом с оригиналом (thumbs/<storage_key>.webp).
   * Никогда не бросает. mime не из белого списка (isThumbnailableMime: SVG,
   * BMP, ICO, HEIC, не картинки) — null молча. Не получилась или не легла в
   * MinIO — null с предупреждением: экранированное имя, mime и причина, без
   * байтов и без сырого текста sharp. Файл сохраняется без миниатюры — фронт
   * покажет значок.
   *
   * Бюджет вызова (UPLOAD_THUMB_CALL_BUDGET_MS): место под рендер ждём не
   * дольше остатка; срок вышел или уже был busy/timeout (процесс перегружен,
   * следующим файлам места тоже не будет) — остальные файлы вызова без
   * миниатюр, с причиной budget.
   */
  private async saveThumb(
    file: ChatUploadInputFile,
    mime: string,
    storageKey: string,
    budget: ThumbCallBudget,
  ): Promise<string | null> {
    if (!isThumbnailableMime(mime)) return null;
    const skipped = (reason: string): null => {
      this.logger.warn(
        `saveOriginals: thumbnail skipped for ${this.logName(file.originalname)} (${JSON.stringify(mime.slice(0, 100))}): ${reason}`,
      );
      return null;
    };
    const remainingMs = budget.deadline - Date.now();
    if (budget.exhausted || remainingMs <= 0) {
      budget.exhausted = true;
      return skipped('budget');
    }
    const thumb = await makeUploadThumb(file.buffer, mime, {
      slots: this.thumbSlots,
      waitMs: Math.min(UPLOAD_THUMB_QUEUE_WAIT_MS, remainingMs),
    });
    if (thumb.ok === false) {
      if (thumb.reason === 'busy' || thumb.reason === 'timeout') budget.exhausted = true;
      return skipped(thumb.reason);
    }
    const key = uploadThumbKey(storageKey);
    try {
      await this.storage.upload({
        bucket: BUCKET,
        key,
        body: thumb.webp,
        contentType: 'image/webp',
        cacheControl: 'private, no-store',
      });
      return key;
    } catch (e: any) {
      this.logger.warn(
        `saveOriginals: thumbnail upload failed for ${this.logName(file.originalname)}: ${this.errDetail(e)}`,
      );
      // Сбой PutObject неоднозначен: объект мог лечь, а ответ — потеряться.
      // Строки с этим ключом не будет, поэтому ключ чистим сразу
      // (DeleteObject идемпотентен — удалить несуществующее не ошибка).
      try {
        await this.storage.delete({ bucket: BUCKET, key });
      } catch (cleanupError: any) {
        this.logger.warn(
          `saveOriginals: thumbnail cleanup delete failed for ${this.logName(file.originalname)}: ${this.errDetail(cleanupError)}`,
        );
      }
      return null;
    }
  }

  /** Имя файла для журнала: в кавычках и экранировано — перевод строки в имени не подделает запись. */
  private logName(name: string): string {
    return JSON.stringify(String(name)).slice(0, 200);
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
   * Исходники пользователя для find_files (origin=upload). LIMIT 200 —
   * потолок выборки кандидатов: 200 свежих загрузок с запасом покрывают
   * реального пользователя, а итоговая выдача find_files всё равно режется
   * её собственным limit (не больше 30 — FIND_FILES_MAX_LIMIT), так что
   * читать больше — лишняя работа без видимого результата.
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

  assistantBlock(records: ChatUploadRecord[] | null | undefined): string {
    if (process.env.CHAT_UPLOADS_ENABLED !== 'true' || !records?.length) return '';
    // Строка про срок и «только последняя копия» — не косметика (I1a, ревью
    // Task 6): в resumed-сессиях релея копии блока накапливаются ход за ходом,
    // а подпись живёт ~1 час. Модель, взявшая ссылку из устаревшей копии,
    // получает 404 и решает, что файл пропал.
    //
    // Строка-запрет (I2, финальное ревью): этот блок модель видит каждый ход,
    // а запрет «не показывать assistantUrl» раньше жил только в описаниях
    // find_files и manage_product. Вставленная в ответ ссылка оседает в
    // истории и протухает через час — файл пользователю отдаётся только через
    // url из find_files.
    return [
      'Earlier user uploads:',
      'Signed links expire after ~1 hour. If this block appears more than once in the conversation, use ONLY the LATEST copy — links from earlier copies are stale and return 404.',
      'These links are for your internal use only; NEVER show or paste them to the user — to give the user a file, find it via find_files and share only its "url" field.',
      ...records.map((record) => `- ${record.originalName}: ${this.assistantUrl(record.id)}`),
    ].join('\n');
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
      // Колонка NOT NULL DEFAULT 'web'; запасное 'web' — для строк без неё
      // (моки соседних спеков), чтобы не получить строку 'undefined'.
      source: (row.source ?? 'web') as ChatUploadSource,
      thumbKey: row.thumb_key == null ? null : String(row.thumb_key),
      note: row.note == null ? null : String(row.note),
      noteUpdatedAt: row.note_updated_at == null ? null : new Date(row.note_updated_at).toISOString(),
      noteAssistantId: row.note_assistant_id == null ? null : String(row.note_assistant_id),
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
