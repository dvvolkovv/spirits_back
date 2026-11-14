import { Injectable, OnModuleInit } from '@nestjs/common';
import { AccountDeletionRegistry } from '../../account-deletion/account-deletion.registry';
import {
  DeletionCancelledError,
  DeletionRetryError,
  deletionErrorKind,
  deletionResourceHash,
} from '../../account-deletion/account-deletion.safe';
import type {
  AccountDeletionAdapter,
  DeletionDiscovery,
  DeletionExecution,
  DeletionJobRow,
  DeletionJobSpec,
  DeletionPlan,
  DeletionResourceType,
  DeletionSkip,
} from '../../account-deletion/account-deletion.types';
import type { StorageService } from '../../common/services/storage.service';
import { chatFilesBucket } from './chat-file-store';
import { extractEnv } from './chat-files.service';
import { extractChatFiles } from './extract';
import type { ExtractEnv } from './extract';
import { safeDecode } from './file-meta';
import { encodeKeyPath, IMAGE_EXT_RE, THUMB_BUCKET, thumbKeyFor } from './thumbnails';

/**
 * Task 11 — файлы переписки при удалении аккаунта.
 *
 * История чата стирается сразу, поэтому ссылки фиксируются job'ами ДО её
 * удаления: discovery исчерпывающе читает custom_chat_history удалённого
 * поколения (keyset-пагинация, обе роли отправителя, без потолков на число
 * строк) и сохраняет из каждого файла только MinIO locator. payload.key —
 * base64url от сырого ключа: имя файла задаёт пользователь/модель, в нём
 * реальны '%' (decodeURIComponent в fail-closed sanitizer бросает) и
 * фрагменты userId (includes-проверка) — сырой ключ забраковал бы ВЕСЬ план
 * удаления аккаунта. Алфавит A-Za-z0-9-_ безопасен для любого имени.
 * В payload нет ни личных текстов, ни userId, ни полных URL с доменом —
 * fail-closed sanitizer это дополнительно проверяет.
 *
 * Границы: объекты video_jobs, speech_clips и /static/generated чистят
 * Task 12/13 из канонических строк (video_jobs/speech_clips/generated_images
 * переживают удаление истории), поэтому маркеры [VIDEO_JOB:…] и {{audio:…}}
 * здесь jobs не порождают — проверяется только владение: чужой или
 * несуществующий id даёт skip owner_unverifiable (модель могла выдумать
 * маркер, а объект с таким id — чужой). Файлы релея (/tmp) и произвольные
 * external URL не удаляются никогда.
 *
 * Purge удаляет объект только при подтверждённом ЕДИНОЛИЧНОМ владении:
 * перед удалением ссылка ищется во всех местах, где мог остаться адрес
 * (история всех пользователей, generated_images, video_jobs, speech_clips,
 * voice_calls и DOC_PLACES-площадки задач/планов/звонов). Чужая ссылка —
 * объект сохраняется, job успешен. Собственная каноническая строка ещё на
 * месте — retry (kind db): порядок дожимается повторами, не зависимостью.
 * Удаление — только подтверждённое (deleteConfirmed): 2xx и отсутствующий
 * объект — успех, любой неизвестный исход — retry.
 */

/** Сколько строк истории читать за один запрос discovery. */
export const CHAT_FILE_PAGE_SIZE = 500;

export interface ChatFileDiscovery extends DeletionDiscovery {
  /** Размер keyset-страницы (тесты); по умолчанию CHAT_FILE_PAGE_SIZE. */
  pageSize?: number;
  /** Окружение для extractChatFiles; по умолчанию — extractEnv() из process.env. */
  env?: ExtractEnv;
}

/** Колонка места: имя (для drift-guard) и SQL-выражение (jsonb — с ::text). */
export interface RefColumnSpec {
  readonly column: string;
  readonly sql: string;
}

