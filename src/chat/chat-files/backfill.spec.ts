// src/chat/chat-files/backfill.spec.ts
import { BACKFILL_FILE_TIMEOUT_MS, JournalEntry, SELECT_BACKFILL_ROWS_SQL, revertBackfill, runBackfill } from './backfill';

const AGENT = 'https://r.linkeon.io';
const R = `${AGENT}/files/u1_12_ru`;

/** Таблица в памяти: SELECT по шаблону, UPDATE с проверкой прежнего текста. */
function makePg(rows: { id: number; content: string }[]) {
  const table = new Map(rows.map((r) => [r.id, r.content]));
  const calls: { sql: string; params: any[] }[] = [];
  const query = jest.fn(async (sql: string, params: any[] = []) => {
    calls.push({ sql, params });
    if (sql === SELECT_BACKFILL_ROWS_SQL) {
      const like = String(params[0]).replace(/%/g, '');
      return { rows: [...table].filter(([, c]) => c.includes(like)).map(([id, content]) => ({ id, content })) };
    }
    if (/^UPDATE custom_chat_history/.test(sql)) {
      const [next, id, prev] = params;
      if (table.get(id) !== prev) return { rows: [], rowCount: 0 };
      table.set(id, next);
      return { rows: [], rowCount: 1 };
    }
    if (/^SELECT content FROM custom_chat_history/.test(sql)) {
      const c = table.get(params[0]);
      return { rows: c === undefined ? [] : [{ content: c }] };
    }
    return { rows: [] };
  });
  return { query, calls, table };
}

const stored = (u: string) => u.replace(R, 'https://pub/linkeon-chat-files/id');

describe('runBackfill', () => {
  it('выборка: только ответы ассистента старше часа', () => {
    expect(SELECT_BACKFILL_ROWS_SQL).toMatch(/sender_type = 'ai'/);
    expect(SELECT_BACKFILL_ROWS_SQL).toMatch(/created_at < now\(\) - interval '1 hour'/);
  });

  it('сухой прогон ничего не пишет и считает живые по probe', async () => {
    const pg = makePg([{ id: 1, content: `[Скачать a.pdf](${R}/a.pdf)\n[Скачать b.pdf](${R}/b.pdf)` }]);
    const store = { persist: jest.fn() };
    const r = await runBackfill({
      pg, store, agentUrl: AGENT, apply: false,
      probe: async (u) => u.endsWith('a.pdf'), journal: jest.fn(), log: jest.fn(),
    });

    expect(r).toMatchObject({ rows: 1, urls: 2, alive: 1, missing: 1, updatedRows: 0, missingUrls: [`${R}/b.pdf`] });
    expect(store.persist).not.toHaveBeenCalled();
    expect(pg.calls.some((c) => /^UPDATE/.test(c.sql))).toBe(false);
  });

  it('--apply меняет только скопированные адреса и пишет журнал', async () => {
    const pg = makePg([{ id: 1, content: `[Скачать a.pdf](${R}/a.pdf) и [Скачать gone.pdf](${R}/gone.pdf)` }]);
    const store = { persist: jest.fn(async (urls: string[]) => new Map(urls.filter((u) => !u.endsWith('gone.pdf')).map((u) => [u, stored(u)]))) };
    const journal: JournalEntry[] = [];

    const r = await runBackfill({ pg, store, agentUrl: AGENT, apply: true, probe: jest.fn(), journal: (e) => journal.push(e), log: jest.fn() });

    expect(store.persist).toHaveBeenCalledWith([`${R}/a.pdf`, `${R}/gone.pdf`], { budgetMs: Infinity, fileTimeoutMs: BACKFILL_FILE_TIMEOUT_MS });
    expect(pg.table.get(1)).toBe(`[Скачать a.pdf](https://pub/linkeon-chat-files/id/a.pdf) и [Скачать gone.pdf](${R}/gone.pdf)`);
    expect(journal).toEqual([{ rowId: 1, relayUrl: `${R}/a.pdf`, storedUrl: 'https://pub/linkeon-chat-files/id/a.pdf' }]);
    expect(r).toMatchObject({ updatedRows: 1, skippedRows: 0, alive: 1, missing: 1, missingUrls: [`${R}/gone.pdf`] });
  });

  it('строку изменили во время переноса — она пропускается, журнала нет', async () => {
    const pg = makePg([{ id: 1, content: `[Скачать a.pdf](${R}/a.pdf)` }]);
    const store = {
      persist: jest.fn(async (urls: string[]) => {
        pg.table.set(1, 'переписано пользователем');
        return new Map(urls.map((u) => [u, stored(u)]));
      }),
    };
    const journal = jest.fn();

    const r = await runBackfill({ pg, store, agentUrl: AGENT, apply: true, probe: jest.fn(), journal, log: jest.fn() });

    expect(r).toMatchObject({ updatedRows: 0, skippedRows: 1 });
    expect(journal).not.toHaveBeenCalled();
    expect(pg.table.get(1)).toBe('переписано пользователем');
  });

  it('повторный запуск — ноль замен', async () => {
    const pg = makePg([{ id: 1, content: `[Скачать a.pdf](${R}/a.pdf)` }]);
    const store = { persist: jest.fn(async (urls: string[]) => new Map(urls.map((u) => [u, stored(u)]))) };
    const args = { pg, store, agentUrl: AGENT, apply: true, probe: jest.fn(), journal: jest.fn(), log: jest.fn() };

    await runBackfill(args);
    const second = await runBackfill(args);

    expect(second).toMatchObject({ rows: 0, urls: 0, updatedRows: 0 });
  });
});

describe('revertBackfill', () => {
  it('возвращает адреса релея по журналу', async () => {
    const pg = makePg([{ id: 1, content: '[Скачать a.pdf](https://pub/linkeon-chat-files/id/a.pdf)' }]);
    const r = await revertBackfill({
      pg,
      entries: [{ rowId: 1, relayUrl: `${R}/a.pdf`, storedUrl: 'https://pub/linkeon-chat-files/id/a.pdf' }],
      log: jest.fn(),
    });

    expect(r).toEqual({ reverted: 1, skipped: 0 });
    expect(pg.table.get(1)).toBe(`[Скачать a.pdf](${R}/a.pdf)`);
  });
});
