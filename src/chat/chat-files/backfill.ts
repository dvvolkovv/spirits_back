// src/chat/chat-files/backfill.ts
import { collectRelayUrls, escapeRe, replaceUrls } from './relay-links';
import { relayFilesPrefix } from './file-meta';
import { writePrivateFile } from '../../common/one-off-script';

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
 * Пути на диске релея — /tmp/agent-output/<номер>_… и
 * /tmp/agent-uploads/<номер>_…, которые модель повторяла в ответах до
 * 26.10.2026, — заведомо мёртвые: номер в них меняется на тот же солёный хэш
 * (maskRelayPaths), во всех репликах, с теми же журналом и откатом.
 *
 * Почему прежний прогон оставил тысячи ссылок с номером: он менял только
 * адреса скопированных файлов, а 16.09.2026 релей перезагрузился и потерял
 * почти всё (к 08.10 мёртвыми были 8795 адресов). Кроме того он брал лишь
 * ответы ассистента и лишь адреса с хостом AGENT_URL. Реплики человека теперь
 * тоже берутся; ссылки /files/<номер>_… под другим хостом или без хоста
 * заведомо мёртвые — номер в них меняется на тот же солёный хэш без вопроса
 * релею (maskForeignFilesLinks), сухой прогон показывает, сколько их и откуда.
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
/**
 * Строка журнала: адрес релея и то, чем он заменён, — копией или адресом без
 * номера; либо начало пути на диске релея с номером и оно же с солёным хэшем.
 */
export type JournalEntry =
  | { rowId: number; relayUrl: string; storedUrl: string }
  | { rowId: number; relayUrl: string; maskedUrl: string }
  | { rowId: number; pathFrom: string; pathTo: string }
  | { rowId: number; linkFrom: string; linkTo: string };

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
/** `/files/<id>` в любом адресе (id — в группе 1): для ссылок под чужим хостом и без хоста. */
const FILES_ID_RE = new RegExp(`/files/(${USER_ID})(?=[_/])`, 'gi');
const FILES_ID_SQL = `SELECT id, sender_type, content FROM custom_chat_history
 WHERE content ~* '/files/([0-9]{10,15}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})[_/]'
   AND created_at < now() - interval '1 hour'
 ORDER BY id`;

/**
 * Пути на диске релея (relay-agent/server.mjs: OUTPUT_DIR, UPLOAD_DIR). До
 * 26.10.2026 папка хода и имя загрузки начинались с ключа сессии —
 * `<номер>_<ассистент>_<язык>`, — и модель повторяла эти пути в ответах.
 * Путь заведомо мёртвый: номер в нём меняется на солёный хэш пользователя,
 * тот же, что у мёртвых ссылок /files/.
 */
const RELAY_PATH_RE = new RegExp(`/tmp/agent-(output|uploads)/(${USER_ID})(?=[_/])`, 'gi');
export const SELECT_PATH_ROWS_SQL = `SELECT id, sender_type, content FROM custom_chat_history
 WHERE content ~* '/tmp/agent-(output|uploads)/([0-9]{10,15}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})[_/]'
   AND created_at < now() - interval '1 hour'
 ORDER BY id`;

/**
 * Номер (или uuid) в путях релея — на fsKey(id). swaps — по одной записи на
 * путь «каталог + id», для журнала и отката. Без соли (fsKey ничего не дал)
 * путь не меняется.
 */
export function maskRelayPaths(
  text: string,
  fsKey: (id: string) => string | undefined,
): { text: string; swaps: { pathFrom: string; pathTo: string }[] } {
  const swaps = new Map<string, string>();
  const out = text.replace(RELAY_PATH_RE, (whole: string, _dir: string, id: string) => {
    const key = fsKey(id);
    if (!key) return whole;
    const to = whole.slice(0, whole.length - id.length) + key;
    swaps.set(whole, to);
    return to;
  });
  return { text: out, swaps: [...swaps].map(([pathFrom, pathTo]) => ({ pathFrom, pathTo })) };
}

