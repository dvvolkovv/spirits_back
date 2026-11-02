import { DOCS_BUCKET } from './voice-call.types';
import { voiceDocumentFolder } from './voice-document-key';
import { requireRelayFsSalt } from '../common/one-off-script';

/**
 * Разовый перенос голосовых документов из documents/<id>/<docId>.md в папку
 * солёного хэша пользователя — documents/<fsKey>/<docId>.md (спека
 * 2026-11-02-pii-out-of-prompts-design.md, п. 2; новые документы так
 * выкладывает VoiceDocumentService с этой правки).
 *
 * --apply, в этом порядке:
 *   1. ссылки прежнего вида ищутся во всех местах DOC_PLACES (в истории чата —
 *      только строки старше часа: свежую держит открытая вкладка, а фронт
 *      сверяет ленту с историей посимвольно — как у переноса ссылок релея);
 *   2. объект копируется под новый ключ (скачать — положить — сверить размер);
 *   3. адрес заменяется в каждой найденной строке — с проверкой прежнего
 *      значения: строку, которую успели изменить, не трогаем;
 *   4. если на старый ключ в базе не осталось ни одной ссылки (по всем местам и
 *      без отбора по возрасту) — в журнал «replaced»: старый объект можно
 *      удалять.
 * Старые объекты --apply НЕ удаляет (ревью ветки): это делает отдельный
 * --delete-old <журнал> (deleteOldDocuments), когда решит владелец, — и тогда
 * обрыв между заменой и удалением ничего не теряет.
 *
 * Объекта нет вовсе (ссылка и так мёртвая) — адрес всё равно меняется: номера
 * в тексте не остаётся, а потерять нечего.
 *
 * Журнал — только места и ключи, без текстов: по нему откат возвращает
 * адреса и удалённые --delete-old объекты (копией с нового ключа). Новые
 * объекты откат не удаляет.
 */

/** Место, где лежит ссылка на документ: таблица и колонка с текстом или JSON. */
export interface DocPlace {
  table: string;
  column: string;
  jsonb?: boolean;
  /** Колонка времени строки: если задана, --apply и сухой прогон берут только строки старше часа. */
  ageColumn?: string;
}

/**
 * Где хранится адрес документа. Первые два места пишет код, остальные — тексты,
 * которые модель пишет по переписке и расшифровке: ссылку она может
 * переписать дословно.
 */
export const DOC_PLACES: readonly DocPlace[] = [
  // Сам документ в чате: «[Открыть документ полностью](адрес)» — voice-document.service.ts.
  // Карточка итогов звонка там же, и её текст пишет модель.
  { table: 'custom_chat_history', column: 'content', ageColumn: 'created_at' },
  // Ссылка, отправленная в чат встречи, ложится в расшифровку:
  // «[в чат] Документ «…»: адрес» — voice-host/src/agent.ts (document_ready).
  { table: 'voice_calls', column: 'transcript', jsonb: true },
  // Итоги звонка — модель по расшифровке (voice-call.service.ts, summarize).
  { table: 'voice_calls', column: 'summary' },
  // Вопрос специалисту пишет Роман, ответ — специалист (specialist-job.service.ts).
  { table: 'voice_call_jobs', column: 'question' },
  { table: 'voice_call_jobs', column: 'answer' },
  // План действий — модель по последним репликам чата (action-plans.service.ts).
  { table: 'action_plans', column: 'summary' },
  { table: 'action_plans', column: 'items', jsonb: true },
  // Задачи — модель по ходу чата и по звонку (tasks.service.ts, extractFromTurn).
  { table: 'tasks', column: 'summary' },
  { table: 'tasks', column: 'claudemd' },
  { table: 'task_events', column: 'content' },
];

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** <бакет>/documents/<папка>/<docId>.md. Папка — до слэша, без пробелов, кавычек и скобок. */
const DOC_REF_RE = new RegExp(`${DOCS_BUCKET}/documents/([^/\\s"'()<>\\[\\]\\\\]+)/(${UUID})\\.md`, 'gi');
/** Новая папка — 32 hex солёного хэша (relayFsKey). */
const NEW_FOLDER_RE = /^[0-9a-f]{32}$/;

