import { Injectable, OnModuleInit } from '@nestjs/common';
import { CHAT_FILE_REF_PLACES } from '../chat/chat-files/chat-file-account-deletion.adapter';
import { AccountDeletionRegistry } from '../account-deletion/account-deletion.registry';
import {
  DeletionCancelledError,
  DeletionRetryError,
  deletionErrorKind,
  deletionResourceHash,
} from '../account-deletion/account-deletion.safe';
import type {
  AccountDeletionAdapter,
  DeletionDiscovery,
  DeletionExecution,
  DeletionJobRow,
  DeletionJobSpec,
  DeletionPlan,
  DeletionResourceType,
  DeletionSkip,
} from '../account-deletion/account-deletion.types';
import type { StorageService } from '../common/services/storage.service';
import { DOCS_BUCKET } from './voice-call.types';
import { voiceDocumentFolder, voiceDocumentKey } from './voice-document-key';
import { DOC_PLACES } from './voice-document-migration';

/**
 * Task 15 — голосовые документы (documents/<папка>/<docId>.md в DOCS_BUCKET)
 * при удалении аккаунта.
 *
 * Порядок «references, затем rows»: объекты документов удаляются ДО строк
 * voice_calls (правило каталога voice.purge ждёт allOf voice-document.purge),
 * иначе transcript/summary с адресом исчезли бы раньше объекта и документ
 * остался бы сиротой в бакете.
 *
 * Discovery сканирует ВСЕ площадки DOC_PLACES (те же, что читает миграция
 * документов) по двум вариантам папки: hashed (солёный relayFsKey — текущая
 * схема) и legacy (папка = сам userId — схема до 02.11.2026). Сканирование
 * идёт без фильтра владельца: папка уникальна для аккаунта, а ссылку модель
 * могла переписать и в чужую строку — судьбу объекта решает ref-check.
 * В payload попадают только {docId, keyKind}: ни ключа, ни userId, ни URL —
 * legacy-папка вычисляется из job.userId заново в execute и НИКОГДА не лежит
 * в payload (fail-closed sanitizer это дополнительно проверяет).
 *
 * Ref-check переиспользует данные CHAT_FILE_REF_PLACES (Task 11): те же
 * count(total)/count FILTER(own) запросы по всем местам, где мог остаться
 * адрес. Чужая ссылка — объект сохраняется (shared document), job успешен.
 * ОТЛИЧИЕ от Task 11: собственная ссылка НЕ даёт retry. Там retry дожимал
 * порядок «сначала каноническая строка, потом объект»; здесь свои строки
 * voice_calls удаляет voice.purge, который ждёт завершения ВСЕХ
 * voice-document.purge — retry по своей ссылке был бы deadlock'ом. Свои
 * строки уйдут позже своими задачами доменов (voice.purge, немедленное
 * стирание истории, tasks.purge), а подтверждение владения нужно только
 * затем, чтобы не удалить объект, на который смотрят чужие данные.
 *
 * Удаление — только подтверждённое (storage.deleteConfirmed): 2xx и
 * отсутствующий объект — успех, любой неизвестный исход — retry; сбой MinIO
 * сохраняет строки звонков и external IDs (бот ещё в комнате — его выведет
 * voice.stop/повтор).
 *
 * Заметки TalerID: VoiceDocumentService хранит id созданных заметок только
 * в in-memory Map (notesByCall), поэтому через 30 дней purge их не
 * восстановить и перечислить — перебор/удаление «всех заметок» запрещён.
 * Discovery отдаёт ОДИН агрегированный skip external_note_id_unavailable
 * (без внешних вызовов TalerID), если у аккаунта было подключение и звонки.
 */

const UUID_RE_SRC = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** Строгий UUID-формат docId/callId: payload исполняется через 30 дней. */
export const VOICE_DELETION_UUID_RE = new RegExp(`^${UUID_RE_SRC}$`, 'i');