const HAS_RELAY_PATH = {
  output: new RegExp(`/tmp/agent-output/(?:${USER_ID})(?=[_/])`, 'i'),
  uploads: new RegExp(`/tmp/agent-uploads/(?:${USER_ID})(?=[_/])`, 'i'),
};
function hasRelayPath(text: string, dir: 'output' | 'uploads'): boolean {
  return HAS_RELAY_PATH[dir].test(text);
}

/** Откат одной замены пути: только там, где за ним идёт `_` или `/`, как при замене. */
function unmaskRelayPath(text: string, pathTo: string, pathFrom: string): string {
  return text.replace(new RegExp(`${escapeRe(pathTo)}(?=[_/])`, 'g'), () => pathFrom);
}

/** Срок на один файл при переносе — 5 минут на всё скачивание. */
export const BACKFILL_FILE_TIMEOUT_MS = 300_000;

/**
 * Список мёртвых адресов — рядом с журналом (`.missing.txt`), только при
 * --apply и с правами 600: в адресах номера. Сухой прогон — только счётчики.
 * null — файла нет.
 */
export function saveMissingList(apply: boolean, journalPath: string, missingUrls: string[]): string | null {
  if (!apply) return null;
  const file = journalPath.replace(/\.jsonl$/, '.missing.txt');
  writePrivateFile(file, missingUrls.length > 0 ? missingUrls.join('\n') + '\n' : '');
  return file;
}

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
/** Начало токена — начало текста или разделитель, как у ORIGIN_STOP_RE. */
const TOKEN_START = `(?<=^|[\\s(<"'\`\\[])`;

interface ForeignLink {
  /** Где в тексте `/files/`. */
  at: number;
  /** Начало адреса до разделителя: хост, `''` у адреса без хоста. */
  head: string;
  id: string;
  /** Начало найдено — не дальше MAX_ORIGIN_CHARS. */
  bounded: boolean;
}

/**
 * `/files/<id>` не под префиксом релея — под чужим хостом или без хоста.
 * Префикс сравнивается буквально, как его ищет LIKE выборки: всё, что под
 * ним, решает ответ релея.
 */
function foreignFilesLinks(text: string, prefix: string): ForeignLink[] {
  const out: ForeignLink[] = [];
  const originLen = prefix.length - '/files/'.length;
  for (const m of text.matchAll(FILES_ID_RE)) {
    const at = m.index ?? 0;
    if (text.slice(Math.max(0, at - originLen), at) + '/files/' === prefix) continue;
    let start = at;
    const floor = Math.max(0, at - MAX_ORIGIN_CHARS);
    while (start > floor && !ORIGIN_STOP_RE.test(text[start - 1])) start--;
    const bounded = start === 0 || ORIGIN_STOP_RE.test(text[start - 1]);
    out.push({ at, head: text.slice(start, at), id: m[1], bounded });
  }
  return out;
}

/**
 * Хост ссылки для счётчиков, как написан в тексте, — «(без хоста)» у
 * относительного адреса, «(иное)», если это не схема с хостом. Только хост:
 * ни пути, ни учётных данных, а значит, ни номера.
 */