export interface DocRef {
  /** Ключ в бакете: documents/<папка>/<docId>.md. */
  oldKey: string;
  folder: string;
  docId: string;
}

/** Ссылки на документы прежнего вида (папка — идентификатор пользователя), без повторов, по порядку. */
export function collectLegacyDocRefs(text: string): DocRef[] {
  const out = new Map<string, DocRef>();
  for (const m of String(text ?? '').matchAll(DOC_REF_RE)) {
    const [, folder, docId] = m;
    if (NEW_FOLDER_RE.test(folder)) continue;
    const oldKey = `documents/${folder}/${docId}.md`;
    if (!out.has(oldKey)) out.set(oldKey, { oldKey, folder, docId });
  }
  return [...out.values()];
}

export interface MigrationPg {
  query: (sql: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
}

/** Нужное от StorageService (common/services/storage.service.ts). */
export interface MigrationStore {
  head: (bucket: string, key: string) => Promise<{ size: number; contentType?: string } | null>;
  download: (i: { bucket: string; key: string }) => Promise<Buffer>;
  upload: (i: { bucket: string; key: string; body: Buffer; contentType?: string; cacheControl?: string }) => Promise<string>;
  delete: (i: { bucket: string; key: string }) => Promise<void>;
}

export type DocJournalEntry =
  | { kind: 'copied'; from: string; to: string }
  | { kind: 'row'; table: string; column: string; id: string; from: string; to: string }
  /** Скопирован, и ссылок на старый ключ в базе не осталось — --delete-old может удалить старый объект. */
  | { kind: 'replaced'; from: string; to: string }
  /** Старый объект удалён (--delete-old). */
  | { kind: 'deleted'; from: string; to: string };

export interface DocMigrationSummary {
  /** «таблица.колонка» → строк со ссылками прежнего вида (только места, где они есть). */
  rowsByPlace: Record<string, number>;
  /** Места, которых нет в базе, — пропущены. */
  missingPlaces: string[];
  /** Документов прежнего вида, на которые есть ссылки. */
  docs: number;
  /** Старый объект на месте — копируется. */
  present: number;
  /** Старого объекта нет, новый есть — копия уже была. */
  alreadyCopied: number;
  /** Нет ни старого, ни нового объекта — ссылка мёртвая, адрес меняется без копии. */
  missing: number;
  copied: number;
  copyFailed: number;
  updatedRows: number;
  skippedRows: number;
  /** Записано «replaced»: старый объект можно удалить --delete-old. */
  readyToDelete: number;
  /** Скопирован, но на старый ключ в базе ещё есть ссылки (пропущенные или свежие строки) — старый объект нужен. */
  stillReferenced: number;
}

/** Тот же тип и кэш, что у VoiceDocumentService.publish. */
const DOC_CONTENT_TYPE = 'text/plain; charset=utf-8';
const DOC_CACHE_CONTROL = 'public, max-age=31536000';

const placeName = (p: DocPlace) => `${p.table}.${p.column}`;

async function placeExists(pg: MigrationPg, p: DocPlace): Promise<boolean> {
  const r = await pg.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = ANY (current_schemas(false)) AND table_name = $1 AND column_name = $2`,
    [p.table, p.column],
  );
  return r.rows.length > 0;
}

/** Замена значения с проверкой прежнего: строку, изменённую с момента чтения, не трогаем. */
function updateSql(p: DocPlace): string {
  return p.jsonb
    ? `UPDATE ${p.table} SET ${p.column} = $1::jsonb WHERE id = $2 AND ${p.column}::text = $3`
    : `UPDATE ${p.table} SET ${p.column} = $1 WHERE id = $2 AND ${p.column} = $3`;
}

const swapKey = (text: string, from: string, to: string) =>
  text.split(`${DOCS_BUCKET}/${from}`).join(`${DOCS_BUCKET}/${to}`);

/** Шаблон LIKE на подстроку: «\», «%» и «_» в ней — буквально. */
const likeSubstring = (s: string) => `%${s.replace(/[\\%_]/g, '\\$&')}%`;

/**
 * Какие из ключей ещё упоминаются в базе — по всем местам и без отбора по
 * возрасту строки: свежая строка со старым адресом тоже держит старый объект.
 */
async function findReferencedKeys(
  pg: MigrationPg,
  keys: string[],
  places: readonly DocPlace[] = DOC_PLACES,
): Promise<Set<string>> {
  const found = new Set<string>();
  if (keys.length === 0) return found;
  const patterns = keys.map((k) => likeSubstring(`${DOCS_BUCKET}/${k}`));
  for (const place of places) {
    if (!(await placeExists(pg, place))) continue;
    const { rows } = await pg.query(
      `SELECT ${place.column}::text AS v FROM ${place.table} WHERE ${place.column}::text LIKE ANY ($1::text[])`,
      [patterns],
    );
    for (const r of rows) {
      for (const k of keys) if (String(r.v).includes(`${DOCS_BUCKET}/${k}`)) found.add(k);
    }
  }
  return found;
}

interface FoundRow {
  place: DocPlace;
  id: string;
  value: string;
  refs: DocRef[];
}

type DocState = 'present' | 'alreadyCopied' | 'missing';

export async function runDocumentMigration(p: {
  pg: MigrationPg;
  store: MigrationStore;
  apply: boolean;
  journal: (e: DocJournalEntry) => void;
  log: (m: string) => void;
  places?: readonly DocPlace[];
}): Promise<DocMigrationSummary> {
  // Соль — только RELAY_FS_SALT, как у приложения: отказ до первого запроса.
  requireRelayFsSalt();
  const places = p.places ?? DOC_PLACES;
  const s: DocMigrationSummary = {
    rowsByPlace: {}, missingPlaces: [], docs: 0, present: 0, alreadyCopied: 0, missing: 0,
    copied: 0, copyFailed: 0, updatedRows: 0, skippedRows: 0, readyToDelete: 0, stillReferenced: 0,
  };

  // 1. Где лежат ссылки прежнего вида.
  const found: FoundRow[] = [];
  for (const place of places) {
    if (!(await placeExists(p.pg, place))) {
      s.missingPlaces.push(placeName(place));
      p.log(`места ${placeName(place)} в базе нет — пропущено`);
      continue;
    }
    const age = place.ageColumn ? ` AND ${place.ageColumn} < now() - interval '1 hour'` : '';
    const { rows } = await p.pg.query(
      `SELECT id::text AS id, ${place.column}::text AS v FROM ${place.table}
        WHERE ${place.column}::text LIKE $1${age} ORDER BY id`,
      [`%${DOCS_BUCKET}/documents/%`],
    );
    let n = 0;
    for (const r of rows) {
      const refs = collectLegacyDocRefs(r.v);
      if (refs.length === 0) continue;
      found.push({ place, id: String(r.id), value: String(r.v), refs });
      n++;
    }
    if (n > 0) s.rowsByPlace[placeName(place)] = n;
  }

  const docs = new Map<string, DocRef & { newKey: string }>();
  for (const f of found) {
    for (const ref of f.refs) {
      if (!docs.has(ref.oldKey)) {
        docs.set(ref.oldKey, { ...ref, newKey: `documents/${voiceDocumentFolder(ref.folder)}/${ref.docId}.md` });
      }
    }
  }
  s.docs = docs.size;
  p.log(`строк со ссылками прежнего вида: ${found.length}, документов: ${docs.size}`);

  // 2. Состояние объектов и копия.
  const copiedKeys: string[] = [];
  const ready = new Set<string>();
  for (const d of docs.values()) {
    const old = await p.store.head(DOCS_BUCKET, d.oldKey);
    const state: DocState = old ? 'present' : (await p.store.head(DOCS_BUCKET, d.newKey)) ? 'alreadyCopied' : 'missing';
    s[state]++;
    if (!p.apply) continue;
    if (state !== 'present') {
      ready.add(d.oldKey);
      continue;
    }
    try {
      const body = await p.store.download({ bucket: DOCS_BUCKET, key: d.oldKey });
      await p.store.upload({
        bucket: DOCS_BUCKET,
        key: d.newKey,
        body,
        contentType: old.contentType || DOC_CONTENT_TYPE,
        cacheControl: DOC_CACHE_CONTROL,
      });
      const copy = await p.store.head(DOCS_BUCKET, d.newKey);
      if (!copy || copy.size !== old.size) throw new Error(`размер копии ${copy?.size} ≠ ${old.size}`);
      copiedKeys.push(d.oldKey);
      ready.add(d.oldKey);
      s.copied++;
      p.journal({ kind: 'copied', from: d.oldKey, to: d.newKey });
    } catch (e: any) {
      s.copyFailed++;
      p.log(`копия не удалась, ссылки на документ не тронуты: ${e?.message || e}`);
    }
  }
  if (!p.apply) return s;

  // 3. Замена адреса во всех найденных строках.
  for (const f of found) {
    const refs = f.refs.filter((r) => ready.has(r.oldKey));
    if (refs.length === 0) continue;
    let next = f.value;
    for (const r of refs) next = swapKey(next, r.oldKey, docs.get(r.oldKey)!.newKey);
    const res = await p.pg.query(updateSql(f.place), [next, f.id, f.value]);
    if ((res.rowCount ?? 0) === 1) {
      s.updatedRows++;
      for (const r of refs) {
        p.journal({
          kind: 'row', table: f.place.table, column: f.place.column, id: f.id,
          from: r.oldKey, to: docs.get(r.oldKey)!.newKey,
        });
      }
    } else {
      s.skippedRows++;
      p.log(`строка ${placeName(f.place)} id=${f.id} изменилась во время переноса — пропущена`);
    }
  }

  // 4. «Можно удалять» — только скопированные, на старый ключ которых в базе
  // не осталось ни одной ссылки. Сами объекты здесь не удаляются.
  const still = await findReferencedKeys(p.pg, copiedKeys, places);
  for (const key of copiedKeys) {
    if (still.has(key)) {
      s.stillReferenced++;
      continue;
    }
    s.readyToDelete++;
    p.journal({ kind: 'replaced', from: key, to: docs.get(key)!.newKey });
  }
  return s;
}

/**
 * --delete-old: удалить старые объекты, записанные в журнале --apply как
 * «replaced» или «copied», — и только их. «copied» тоже: документ,
 * скопированный при пропущенной строке, доводит следующий --apply, и удалить
 * его старый объект можно и по первому журналу. Перед удалением: новая копия
 * на месте и того же размера, а в базе на старый ключ нет ни одной ссылки
 * (по всем местам, без отбора по возрасту). Иначе объект остаётся. Повторный
 * запуск ничего не делает: удалённого уже нет.
 */
export async function deleteOldDocuments(p: {
  pg: MigrationPg;
  store: MigrationStore;
  entries: DocJournalEntry[];
  journal: (e: DocJournalEntry) => void;
  log: (m: string) => void;
}): Promise<{ deleted: number; alreadyGone: number; kept: number }> {
  // Снимок до работы: журнал удалений могут дописывать в тот же массив.
  const ready = new Map<string, string>();
  for (const e of [...p.entries]) if (e.kind === 'replaced' || e.kind === 'copied') ready.set(e.from, e.to);
  let alreadyGone = 0;
  let kept = 0;
  let deleted = 0;
  const candidates: { from: string; to: string }[] = [];
  for (const [from, to] of ready) {
    const old = await p.store.head(DOCS_BUCKET, from);
    if (!old) {
      alreadyGone++;
      continue;
    }
    const copy = await p.store.head(DOCS_BUCKET, to);
    if (!copy || copy.size !== old.size) {
      kept++;
      p.log('новой копии нет или она другого размера — старый объект оставлен');
      continue;
    }
    candidates.push({ from, to });
  }
  const referenced = await findReferencedKeys(p.pg, candidates.map((c) => c.from));
  for (const c of candidates) {
    if (referenced.has(c.from)) {
      kept++;
      p.log('на старый ключ в базе есть ссылка — объект оставлен');
      continue;
    }
    try {
      await p.store.delete({ bucket: DOCS_BUCKET, key: c.from });
      deleted++;
      p.journal({ kind: 'deleted', from: c.from, to: c.to });
    } catch (e: any) {
      kept++;
      p.log(`старый объект не удалён: ${e?.message || e}`);
    }
  }
  return { deleted, alreadyGone, kept };
}

/**
 * Откат по журналу: сперва удалённые объекты (копией с нового ключа), затем
 * адреса — с той же проверкой прежнего значения. Места в журнале — только из
 * DOC_PLACES: имена таблиц и колонок уходят в текст запроса.
 */
export async function revertDocumentMigration(p: {
  pg: MigrationPg;
  store: MigrationStore;
  entries: DocJournalEntry[];
  log: (m: string) => void;
}): Promise<{ restoredObjects: number; revertedRows: number; skippedRows: number }> {
  const known = new Map(DOC_PLACES.map((x) => [placeName(x), x]));
  const rows = new Map<string, { place: DocPlace; id: string; swaps: { from: string; to: string }[] }>();
  for (const e of p.entries) {
    if (e.kind !== 'row') continue;
    const place = known.get(`${e.table}.${e.column}`);
    if (!place) throw new Error(`место ${e.table}.${e.column} не из перечня DOC_PLACES — журнал не принят`);
    const k = `${placeName(place)}#${e.id}`;
    if (!rows.has(k)) rows.set(k, { place, id: String(e.id), swaps: [] });
    rows.get(k)!.swaps.push({ from: e.from, to: e.to });
  }

