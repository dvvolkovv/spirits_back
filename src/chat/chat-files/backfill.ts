// src/chat/chat-files/backfill.ts
import { collectRelayUrls, replaceUrls } from './relay-links';
import { relayFilesPrefix } from './file-meta';

/**
 * Разовый перенос ссылок релея в истории (custom_chat_history).
 *
 * В истории до chat-files (08.10.2026) ссылки «Скачать» вели на релей, где
 * файлы лежат в /tmp и пропадают. Для каждой ссылки спрашиваем релей:
 *  - файл жив — копия в наше хранилище, в тексте меняется ТОЛЬКО адрес (как
 *    было с первого прогона);
 *  - файла нет (404) — ссылка мёртвая навсегда, но в папке её адреса —
 *    ключ сессии `<номер>_<ассистент>_<язык>`, и номер из текста истории
 *    уходит в промпты. Номер (или uuid пользователя почты) меняется на
 *    солёный хэш пользователя (fsKey — relayFsKey): ссылка остаётся мёртвой,
 *    но без номера. Спека 2026-11-02-pii-out-of-prompts-design.md, п. 6;
 *  - релей не ответил толком — ссылка не трогается до следующего прогона.
 *
 * Почему прежний прогон оставил тысячи ссылок с номером: он менял только
 * адреса скопированных файлов, а 16.09.2026 релей перезагрузился и потерял
 * почти всё (к 08.10 мёртвыми были 8795 адресов). Кроме того он брал лишь
 * ответы ассистента и лишь адреса с хостом AGENT_URL. Реплики человека теперь
 * тоже берутся; ссылки с номером под другим хостом или без хоста не
 * меняются, но считаются — сухой прогон показывает, откуда они.
 *
 * Сообщения моложе часа не трогаются: их может держать открытыми живая вкладка,
 * а фронт сверяет ленту с историей посимвольно (historyMerge.ts). UPDATE идёт с
 * проверкой прежнего текста: если строку за это время изменили, она пропускается.
 */

export interface BackfillPg {
  query: (sql: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
}
export interface BackfillStore {
  persist: (urls: string[], opts?: { budgetMs?: number; fileTimeoutMs?: number }) => Promise<Map<string, string>>;
}
/** Строка журнала: адрес релея и то, чем он заменён, — копией или адресом без номера. */
export type JournalEntry =
  | { rowId: number; relayUrl: string; storedUrl: string }
  | { rowId: number; relayUrl: string; maskedUrl: string };

/** Ответ релея на HEAD: 200 — жив, 404 — файла нет, прочее и сбой — не ответил. */
export type ProbeResult = 'alive' | 'missing' | 'unknown';

export const SELECT_BACKFILL_ROWS_SQL = `SELECT id, sender_type, content FROM custom_chat_history
 WHERE content LIKE $1 AND created_at < now() - interval '1 hour'
 ORDER BY id`;

const UPDATE_SQL = `UPDATE custom_chat_history SET content = $1 WHERE id = $2 AND content = $3`;

/** Идентификатор пользователя: номер или uuid (почта и вход через сервисы). */
const USER_ID = '\\d{10,15}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** В начале папки релея: `<id>_<ассистент>_<язык>` (или `<id>/` — папка из одного id). */
const FOLDER_ID_RE = new RegExp(`^(${USER_ID})(?=[_/]|$)`, 'i');
/** `/files/<id>_` в любом адресе — для счёта ссылок вне префикса релея. */
const FILES_ID_RE = new RegExp(`/files/(?:${USER_ID})(?=[_/])`, 'gi');
const FILES_ID_SQL = `SELECT id, content FROM custom_chat_history
 WHERE content ~* '/files/([0-9]{10,15}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})[_/]'
 ORDER BY id`;

/** Срок на один файл при переносе — 5 минут на всё скачивание. */
export const BACKFILL_FILE_TIMEOUT_MS = 300_000;

/**
 * Адрес файла релея без идентификатора пользователя: номер (или uuid) в
 * начале папки — на fsKey(id). null — адрес не нашего релея, в папке нет
 * идентификатора (fs_key, служебная сессия) или fsKey ничего не дал (нет соли).
 */
export function maskRelayUrl(
  url: string,
  agentUrl: string,
  fsKey: (id: string) => string | undefined,
): string | null {
  const prefix = relayFilesPrefix(agentUrl);
  if (!url.startsWith(prefix)) return null;
  const rest = url.slice(prefix.length);
  const m = FOLDER_ID_RE.exec(rest);
  if (!m) return null;
  const key = fsKey(m[1]);
  return key ? prefix + key + rest.slice(m[1].length) : null;
}

/** Ответы релея на адреса, не больше `limit` проверок одновременно. */
async function classify(
  urls: string[],
  probe: (u: string) => Promise<ProbeResult>,
  limit = 5,
): Promise<Map<string, ProbeResult>> {
  const out = new Map<string, ProbeResult>();
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, urls.length) }, async () => {
      while (next < urls.length) {
        const u = urls[next++];
        try {
          out.set(u, await probe(u));
        } catch {
          out.set(u, 'unknown');
        }
      }
    }),
  );
  return out;
}