/**
 * Место, где может остаться адрес файла: таблица, FROM (у LEFT JOIN-площадок
 * главная таблица стоит ПЕРВОЙ — контракт /FROM (\w+)/ в фейковых БД спек),
 * предикат «строка принадлежит удаляемому аккаунту» ($1 — userId) и колонки.
 * Список обязан покрывать DOC_PLACES (voice-document-migration.ts) — это
 * держит drift-guard тест chat-file-ref-places.spec.ts.
 */
export interface RefPlaceSpec {
  readonly table: string;
  readonly from: string;
  readonly own: string;
  readonly columns: readonly RefColumnSpec[];
}

export const CHAT_FILE_REF_PLACES: readonly RefPlaceSpec[] = [
  // История ВСЕХ пользователей: общий файл переживает удаление одного аккаунта.
  {
    table: 'custom_chat_history',
    from: 'custom_chat_history',
    own: `custom_chat_history.session_id LIKE $1 || '\\_%' ESCAPE '\\'`,
    columns: [{ column: 'content', sql: 'content' }],
  },
  {
    table: 'generated_images',
    from: 'generated_images',
    own: 'generated_images.user_id = $1',
    columns: [{ column: 'image_url', sql: `coalesce(image_url, '')` }],
  },
  {
    table: 'video_jobs',
    from: 'video_jobs',
    own: 'video_jobs.user_id = $1',
    columns: [
      { column: 'video_url', sql: `coalesce(video_url, '')` },
      { column: 'thumbnail_url', sql: `coalesce(thumbnail_url, '')` },
      { column: 'audio_url', sql: `coalesce(audio_url, '')` },
      { column: 'source_image_url', sql: `coalesce(source_image_url, '')` },
    ],
  },
  {
    table: 'speech_clips',
    from: 'speech_clips',
    own: 'speech_clips.user_id = $1',
    columns: [{ column: 'url', sql: `coalesce(url, '')` }],
  },
  {
    table: 'voice_calls',
    from: 'voice_calls',
    own: 'voice_calls.user_id = $1',
    columns: [
      { column: 'transcript', sql: 'transcript::text' },
      { column: 'summary', sql: `coalesce(summary, '')` },
      { column: 'recording_url', sql: `coalesce(recording_url, '')` },
    ],
  },
  {
    table: 'voice_call_jobs',
    from: 'voice_call_jobs LEFT JOIN voice_calls ON voice_calls.id = voice_call_jobs.call_id',
    own: 'voice_calls.user_id = $1',
    columns: [
      { column: 'question', sql: `coalesce(question, '')` },
      { column: 'answer', sql: `coalesce(answer, '')` },
    ],
  },
  {
    table: 'action_plans',
    from: 'action_plans',
    own: 'action_plans.user_id = $1',
    columns: [
      { column: 'summary', sql: `coalesce(summary, '')` },
      { column: 'items', sql: 'items::text' },
    ],
  },
  {
    table: 'tasks',
    from: 'tasks',
    own: 'tasks.user_id = $1',
    columns: [
      { column: 'summary', sql: `coalesce(summary, '')` },
      { column: 'claudemd', sql: `coalesce(claudemd, '')` },
    ],
  },
  {
    table: 'task_events',
    from: 'task_events LEFT JOIN tasks ON tasks.id = task_events.task_id',
    own: 'tasks.user_id = $1',
    columns: [{ column: 'content', sql: 'content' }],
  },
];

function refPlaces(needlesCount: number): Array<{ sql: string }> {
  // $1 — userId; $2..$N — варианты написания locator'а (см. needlesFor).
  return CHAT_FILE_REF_PLACES.map((place) => {
    const ors: string[] = [];
    for (let n = 0; n < needlesCount; n += 1) {
      for (const col of place.columns) ors.push(`position($${n + 2} IN ${col.sql}) > 0`);
    }
    return {
      sql: `SELECT count(*)::int AS total, count(*) FILTER (WHERE ${place.own})::int AS own
            FROM ${place.from}
           WHERE (${ors.join(' OR ')})`,
    };
  });
}

/**
 * Варианты написания locator'а в текстах: сырой ключ, encodeStrict-кодирование
 * (наш store) и encodeURIComponent-кодирование (исторические ссылки и копия
 * chat-file-store в URL). Совпадение любого из них считается ссылкой.
 */