function originLabel(head: string): string {
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
 * Номер (или uuid) в ссылках `/files/<id>_` под чужим хостом или без хоста —
 * на fsKey(id). Такие ссылки заведомо мёртвые (копировать неоткуда, наш релей
 * их не отдаёт), поэтому без вопроса релею (ревью ветки, I3). Ссылка, начало
 * которой не найти (длиннее MAX_ORIGIN_CHARS), не меняется: откат ищет замену
 * с начала токена. swaps — по одной записи на «начало адреса + id».
 */
export function maskForeignFilesLinks(
  text: string,
  agentUrl: string,
  fsKey: (id: string) => string | undefined,
): { text: string; swaps: { linkFrom: string; linkTo: string }[] } {
  const swaps = new Map<string, string>();
  let out = '';
  let last = 0;
  for (const l of foreignFilesLinks(text, relayFilesPrefix(agentUrl))) {
    if (!l.bounded) continue;
    const key = fsKey(l.id);
    if (!key) continue;
    const idAt = l.at + '/files/'.length;
    out += text.slice(last, idAt) + key;
    last = idAt + l.id.length;
    swaps.set(`${l.head}/files/${l.id}`, `${l.head}/files/${key}`);
  }
  out += text.slice(last);
  return { text: out, swaps: [...swaps].map(([linkFrom, linkTo]) => ({ linkFrom, linkTo })) };
}

/** Откат замены в чужой ссылке: с начала токена и до `_` или `/`, как при замене. */
function unmaskForeignLink(text: string, linkTo: string, linkFrom: string): string {
  return text.replace(new RegExp(`${TOKEN_START}${escapeRe(linkTo)}(?=[_/])`, 'g'), () => linkFrom);
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
  /** Строки с `/files/<id>_` под чужим хостом или без хоста (старше часа) и их хосты. */
  otherRows: number;
  otherOrigins: string[];
  /** Строки, где номер в таких ссылках заменён (--apply). */
  maskedOtherRows: number;
  /** Строки с путём /tmp/agent-output/<id>… и /tmp/agent-uploads/<id>… (старше часа, любой sender_type). */
  outputPathRows: number;
  uploadPathRows: number;
  /** Строки, где номер в путях релея заменён (--apply). */
  maskedPathRows: number;
  /** Что не нашлось на релее: видно глазами, нет ли ложных пропаж (например, обрезанных адресов). */
  missingUrls: string[];
}> {
  const prefix = relayFilesPrefix(p.agentUrl);
  const { rows } = await p.pg.query(SELECT_BACKFILL_ROWS_SQL, [`%${prefix}%`]);
  const { rows: pathRows } = await p.pg.query(SELECT_PATH_ROWS_SQL);
  const { rows: idRows } = await p.pg.query(FILES_ID_SQL);
  // Строка бывает в нескольких выборках — одна запись, одна замена.
  const byId = new Map<number, { id: number; human: boolean; content: string; withLinks: boolean }>();
  for (const r of rows) {
    byId.set(Number(r.id), { id: Number(r.id), human: r.sender_type === 'human', content: String(r.content), withLinks: true });
  }
  for (const r of [...pathRows, ...idRows]) {
    if (!byId.has(Number(r.id))) {
      byId.set(Number(r.id), { id: Number(r.id), human: r.sender_type === 'human', content: String(r.content), withLinks: false });
    }
  }
  const perRow = [...byId.values()]
    .sort((a, b) => a.id - b.id)
    .map((r) => ({
      ...r,
      urls: r.withLinks ? collectRelayUrls(r.content, p.agentUrl) : [],
      foreign: foreignFilesLinks(r.content, prefix),
      outputPath: hasRelayPath(r.content, 'output'),
      uploadPath: hasRelayPath(r.content, 'uploads'),
    }));
  const linkRows = perRow.filter((r) => r.withLinks);
  const unique = [...new Set(perRow.flatMap((r) => r.urls))];
  p.log(`строк со ссылками на релей: ${linkRows.length}, уникальных адресов: ${unique.length}`);

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
  const otherRows = perRow.filter((r) => r.foreign.length > 0);
  const summary = {
    rows: linkRows.length,
    humanRows: linkRows.filter((r) => r.human).length,
    urls: unique.length,
    alive: alive.length,
    missing: missingUrls.length,
    unknown: unique.length - alive.length - missingUrls.length,
    maskable: masks.size,
    copied: 0,
    masked: 0,
    updatedRows: 0,
    skippedRows: 0,
    otherRows: otherRows.length,
    otherOrigins: [...new Set(otherRows.flatMap((r) => r.foreign.map((l) => originLabel(l.head))))].sort(),
    maskedOtherRows: 0,
    outputPathRows: perRow.filter((r) => r.outputPath).length,
    uploadPathRows: perRow.filter((r) => r.uploadPath).length,
    maskedPathRows: 0,
    missingUrls,
  };
  p.log(`строк со ссылками под чужим хостом или без хоста: ${summary.otherRows}`);
  p.log(`строк с путями релея: ${summary.outputPathRows} (папка вывода), ${summary.uploadPathRows} (загрузки)`);
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
    let next = map.size > 0 ? replaceUrls(r.content, new Map([...map].map(([from, x]) => [from, x.to]))) : r.content;
    // Ссылки под чужим хостом и без хоста и пути на диске релея — в той же
    // строке, той же заменой (одна проверка прежнего текста на строку).
    const links = p.fsKey && r.foreign.length > 0 ? maskForeignFilesLinks(next, p.agentUrl, fsKey) : { text: next, swaps: [] };
    next = links.text;
    const paths = p.fsKey && (r.outputPath || r.uploadPath) ? maskRelayPaths(next, fsKey) : { text: next, swaps: [] };
    next = paths.text;
    if (next === r.content) continue;
    const res = await p.pg.query(UPDATE_SQL, [next, r.id, r.content]);
    if ((res.rowCount ?? 0) === 1) {
      summary.updatedRows++;
      if (links.swaps.length > 0) summary.maskedOtherRows++;
      if (paths.swaps.length > 0) summary.maskedPathRows++;
      for (const [relayUrl, x] of map) {
        p.journal(x.masked ? { rowId: r.id, relayUrl, maskedUrl: x.to } : { rowId: r.id, relayUrl, storedUrl: x.to });
      }
      for (const sw of links.swaps) p.journal({ rowId: r.id, ...sw });
      for (const sw of paths.swaps) p.journal({ rowId: r.id, ...sw });
    } else {
      summary.skippedRows++;
      p.log(`строка ${r.id} изменилась во время переноса — пропущена`);
    }
  }
  return summary;
}