/** Длиннее начало адреса не бывает: дальше назад текст не просматривается. */
const MAX_ORIGIN_CHARS = 200;
const ORIGIN_STOP_RE = /[\s(<"'`[]/;

/**
 * Начало адреса перед `/files/`: схема и хост, как написаны в тексте, —
 * «(без хоста)», если адрес относительный, «(иное)», если это не схема с
 * хостом. Только хост: ни пути, ни учётных данных, а значит, ни номера.
 */
function originBefore(text: string, at: number): string {
  let start = at;
  const floor = Math.max(0, at - MAX_ORIGIN_CHARS);
  while (start > floor && !ORIGIN_STOP_RE.test(text[start - 1])) start--;
  const head = text.slice(start, at);
  if (head === '') return '(без хоста)';
  try {
    const u = new URL(head);
    const bare = u.origin !== 'null' && u.pathname === '/' && !u.search && !u.hash && !u.username && !u.password;
    return bare ? head.toLowerCase() : '(иное)';
  } catch {
    return '(иное)';
  }
}

/**
 * Строки с `/files/<id>_` под другим хостом или без хоста — их прогон не
 * меняет (копировать неоткуда, а чужой адрес — не наш), но показывает: сколько
 * и откуда. Префикс сравнивается буквально, как его ищет LIKE выборки.
 */
async function countOtherTemplates(pg: BackfillPg, prefix: string): Promise<{ rows: number; origins: string[] }> {
  const { rows } = await pg.query(FILES_ID_SQL);
  const origins = new Set<string>();
  let n = 0;
  for (const r of rows) {
    const text = String(r.content);
    let other = false;
    for (const m of text.matchAll(FILES_ID_RE)) {
      const at = m.index ?? 0;
      if (text.slice(Math.max(0, at - prefix.length + '/files/'.length), at) + '/files/' === prefix) continue;
      origins.add(originBefore(text, at));
      other = true;
    }
    if (other) n++;
  }
  return { rows: n, origins: [...origins].sort() };
}

export async function runBackfill(p: {
  pg: BackfillPg;
  store: BackfillStore;
  agentUrl: string;
  apply: boolean;
  probe: (url: string) => Promise<ProbeResult>;
  /** Солёный хэш пользователя (relayFsKey). Нет — мёртвые ссылки не меняются, как в первом прогоне. */
  fsKey?: (id: string) => string | undefined;
  journal: (e: JournalEntry) => void;
  log: (m: string) => void;
}): Promise<{
  rows: number;
  /** Из них реплик человека — прежний прогон их не брал. */
  humanRows: number;
  urls: number;
  alive: number;
  missing: number;
  unknown: number;
  /** Из мёртвых — с идентификатором в папке: номер меняется на fsKey. */
  maskable: number;
  copied: number;
  masked: number;
  updatedRows: number;
  skippedRows: number;
  /** Строки с `/files/<id>_` не под AGENT_URL — не меняются. */
  otherRows: number;
  otherOrigins: string[];
  /** Что не нашлось на релее: видно глазами, нет ли ложных пропаж (например, обрезанных адресов). */
  missingUrls: string[];
}> {
  const prefix = relayFilesPrefix(p.agentUrl);
  const { rows } = await p.pg.query(SELECT_BACKFILL_ROWS_SQL, [`%${prefix}%`]);
  const perRow = rows.map((r: any) => ({
    id: Number(r.id),
    human: r.sender_type === 'human',
    content: String(r.content),
    urls: collectRelayUrls(String(r.content), p.agentUrl),
  }));
  const unique = [...new Set(perRow.flatMap((r) => r.urls))];
  p.log(`строк со ссылками на релей: ${perRow.length}, уникальных адресов: ${unique.length}`);

  const verdict = await classify(unique, p.probe);
  const by = (v: ProbeResult) => unique.filter((u) => verdict.get(u) === v);
  const alive = by('alive');
  const missingUrls = by('missing');
  // Один id — один вызов fsKey: без RELAY_FS_SALT relayFsKey пишет
  // предупреждение на каждый вызов.
  const keyCache = new Map<string, string | undefined>();
  const fsKey = (id: string) => {
    if (!keyCache.has(id)) keyCache.set(id, p.fsKey?.(id));
    return keyCache.get(id);
  };
  const masks = new Map<string, string>();
  if (p.fsKey) {
    for (const u of missingUrls) {
      const to = maskRelayUrl(u, p.agentUrl, fsKey);
      if (to) masks.set(u, to);
    }
  }
  const other = await countOtherTemplates(p.pg, prefix);
  const summary = {
    rows: perRow.length,
    humanRows: perRow.filter((r) => r.human).length,
    urls: unique.length,
    alive: alive.length,
    missing: missingUrls.length,
    unknown: unique.length - alive.length - missingUrls.length,
    maskable: masks.size,
    copied: 0,
    masked: 0,
    updatedRows: 0,
    skippedRows: 0,
    otherRows: other.rows,
    otherOrigins: other.origins,
    missingUrls,
  };
  if (!p.apply) return summary;

  // Бюджета хода у переноса нет, а срок на файл длиннее, чем в живом ходе:
  // safeGet считает его на всё скачивание целиком, и большой файл на медленном
  // канале к релею за 30 с не успел бы.
  const stored =
    alive.length > 0
      ? await p.store.persist(alive, { budgetMs: Infinity, fileTimeoutMs: BACKFILL_FILE_TIMEOUT_MS })
      : new Map<string, string>();
  p.log(`скопировано файлов: ${stored.size} из ${alive.length} живых; без номера в адресе: ${masks.size}`);
  summary.copied = stored.size;
  summary.masked = masks.size;
  for (const r of perRow) {
    const map = new Map<string, { to: string; masked: boolean }>();
    for (const u of r.urls) {
      const to = stored.get(u);
      if (to) map.set(u, { to, masked: false });
      else if (masks.has(u)) map.set(u, { to: masks.get(u)!, masked: true });
    }
    if (map.size === 0) continue;
    const next = replaceUrls(r.content, new Map([...map].map(([from, x]) => [from, x.to])));
    if (next === r.content) continue;
    const res = await p.pg.query(UPDATE_SQL, [next, r.id, r.content]);
    if ((res.rowCount ?? 0) === 1) {
      summary.updatedRows++;
      for (const [relayUrl, x] of map) {
        p.journal(x.masked ? { rowId: r.id, relayUrl, maskedUrl: x.to } : { rowId: r.id, relayUrl, storedUrl: x.to });
      }
    } else {
      summary.skippedRows++;
      p.log(`строка ${r.id} изменилась во время переноса — пропущена`);
    }
  }
  return summary;
}

/** Откат по журналу: наш адрес или адрес без номера → адрес релея, с той же проверкой прежнего текста. */
export async function revertBackfill(p: {
  pg: BackfillPg;
  entries: JournalEntry[];
  log: (m: string) => void;
}): Promise<{ reverted: number; skipped: number }> {
  const byRow = new Map<number, Map<string, string>>();
  for (const e of p.entries) {
    if (!byRow.has(e.rowId)) byRow.set(e.rowId, new Map());
    byRow.get(e.rowId)!.set('storedUrl' in e ? e.storedUrl : e.maskedUrl, e.relayUrl);
  }
  let reverted = 0;
  let skipped = 0;
  for (const [id, map] of byRow) {
    const { rows } = await p.pg.query(`SELECT content FROM custom_chat_history WHERE id = $1`, [id]);
    if (!rows[0]) {
      skipped++;
      continue;
    }
    const cur = String(rows[0].content);
    const next = replaceUrls(cur, map);
    if (next === cur) {
      skipped++;
      continue;
    }
    const res = await p.pg.query(UPDATE_SQL, [next, id, cur]);
    if ((res.rowCount ?? 0) === 1) reverted++;
    else {
      skipped++;
      p.log(`строка ${id} изменилась — откат пропущен`);
    }
  }
  return { reverted, skipped };
}