function needlesFor(bucket: string, key: string): string[] {
  const forms = new Set<string>([
    key,
    encodeKeyPath(key),
    key.split('/').map(encodeURIComponent).join('/'),
  ]);
  return [...forms].map((form) => `${bucket}/${form}`);
}

function isSafeKey(key: string): boolean {
  if (typeof key !== 'string' || key.length === 0) return false;
  return !key.split('/').some((seg) => seg === '' || seg === '.' || seg === '..');
}

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Декодирование payload.key (base64url от сырого ключа), fail-closed:
 * вне алфавита, padding, неканоническое кодирование и не-UTF-8 — null.
 * Round-trip отсекает всё, что Buffer.from проглатывает молча.
 */
function decodeKeyPayload(value: unknown): string | null {
  if (typeof value !== 'string' || !BASE64URL_RE.test(value)) return null;
  const decoded = Buffer.from(value, 'base64url').toString('utf8');
  if (decoded.length === 0) return null;
  if (Buffer.from(decoded, 'utf8').toString('base64url') !== value) return null;
  return decoded;
}

/**
 * Исчерпывающий snapshot ссылок на файлы переписки удалённого поколения.
 * Keyset-пагинация (id > $2 ORDER BY id LIMIT) без потолка на число строк;
 * generation predicate в EXISTS: планируем, лишь пока строка удалённого
 * поколения на месте.
 */