/**
 * Откат по журналу: наш адрес или адрес без номера → адрес релея; ссылка под
 * чужим хостом или без хоста и путь на диске релея — с солёным хэшем → с
 * номером; с той же проверкой прежнего текста.
 */
export async function revertBackfill(p: {
  pg: BackfillPg;
  entries: JournalEntry[];
  log: (m: string) => void;
}): Promise<{ reverted: number; skipped: number }> {
  const byRow = new Map<
    number,
    { urls: Map<string, string>; links: { linkFrom: string; linkTo: string }[]; paths: { pathFrom: string; pathTo: string }[] }
  >();
  for (const e of p.entries) {
    if (!byRow.has(e.rowId)) byRow.set(e.rowId, { urls: new Map(), links: [], paths: [] });
    const row = byRow.get(e.rowId)!;
    if ('pathFrom' in e) row.paths.push({ pathFrom: e.pathFrom, pathTo: e.pathTo });
    else if ('linkFrom' in e) row.links.push({ linkFrom: e.linkFrom, linkTo: e.linkTo });
    else row.urls.set('storedUrl' in e ? e.storedUrl : e.maskedUrl, e.relayUrl);
  }
  let reverted = 0;
  let skipped = 0;
  for (const [id, back] of byRow) {
    const { rows } = await p.pg.query(`SELECT content FROM custom_chat_history WHERE id = $1`, [id]);
    if (!rows[0]) {
      skipped++;
      continue;
    }
    const cur = String(rows[0].content);
    let next = back.urls.size > 0 ? replaceUrls(cur, back.urls) : cur;
    for (const sw of back.links) next = unmaskForeignLink(next, sw.linkTo, sw.linkFrom);
    for (const sw of back.paths) next = unmaskRelayPath(next, sw.pathTo, sw.pathFrom);
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
