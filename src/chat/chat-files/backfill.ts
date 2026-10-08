// src/chat/chat-files/backfill.ts
import { collectRelayUrls, replaceUrls } from './relay-links';

/**
 * Разовый перенос ещё живых файлов релея в наше хранилище (chat-files).
 *
 * В истории до этой фичи ссылки «Скачать» вели на релей, где файлы лежат в /tmp
 * и пропадают. Здесь для каждой такой ссылки файл пробуется скачать; что
 * скопировалось — в тексте сообщения меняется ТОЛЬКО адрес.
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
export interface JournalEntry {
  rowId: number;
  relayUrl: string;
  storedUrl: string;
}

export const SELECT_BACKFILL_ROWS_SQL = `SELECT id, content FROM custom_chat_history
 WHERE sender_type = 'ai' AND content LIKE $1 AND created_at < now() - interval '1 hour'
 ORDER BY id`;

const UPDATE_SQL = `UPDATE custom_chat_history SET content = $1 WHERE id = $2 AND content = $3`;

/** Срок на один файл при переносе — 5 минут на всё скачивание. */
export const BACKFILL_FILE_TIMEOUT_MS = 300_000;

/** Адреса, которые не отвечают, — не больше `limit` проверок одновременно. Порядок — как во входе. */
async function deadUrls(urls: string[], probe: (u: string) => Promise<boolean>, limit = 5): Promise<string[]> {
  const alive = new Set<string>();
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, urls.length) }, async () => {
      while (next < urls.length) {
        const u = urls[next++];
        try {
          if (await probe(u)) alive.add(u);
        } catch {
          // недоступен — значит не жив
        }
      }
    }),
  );
  return urls.filter((u) => !alive.has(u));
}

export async function runBackfill(p: {
  pg: BackfillPg;
  store: BackfillStore;
  agentUrl: string;
  apply: boolean;
  probe: (url: string) => Promise<boolean>;
  journal: (e: JournalEntry) => void;
  log: (m: string) => void;
}): Promise<{
  rows: number;
  urls: number;
  alive: number;
  missing: number;
  updatedRows: number;
  skippedRows: number;
  /** Что не нашлось на релее: видно глазами, нет ли ложных пропаж (например, обрезанных адресов). */
  missingUrls: string[];
}> {
  const agentUrl = p.agentUrl.replace(/\/$/, '');
  const { rows } = await p.pg.query(SELECT_BACKFILL_ROWS_SQL, [`%${agentUrl}/files/%`]);
  const perRow = rows.map((r: any) => ({
    id: Number(r.id),
    content: String(r.content),
    urls: collectRelayUrls(String(r.content), agentUrl),
  }));
  const unique = [...new Set(perRow.flatMap((r) => r.urls))];
  p.log(`строк со ссылками на релей: ${perRow.length}, уникальных адресов: ${unique.length}`);

  if (!p.apply) {
    const missingUrls = await deadUrls(unique, p.probe);
    return {
      rows: perRow.length,
      urls: unique.length,
      alive: unique.length - missingUrls.length,
      missing: missingUrls.length,
      updatedRows: 0,
      skippedRows: 0,
      missingUrls,
    };
  }

  // Бюджета хода у переноса нет, а срок на файл длиннее, чем в живом ходе:
  // safeGet считает его на всё скачивание целиком, и большой файл на медленном
  // канале к релею за 30 с не успел бы.
  const stored = await p.store.persist(unique, { budgetMs: Infinity, fileTimeoutMs: BACKFILL_FILE_TIMEOUT_MS });
  p.log(`скопировано файлов: ${stored.size} из ${unique.length}`);
  let updatedRows = 0;
  let skippedRows = 0;
  for (const r of perRow) {
    const map = new Map<string, string>();
    for (const u of r.urls) {
      const to = stored.get(u);
      if (to) map.set(u, to);
    }
    if (map.size === 0) continue;
    const next = replaceUrls(r.content, map);
    if (next === r.content) continue;
    const res = await p.pg.query(UPDATE_SQL, [next, r.id, r.content]);
    if ((res.rowCount ?? 0) === 1) {
      updatedRows++;
      for (const [relayUrl, storedUrl] of map) p.journal({ rowId: r.id, relayUrl, storedUrl });
    } else {
      skippedRows++;
      p.log(`строка ${r.id} изменилась во время переноса — пропущена`);
    }
  }
  const missingUrls = unique.filter((u) => !stored.has(u));
  return {
    rows: perRow.length,
    urls: unique.length,
    alive: stored.size,
    missing: missingUrls.length,
    updatedRows,
    skippedRows,
    missingUrls,
  };
}

/** Откат по журналу: наш адрес → адрес релея, с той же проверкой прежнего текста. */
export async function revertBackfill(p: {
  pg: BackfillPg;
  entries: JournalEntry[];
  log: (m: string) => void;
}): Promise<{ reverted: number; skipped: number }> {
  const byRow = new Map<number, Map<string, string>>();
  for (const e of p.entries) {
    if (!byRow.has(e.rowId)) byRow.set(e.rowId, new Map());
    byRow.get(e.rowId)!.set(e.storedUrl, e.relayUrl);
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
