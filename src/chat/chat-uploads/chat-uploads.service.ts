import { BadRequestException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import { PgService } from '../../common/services/pg.service';
import { StorageService } from '../../common/services/storage.service';
import { safeFileName } from '../chat-files/file-meta';
import { uploadKind } from './upload-kind';
import { sanitizeUploadNote, uploadNoteOneLine } from './upload-note';
// Value-импорт, не `import type`: тип стёр бы design:paramtypes, и Nest не
// внедрил бы LanguageService (пин — chat-uploads.delete.spec.ts).
import { LanguageService } from '../../common/services/language.service';
import { deletedUploadLine } from './deleted-line';
import { errKind, logId } from './err-kind';
import { uploadHistoryLink } from './markdown-name';
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

/**
 * Удаление загрузки владельцем не дошло до конца: MinIO не подтвердил
 * удаление объекта (любой исход, кроме 'deleted'/'absent'). Строка реестра и
 * история не тронуты, повтор безопасен; контроллер отвечает 502. Сообщение
 * без имени файла и ключей — их нельзя в логи и ответы.
 */
export class ChatUploadDeleteError extends Error {
  constructor(message = 'chat upload storage delete failed') {
    super(message);
    this.name = 'ChatUploadDeleteError';
  }
}

/** Приватный бакет исходников; экспортирован для адаптера удаления аккаунта. */
export const CHAT_UPLOADS_BUCKET = 'linkeon-chat-uploads';

/**
 * Потолок загрузок одной переписки в панели «Медиа/Файлы» (GET /webhook/chat/files).
 * Файлы ассистента панель читает с потолком PANEL_ROWS_LIMIT (chat-files.service.ts);
 * 500 собственных загрузок в одной переписке — с большим запасом.
 */
export const PANEL_UPLOADS_LIMIT = 500;

/**
 * Исходник больше предела вызывающего (findOwnedOriginal с maxBytes). Размер
 * сверяется по реестру до скачивания: байты из хранилища не читаются.
 */
export class ChatUploadTooLargeError extends Error {
  constructor(readonly sizeBytes: number, readonly maxBytes: number) {
    super(`chat upload is larger than ${maxBytes} bytes`);
    this.name = 'ChatUploadTooLargeError';
  }
}

const BUCKET = CHAT_UPLOADS_BUCKET;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Предел комментария к загрузке — тот же, что CHECK chat_uploads_note_len_check (миграция 002) и maxLength в note_file. */
export const UPLOAD_NOTE_MAX_CHARS = 500;
/** Что видит ассистент в блоке загрузок, пока к файлу нет комментария. */
export const UPLOAD_NOTE_MISSING = 'нет — оставь его через note_file после работы с файлом';

/**
 * Строка 📎 удалённого файла в истории сессии → «📎 имя — файл удалён».
 * Фильтр — strpos, а не LIKE: в $2 имя экранировано markdownEscapeName
 * (\, \[, \]), а в LIKE обратная косая — escape-символ, и строка с такими
 * именами не находилась бы. replace() сравнивает буквально.
 */
const HISTORY_REWRITE_SQL =
  'UPDATE custom_chat_history SET content = replace(content, $2, $3) WHERE session_id = $1 AND strpos(content, $2) > 0';
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
    // Язык профиля для строки «файл удалён» (deleteForOwner). @Optional — чтобы
    // спеки, создающие сервис двумя аргументами, не менялись; без сервиса
    // строка пишется по-русски. В реальном графе LanguageService есть всегда
    // (CommonModule) — пин в chat-uploads.di.spec.ts.
    @Optional() private readonly language?: LanguageService,
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
        // Только вид ошибки (errKind) и обезличенный id объекта: имя файла —
        // пользовательские данные, а сообщения pg/S3 повторяют его и ключ
        // объекта. id загрузки здесь ещё нет (строка не записана), ключ сессии
        // содержит номер телефона; uuid-префикс storage_key (storageKeyLogId)
        // находит в MinIO объект, если уборка ниже не удалась.
        // Префикс строки стабилен — по нему грепают журнал.
        const keyId = this.storageKeyLogId(storageKey);
        this.logger.warn(`saveOriginals: failed to persist file (key=${keyId}): ${errKind(e)}`);
        // Best-effort cleanup: оригинал и (если успела лечь) миниатюра —
        // строки нет, значит и объектов без неё оставлять незачем.
        for (const key of thumbKey ? [storageKey, thumbKey] : [storageKey]) {
          try {
            await this.storage.delete({ bucket: BUCKET, key });
          } catch (cleanupError: any) {
            // Сам сбой сохранения уже записан строкой выше; здесь — тоже только вид.
            this.logger.warn(`saveOriginals: best-effort cleanup delete failed (key=${keyId}): ${errKind(cleanupError)}`);
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
   * MinIO — null с предупреждением: id объекта (storageKeyLogId), тип mime и
   * причина или вид ошибки (errKind) — без имени файла, байтов и сырого
   * текста sharp/S3. Файл сохраняется без миниатюры — фронт покажет значок.
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
    const keyId = this.storageKeyLogId(storageKey);
    // Только тип: он уже прошёл белый список, а параметры после «;» клиент
    // пишет сам — в них может оказаться имя файла.
    const mimeType = mime.split(';')[0].trim().toLowerCase();
    const skipped = (reason: string): null => {
      this.logger.warn(
        `saveOriginals: thumbnail skipped (key=${keyId}, mime=${JSON.stringify(mimeType)}): ${reason}`,
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
      this.logger.warn(`saveOriginals: thumbnail upload failed (key=${keyId}): ${errKind(e)}`);
      // Сбой PutObject неоднозначен: объект мог лечь, а ответ — потеряться.
      // Строки с этим ключом не будет, поэтому ключ чистим сразу
      // (DeleteObject идемпотентен — удалить несуществующее не ошибка).
      try {
        await this.storage.delete({ bucket: BUCKET, key });
      } catch (cleanupError: any) {
        this.logger.warn(`saveOriginals: thumbnail cleanup delete failed (key=${keyId}): ${errKind(cleanupError)}`);
      }
      return null;
    }
  }

  /**
   * Обезличенный id объекта для журнала: первый сегмент storage_key — это
   * случайный uuid (`<uuid>/<имя>`), в кавычках через logId. По нему в бакете
   * находятся и оригинал (`<uuid>/…`), и миниатюра (`thumbs/<uuid>/…`); имени
   * файла, сессии и телефона в нём нет.
   */
  private storageKeyLogId(storageKey: string): string {
    return logId(storageKey.split('/', 1)[0]);
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
      const id = logId(input.id);
      if (e instanceof NotFoundException) {
        this.logger.debug(`openDownload: not found (id=${id})`);
      } else {
        this.logger.error(`openDownload: internal failure (id=${id}): ${errKind(e)}`);
      }
      throw new NotFoundException('Upload not found');
    }
  }

  /**
   * Миниатюра для панели кабинета — только владельцу (подписи ассистента тут
   * нет: превью нужно человеку, а не модели). Отдаётся только по thumb_key.
   * Любой сбой — не владелец, нет записи или thumb_key, объекта нет, MinIO
   * упал — единый 404 без раскрытия, как в openDownload. Миниатюра — webp с
   * длинной стороной до 480 px, десятки КБ: читаем целиком, чтобы знать
   * Content-Length (у потока GetObject его нет).
   */
  async openThumb(input: { id: string; userId: string }): Promise<ChatUploadDownload> {
    try {
      const record = await this.loadOwned(input);
      if (!record.thumbKey) throw new NotFoundException('Upload not found');
      const bytes = await this.storage.download({ bucket: BUCKET, key: record.thumbKey });
      return {
        body: Readable.from([bytes]),
        originalName: record.originalName,
        mime: 'image/webp',
        sizeBytes: bytes.length,
      };
    } catch (e: any) {
      const id = logId(input.id);
      if (e instanceof NotFoundException) {
        this.logger.debug(`openThumb: not found (id=${id})`);
      } else {
        this.logger.error(`openThumb: internal failure (id=${id}): ${errKind(e)}`);
      }
      throw new NotFoundException('Upload not found');
    }
  }

  /**
   * Удаление загрузки самим пользователем (спека 2026-11-16, раздел 1).
   * Порядок:
   *  1. объекты MinIO — миниатюры, затем оригинал (deleteConfirmed: 'deleted'
   *     и 'absent' — успех). Миниатюра стирается и по thumb_key, и по
   *     вычисляемому thumbs/<storage_key>.webp: неоднозначно оборвавшаяся
   *     загрузка миниатюры при сохранении могла оставить объект при
   *     thumb_key = NULL. Миниатюры первыми: если оригинал не удалится,
   *     строка останется с рабочим файлом, а пропадёт только превью;
   *  2. строка реестра (вместе с ней уходит и комментарий ассистента);
   *  3. строка 📎 в истории сессии → «📎 имя — файл удалён» на языке профиля.
   * Чужой/несуществующий id — NotFoundException (404 без раскрытия). Любой
   * иной исход MinIO — ChatUploadDeleteError: строка и история целы, повтор
   * безопасен. Сбой шага 3 удаление не проваливает — файл уже стёрт, повтор
   * дал бы 404; остаётся лог.
   */
  async deleteForOwner(input: { id: string; userId: string }): Promise<void> {
    const record = await this.loadOwned(input);

    const thumbKeys = [...new Set([record.thumbKey, uploadThumbKey(record.storageKey)].filter(Boolean))];
    for (const key of [...thumbKeys, record.storageKey]) {
      try {
        await this.storage.deleteConfirmed({ bucket: BUCKET, key });
      } catch (e: any) {
        this.logger.error(`deleteForOwner: storage delete failed (id=${record.id}): ${errKind(e)}`);
        throw new ChatUploadDeleteError();
      }
    }

    await this.pg.query('DELETE FROM chat_uploads WHERE id = $1 AND user_id = $2', [record.id, input.userId]);

    try {
      // Сбой выбора языка не отменяет переписывание: тогда строка по-русски.
      const lang = this.language
        ? await this.language.resolveUserLanguage(input.userId).catch(() => null)
        : null;
      await this.pg.query(HISTORY_REWRITE_SQL, [
        record.sessionId,
        // Посимвольно та строка, что пишет upload-and-chat (chat.controller.ts).
        uploadHistoryLink(record.originalName, this.ownerUrl(record.id)),
        deletedUploadLine(record.originalName, lang),
      ]);
    } catch (e: any) {
      this.logger.error(`deleteForOwner: history rewrite failed (id=${record.id}): ${errKind(e)}`);
    }
  }

  /** Запись владельца или NotFoundException; не-UUID отсекается до запроса (иначе PG упал бы на приведении). */
  private async loadOwned(input: { id: string; userId: string }): Promise<ChatUploadRecord> {
    if (!input.userId || !UUID_RE.test(input.id)) throw new NotFoundException('Upload not found');
    const { rows } = await this.pg.query(
      `SELECT ${COLUMNS} FROM chat_uploads WHERE id = $1 AND user_id = $2`,
      [input.id, input.userId],
    );
    return this.row(rows[0]);
  }

  /**
   * Байты исходника для инструментов картинок и видео (upload-image-source.ts):
   * только владельцу. null — нет такой загрузки или она чужая, без различия,
   * как 404 у GET :id. Владелец — условие SQL, чужая строка не читается.
   *
   * maxBytes — предел вызывающего: размер сверяется по реестру ДО скачивания
   * и ещё раз по фактическим байтам. Превышение — ChatUploadTooLargeError.
   * Сбой хранилища пробрасывается: вызывающий отличает его от «не найдено».
   */
  async findOwnedOriginal(input: {
    id: string;
    userId: string;
    maxBytes?: number;
  }): Promise<{ record: ChatUploadRecord; body: Buffer } | null> {
    if (!UUID_RE.test(input.id) || !input.userId) return null;
    const { rows } = await this.pg.query(
      `SELECT ${COLUMNS} FROM chat_uploads WHERE id = $1 AND user_id = $2`,
      [input.id, input.userId],
    );
    if (!rows[0]) return null;
    const record = this.row(rows[0]);
    if (input.maxBytes !== undefined && record.sizeBytes > input.maxBytes) {
      throw new ChatUploadTooLargeError(record.sizeBytes, input.maxBytes);
    }
    const body = await this.storage.download({ bucket: BUCKET, key: record.storageKey });
    if (input.maxBytes !== undefined && body.length > input.maxBytes) {
      throw new ChatUploadTooLargeError(body.length, input.maxBytes);
    }
    return { record, body };
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
   * Загрузки одной переписки для панели «Медиа/Файлы», от новых к старым.
   * user_id в условии обязателен, хотя session_id и так начинается с него:
   * ключ сессии собирает контроллер, а реестр отдаёт строки только владельцу.
   * Индекс idx_chat_uploads_user_session_created (миграция 001) покрывает
   * и условие, и порядок. limit выше PANEL_UPLOADS_LIMIT режется до него.
   */
  async listForSessionPanel(
    userId: string,
    sessionId: string,
    limit = PANEL_UPLOADS_LIMIT,
  ): Promise<ChatUploadRecord[]> {
    const capped = Number.isFinite(limit)
      ? Math.min(Math.max(Math.trunc(limit), 1), PANEL_UPLOADS_LIMIT)
      : PANEL_UPLOADS_LIMIT;
    const { rows } = await this.pg.query(
      `SELECT ${COLUMNS} FROM chat_uploads
       WHERE user_id = $1 AND session_id = $2
       ORDER BY created_at DESC
       LIMIT $3`,
      [userId, sessionId, capped],
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

  /**
   * Комментарий ассистента к загрузке (инструмент note_file). Новый текст
   * заменяет прежний целиком; вместе с ним пишутся время и ассистент хода.
   *
   * Сначала чистка (sanitizeUploadNote: переводы строк, управляющие символы,
   * символы формата \p{Cf} кроме ZWJ, края), потом подсчёт: сохраняется
   * ровно очищенная строка, а из одних невидимых символов — пустая, BadRequest.
   * Длина — в символах (Array.from), как char_length в CHECK миграции 002:
   * эмодзи в JS — две единицы UTF-16, а в Postgres — один символ.
   * Владелец — условием UPDATE: чужой и несуществующий id неразличимы
   * (NotFoundException), как в openDownload. Id не формата UUID отсекается до
   * запроса: Postgres упал бы на приведении к uuid, и вместо «не найден»
   * вышла бы 500. Пустой userId — тоже NotFound без запроса, как в loadOwned.
   * loadOwned здесь не подходит — его отдельный SELECT лишний: владельца
   * проверяет сам UPDATE.
   */
  async setNote(input: {
    id: string;
    userId: string;
    note: string;
    assistantId: string | null;
  }): Promise<ChatUploadRecord> {
    const note = sanitizeUploadNote(input.note);
    const chars = Array.from(note).length;
    if (chars < 1 || chars > UPLOAD_NOTE_MAX_CHARS) {
      throw new BadRequestException(`Комментарий — от 1 до ${UPLOAD_NOTE_MAX_CHARS} символов`);
    }
    if (!input.userId || !UUID_RE.test(String(input.id))) throw new NotFoundException('Upload not found');
    const { rows } = await this.pg.query(
      `UPDATE chat_uploads
          SET note = $3, note_updated_at = now(), note_assistant_id = $4
        WHERE id = $1 AND user_id = $2
        RETURNING ${COLUMNS}`,
      [input.id, input.userId, note, input.assistantId ?? null],
    );
    return this.row(rows[0]);
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
      ...records.map((record) => this.assistantLine(record)),
    ].join('\n');
  }

  /**
   * Строка файла в блоке загрузок (spec 2026-11-16, раздел 2): id — чтобы
   * передать его в note_file, имя, вид (uploadKind — тот же, что в панели),
   * дата загрузки и комментарий ассистента; со следующей строки, с отступом, —
   * подписанная ссылка, как и раньше.
   *
   * Имя — через safeFileName, как в find_files: оно пришло из multipart, и
   * перевод строки в нём дописал бы в блок «свою» строку; «|» в имени
   * заменяется на «¦» — иначе имя подделало бы поля строки (вид, дата,
   * комментарий). Комментарий пишет модель: на выводе он проходит
   * uploadNoteOneLine (ещё раз sanitizeUploadNote — строка могла попасть в
   * базу в обход setNote — и схлопывание пробельных символов) по той же
   * причине, что и имя; тот же вывод — у поля note в find_files. «|» в
   * комментарии остаётся: это последнее поле. Пусто после чистки — комментария
   * нет.
   */
  private assistantLine(record: ChatUploadRecord): string {
    const note = uploadNoteOneLine(record.note);
    const head = [
      `- id=${record.id}`,
      safeFileName(record.originalName).replace(/\|/g, '¦'),
      uploadKind(record),
      String(record.createdAt ?? '').slice(0, 10),
      `комментарий: ${note || UPLOAD_NOTE_MISSING}`,
    ].join(' | ');
    return `${head}\n  ${this.assistantUrl(record.id)}`;
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