const likeSubstring = (s: string): string => `%${s.replace(/[\\%_]/g, '\\$&')}%`;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface DocScanPlace {
  readonly table: string;
  readonly columns: Array<{ readonly column: string; readonly sql: string }>;
}

/** DOC_PLACES, сгруппированные по таблицам (jsonb читается как ::text). */
const DOC_SCAN_PLACES: readonly DocScanPlace[] = (() => {
  const byTable = new Map<string, DocScanPlace>();
  for (const place of DOC_PLACES) {
    let scan = byTable.get(place.table);
    if (!scan) {
      scan = { table: place.table, columns: [] };
      byTable.set(place.table, scan);
    }
    scan.columns.push({
      column: place.column,
      sql: `coalesce(${place.column}${place.jsonb ? '::text' : ''}, '')`,
    });
  }
  return [...byTable.values()];
})();

/**
 * Исчерпывающий snapshot ссылок на документы удалённого поколения: каждая
 * площадка DOC_PLACES опрашивается по hashed- и legacy-папке (LIKE ANY-образ
 * одного паттерна), generation predicate в EXISTS — планируем, лишь пока
 * строка удалённого поколения на месте. LIMIT нет: LIKE по уникальной папке
 * аккаунта заведомо выбирает только его документы.
 */
export async function discoverVoiceDocuments(ctx: DeletionDiscovery): Promise<DeletionPlan> {
  const { db, account } = ctx;
  const jobs: DeletionJobSpec[] = [];
  const skips: DeletionSkip[] = [];

  // Без RELAY_FS_SALT/JWT_SECRET hashed-папки не существует (voiceDocumentFolder
  // → undefined) — fail-closed: ищем хотя бы legacy-документы.
  const hashedFolder = voiceDocumentFolder(account.userId);
  const variants: Array<{ kind: 'hashed' | 'legacy'; folder: string }> = [
    ...(hashedFolder ? [{ kind: 'hashed' as const, folder: hashedFolder }] : []),
    { kind: 'legacy', folder: account.userId },
  ];

  const seen = new Set<string>();
  for (const variant of variants) {
    const docRe = new RegExp(
      `${escapeRe(DOCS_BUCKET)}/documents/${escapeRe(variant.folder)}/(${UUID_RE_SRC})\\.md`,
      'gi',
    );
    const like = likeSubstring(`${DOCS_BUCKET}/documents/${variant.folder}/`);
    for (const place of DOC_SCAN_PLACES) {
      const selects = place.columns.map((c) => c.sql).join(` || '\n' || `);
      const ors = place.columns.map((c) => `${c.sql} LIKE $1`).join(' OR ');
      const res = await db.query(
        `SELECT ${selects} AS hay
           FROM ${place.table}
          WHERE (${ors})
            AND EXISTS (
              SELECT 1 FROM user_id u
              WHERE u.internal_id = $2 AND u.state = 'deleted' AND u.deletion_id = $3
            )`,
        [like, account.userId, account.deletionId],
      );
      for (const row of res.rows ?? []) {
        const hay = String(row.hay ?? '');
        docRe.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = docRe.exec(hay)) !== null) {
          const docId = match[1];
          const dedupe = `${variant.kind}:${docId.toLowerCase()}`;
          if (seen.has(dedupe)) continue;
          seen.add(dedupe);
          const key = `documents/${variant.folder}/${docId}.md`;
          jobs.push({
            resourceType: 'voice-document.purge',
            resourceKey: deletionResourceHash(DOCS_BUCKET, key),
            phase: 'purge',
            payload: { docId, keyKind: variant.kind },
          });
        }
      }
    }
  }

  // Заметки TalerID: подключенный аккаунт со звонками почти наверняка имеет
  // заметки, но их id не переживают рестарт (notesByCall — in-memory). Один
  // агрегированный skip, внешних вызовов TalerID нет и перебора заметок нет.
  const talerid = await db.query(
    `SELECT EXISTS (SELECT 1 FROM talerid_connections t WHERE t.user_id = $1) AS connected,
            EXISTS (SELECT 1 FROM voice_calls c WHERE c.user_id = $1) AS has_calls
       WHERE EXISTS (
         SELECT 1 FROM user_id u
         WHERE u.internal_id = $1 AND u.state = 'deleted' AND u.deletion_id = $2
       )`,
    [account.userId, account.deletionId],
  );
  const taleridRow = talerid.rows?.[0];
  if (taleridRow?.connected === true && taleridRow?.has_calls === true) {
    skips.push({
      resourceType: 'integration.talerid.stop',
      reason: 'external_note_id_unavailable',
    });
  }

  return { jobs, skips };
}