export async function discoverChatFiles(ctx: ChatFileDiscovery): Promise<DeletionPlan> {
  const { db, account } = ctx;
  const env = ctx.env ?? extractEnv();
  const pageSize = ctx.pageSize ?? CHAT_FILE_PAGE_SIZE;
  const bucket = chatFilesBucket();
  const prefix = `${env.publicBaseUrl}/${bucket}/`;

  const jobs: DeletionJobSpec[] = [];
  const skips: DeletionSkip[] = [];
  const seenKeys = new Set<string>();
  const seenMarkers = new Set<string>();
  let ownerUnverifiable = false;

  let lastId = 0;
  for (;;) {
    // LIKE '<userId>\_%': разделительный '_' экранирован, но _/% внутри самого
    // userId — нет: internal_id это телефон (цифры) или UUID, LIKE-мета-символов
    // там не бывает.
    const res = await db.query(
      `SELECT h.id, h.content
         FROM custom_chat_history h
        WHERE h.session_id LIKE $1 || '\\_%' ESCAPE '\\'
          AND h.id > $2
          AND EXISTS (
            SELECT 1 FROM user_id u
            WHERE u.internal_id = $1 AND u.state = 'deleted' AND u.deletion_id = $3
          )
        ORDER BY h.id
        LIMIT $4`,
      [account.userId, lastId, account.deletionId, pageSize],
    );
    const rows = res.rows ?? [];
    if (rows.length === 0) break;
    for (const row of rows) {
      lastId = Math.max(lastId, Number(row.id));
      for (const file of extractChatFiles(String(row.content ?? ''), env)) {
        if (file.source === 'video_job' || file.source === 'audio_clip') {
          const marker = `${file.source}:${file.refId}`;
          if (seenMarkers.has(marker)) continue;
          seenMarkers.add(marker);
          // Модель могла выдумать маркер: объект чистится по канонической
          // строке (Task 12/13) и только если строка принадлежит аккаунту.
          const table = file.source === 'video_job' ? 'video_jobs' : 'speech_clips';
          const own = await db.query(
            `SELECT 1 FROM ${table} WHERE id = $1 AND user_id = $2`,
            [file.refId, account.userId],
          );
          if ((own.rows?.length ?? 0) === 0) ownerUnverifiable = true;
          continue;
        }
        const url = file.url;
        // Allowlist: только публичный URL нашего бакета файлов переписки.
        // Релей, /static, чужие бакеты и external — не наши объекты. Пустой
        // publicBaseUrl (окружение не настроено) — не совпадает ничего, как
        // в ours() у extractChatFiles.
        if (!url || env.publicBaseUrl === '' || !url.startsWith(prefix)) continue;
        const path = url.slice(prefix.length).split(/[?#]/)[0];
        const key = path.split('/').map(safeDecode).join('/');
        if (!isSafeKey(key) || seenKeys.has(key)) continue;
        seenKeys.add(key);
        jobs.push({
          resourceType: 'chat-file.purge',
          resourceKey: deletionResourceHash(bucket, key),
          phase: 'purge',
          // key — base64url: сырое имя может содержать '%' или фрагмент userId,
          // что роняет fail-closed sanitizer на весь план (см. шапку файла).
          payload: { bucket, key: Buffer.from(key, 'utf8').toString('base64url') },
        });
      }
    }
  }

  if (ownerUnverifiable) {
    skips.push({ resourceType: 'chat-file.purge', reason: 'owner_unverifiable' });
  }
  return { jobs, skips };
}

@Injectable()
export class ChatFileAccountDeletionAdapter implements OnModuleInit, AccountDeletionAdapter {
  readonly resourceTypes: readonly DeletionResourceType[] = ['chat-file.purge'];

  constructor(
    private readonly storage: StorageService,
    private readonly registry: AccountDeletionRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async execute(job: DeletionJobRow, ctx: DeletionExecution): Promise<void> {
    if (job.resourceType !== 'chat-file.purge') {
      throw new Error('unsupported_deletion_resource');
    }
    const bucket = typeof job.payload?.bucket === 'string' ? job.payload.bucket : '';
    // Payload мог прийти только из нашего discovery, но purge исполняется
    // через 30 дней: base64url-ключ декодируется fail-closed, allowlist бакета
    // и проверка на traversal выполняются на ДЕКОДИРОВАННОМ ключе заново.
    // Несовпадение — рассогласование схемы/данных: retry, а не слепое удаление.
    const key = decodeKeyPayload(job.payload?.key);
    if (key === null || bucket !== chatFilesBucket() || !isSafeKey(key)) {
      throw new DeletionRetryError('db');
    }

    await ctx.assertCurrent(job);
    // Чужая ссылка на тот же объект — объект сохраняется, job успешен.
    if (await this.hasForeignReference(job, ctx, bucket, key)) return;
    await ctx.assertCurrent(job);

    await this.deleteConfirmedOrRetry({ bucket, key });

    if (IMAGE_EXT_RE.test(key)) {
      await ctx.assertCurrent(job);
      await this.deleteConfirmedOrRetry({
        bucket: THUMB_BUCKET,
        key: thumbKeyFor({ bucket, key }),
      });
    }
  }

  /**
   * Единственность владения перед КАЖДЫМ удалением: true — объект нужен
   * чужим данным (удалять нельзя); собственная каноническая строка ещё на
   * месте — retry kind db (её удалит её задача, повтор дождётся).
   */
  private async hasForeignReference(
    job: DeletionJobRow,
    ctx: DeletionExecution,
    bucket: string,
    key: string,
  ): Promise<boolean> {
    const needles = needlesFor(bucket, key);
    for (const place of refPlaces(needles.length)) {
      const res = await ctx.db.query(place.sql, [job.userId, ...needles]);
      const row = res.rows?.[0] ?? {};
      const total = Number(row.total ?? 0);
      const own = Number(row.own ?? 0);
      if (total > own) return true;
      if (own > 0) throw new DeletionRetryError('db');
    }
    return false;
  }

  /**
   * Подтверждённый исход удаления: 'deleted' и 'absent' (объекта уже нет) —
   * успех; любая прочая ошибка MinIO — retry с классификацией, а не тихий
   * успех: неподтверждённое удаление не должно терять объект.
   */
  private async deleteConfirmedOrRetry(target: { bucket: string; key: string }): Promise<void> {
    try {
      await this.storage.deleteConfirmed(target);
    } catch (error) {
      if (error instanceof DeletionCancelledError) throw error;
      throw new DeletionRetryError(deletionErrorKind(error));
    }
  }
}