  let restoredObjects = 0;
  for (const e of p.entries) {
    if (e.kind !== 'deleted') continue;
    if (await p.store.head(DOCS_BUCKET, e.from)) continue;
    const copy = await p.store.head(DOCS_BUCKET, e.to);
    const body = await p.store.download({ bucket: DOCS_BUCKET, key: e.to });
    await p.store.upload({
      bucket: DOCS_BUCKET,
      key: e.from,
      body,
      contentType: copy?.contentType || DOC_CONTENT_TYPE,
      cacheControl: DOC_CACHE_CONTROL,
    });
    restoredObjects++;
  }

  let revertedRows = 0;
  let skippedRows = 0;
  for (const r of rows.values()) {
    const { rows: cur } = await p.pg.query(
      `SELECT ${r.place.column}::text AS v FROM ${r.place.table} WHERE id = $1`,
      [r.id],
    );
    if (!cur[0]) {
      skippedRows++;
      continue;
    }
    const value = String(cur[0].v);
    let next = value;
    for (const sw of r.swaps) next = swapKey(next, sw.to, sw.from);
    if (next === value) {
      skippedRows++;
      continue;
    }
    const res = await p.pg.query(updateSql(r.place), [next, r.id, value]);
    if ((res.rowCount ?? 0) === 1) revertedRows++;
    else {
      skippedRows++;
      p.log(`строка ${placeName(r.place)} id=${r.id} изменилась — откат пропущен`);
    }
  }
  return { restoredObjects, revertedRows, skippedRows };
}