@Injectable()
export class VoiceDocumentAccountDeletionAdapter implements OnModuleInit, AccountDeletionAdapter {
  readonly resourceTypes: readonly DeletionResourceType[] = ['voice-document.purge'];

  constructor(
    private readonly storage: StorageService,
    private readonly registry: AccountDeletionRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async execute(job: DeletionJobRow, ctx: DeletionExecution): Promise<void> {
    if (job.resourceType !== 'voice-document.purge') {
      throw new Error('unsupported_deletion_resource');
    }
    // Payload мог прийти только из нашего discovery, но purge исполняется
    // через 30 дней: docId/keyKind перепроверяются fail-closed. Рассогласование
    // — retry db, а не слепое удаление по произвольной строке.
    const docId = job.payload?.docId;
    const keyKind = job.payload?.keyKind;
    if (
      typeof docId !== 'string' || !VOICE_DELETION_UUID_RE.test(docId)
      || (keyKind !== 'hashed' && keyKind !== 'legacy')
    ) {
      throw new DeletionRetryError('db');
    }
    // Ключ строится из job.userId (он в payload не попадает): hashed — солёная
    // папка relayFsKey, legacy — прежняя схема «папка = идентификатор». Без
    // секретов hashed-ключ не вычислить — retry db: окружение чинится и
    // попытка повторяется, тихий успех исключён.
    const key = keyKind === 'hashed'
      ? voiceDocumentKey(job.userId, docId)
      : `documents/${job.userId}/${docId}.md`;
    if (!key) throw new DeletionRetryError('db');

    await ctx.assertCurrent(job);
    // Чужая ссылка — shared document сохраняется, job успешен. Собственная
    // ссылка retry НЕ даёт — см. шапку файла (deadlock с voice.purge).
    if (await this.hasForeignReference(job, ctx, key)) return;
    await ctx.assertCurrent(job);

    try {
      await this.storage.deleteConfirmed({ bucket: DOCS_BUCKET, key });
    } catch (error) {
      if (error instanceof DeletionCancelledError) throw error;
      throw new DeletionRetryError(deletionErrorKind(error));
    }
    // Внешний вызов мог занять время: поколение и lease перепроверяются до
    // того, как job считается выполненным.
    await ctx.assertCurrent(job);
  }

  /**
   * Единственность владения: ссылка ищется во ВСЕХ местах CHAT_FILE_REF_PLACES
   * (drift-guard chat-file-ref-places.spec.ts держит их синхронными с
   * DOC_PLACES). total > own — на объект смотрят чужие данные, удалять нельзя.
   */
  private async hasForeignReference(
    job: DeletionJobRow,
    ctx: DeletionExecution,
    key: string,
  ): Promise<boolean> {
    const needle = `${DOCS_BUCKET}/${key}`;
    for (const place of CHAT_FILE_REF_PLACES) {
      const ors = place.columns.map((col) => `position($2 IN ${col.sql}) > 0`).join(' OR ');
      const res = await ctx.db.query(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE ${place.own})::int AS own
           FROM ${place.from}
          WHERE (${ors})`,
        [job.userId, needle],
      );
      const row = res.rows?.[0] ?? {};
      if (Number(row.total ?? 0) > Number(row.own ?? 0)) return true;
    }
    return false;
  }
}
