// src/chat/chat-files/backfill.spec.ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  BACKFILL_FILE_TIMEOUT_MS,
  JournalEntry,
  ProbeResult,
  SELECT_BACKFILL_ROWS_SQL,
  maskRelayPaths,
  maskRelayUrl,
  revertBackfill,
  runBackfill,
  saveMissingList,
} from './backfill';

const AGENT = 'https://r.linkeon.io';
/** Папка без идентификатора пользователя — маскировать нечего. */
const R = `${AGENT}/files/u1_12_ru`;
/** Папка релея до 26.10.2026: ключ сессии, у телефонных — с номером. */
const P = `${AGENT}/files/70000000000_12_ru`;
/** Солёный хэш пользователя — в тестах постоянный. */
const FK = 'ab'.repeat(16);
const fsKey = (id: string) => (id ? FK : undefined);

/** Таблица в памяти: SELECT по шаблону, UPDATE с проверкой прежнего текста. */
function makePg(rows: { id: number; content: string; sender_type?: string }[]) {
  const table = new Map(rows.map((r) => [r.id, r.content]));
  const sender = new Map(rows.map((r) => [r.id, r.sender_type ?? 'ai']));
  const calls: { sql: string; params: any[] }[] = [];
  const query = jest.fn(async (sql: string, params: any[] = []) => {
    calls.push({ sql, params });
    if (sql === SELECT_BACKFILL_ROWS_SQL) {
      const like = String(params[0]).replace(/%/g, '');
      return {
        rows: [...table]
          .filter(([, c]) => c.includes(like))
          .map(([id, content]) => ({ id, content, sender_type: sender.get(id) })),
      };
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

const stored = (u: string) => u.replace(/^https:\/\/r\.linkeon\.io\/files\/[^/]+/, 'https://pub/linkeon-chat-files/id');
const probeBy = (map: Record<string, ProbeResult>) => async (u: string): Promise<ProbeResult> =>
  map[u.slice(u.lastIndexOf('/') + 1)] ?? 'unknown';
const updates = (pg: ReturnType<typeof makePg>) => pg.calls.filter((c) => /^UPDATE/.test(c.sql));

describe('maskRelayUrl', () => {
  it('номер в папке — на солёный хэш пользователя, остальное как было', () => {
    expect(maskRelayUrl(`${P}/a.pdf`, AGENT, fsKey)).toBe(`${AGENT}/files/${FK}_12_ru/a.pdf`);
  });

  it('идентификатор пользователя почты (uuid) — тоже', () => {
    const uuid = 'aaaaaaaa-0000-4000-8000-000000000001';
    expect(maskRelayUrl(`${AGENT}/files/${uuid}_17_en/x/b.docx`, AGENT, fsKey)).toBe(`${AGENT}/files/${FK}_17_en/x/b.docx`);
  });

  it('папка без идентификатора (fs_key, служебная сессия) — null', () => {
    expect(maskRelayUrl(`${AGENT}/files/${'cd'.repeat(16)}/a.pdf`, AGENT, fsKey)).toBeNull();
    expect(maskRelayUrl(`${R}/a.pdf`, AGENT, fsKey)).toBeNull();
    expect(maskRelayUrl(`${AGENT}/files/voice_12_1/a.pdf`, AGENT, fsKey)).toBeNull();
  });

  it('чужой адрес и номер не в начале папки — null', () => {
    expect(maskRelayUrl('https://example.com/files/70000000000_12_ru/a.pdf', AGENT, fsKey)).toBeNull();
    expect(maskRelayUrl(`${AGENT}/files/x70000000000_12_ru/a.pdf`, AGENT, fsKey)).toBeNull();
  });

  it('без соли (fsKey ничего не дал) — null', () => {
    expect(maskRelayUrl(`${P}/a.pdf`, AGENT, () => undefined)).toBeNull();
  });
});

// Пути на диске релея: модель повторяла их в ответах до 26.10.2026, когда
// папка хода называлась ключом сессии с номером (контролёр 02.11: 76 сообщений
// с /tmp/agent-output/<номер>_…). В хвосте истории они уходят модели.
describe('maskRelayPaths', () => {
  it('номер в пути папки вывода — на солёный хэш пользователя, остальное как было', () => {
    expect(maskRelayPaths('сохранил /tmp/agent-output/70000000000_12_ru/report.pdf', fsKey)).toEqual({
      text: `сохранил /tmp/agent-output/${FK}_12_ru/report.pdf`,
      swaps: [{ pathFrom: '/tmp/agent-output/70000000000', pathTo: `/tmp/agent-output/${FK}` }],
    });
  });

  it('номер в имени загрузки — тоже', () => {
    expect(maskRelayPaths('прочитал /tmp/agent-uploads/70000000000_12_ru_scan.pdf', fsKey).text).toBe(
      `прочитал /tmp/agent-uploads/${FK}_12_ru_scan.pdf`,
    );
  });

  it('uuid пользователя почты — тоже', () => {
    const uuid = 'aaaaaaaa-0000-4000-8000-000000000001';
    expect(maskRelayPaths(`/tmp/agent-output/${uuid}/a.md`, fsKey).text).toBe(`/tmp/agent-output/${FK}/a.md`);
  });

  it('один путь много раз — одна запись замены', () => {
    const r = maskRelayPaths('/tmp/agent-output/70000000000_12_ru/a.pdf и /tmp/agent-output/70000000000_12_ru/b.pdf', fsKey);
    expect(r.text).toBe(`/tmp/agent-output/${FK}_12_ru/a.pdf и /tmp/agent-output/${FK}_12_ru/b.pdf`);
    expect(r.swaps).toHaveLength(1);
  });

  it('папка fs_key, служебная сессия, чужой каталог, не номер — без изменений', () => {
    for (const t of [
      `/tmp/agent-output/${'cd'.repeat(16)}/x.pdf`,
      '/tmp/agent-output/voice_12_1/x.pdf',
      '/home/dv/agent-output/70000000000_12_ru/x.pdf',
      '/tmp/agent-output/1234567890123456789_12_ru/x.pdf',
    ]) {
      expect(maskRelayPaths(t, fsKey)).toEqual({ text: t, swaps: [] });
    }
  });

  it('без соли — без изменений', () => {
    const t = '/tmp/agent-output/70000000000_12_ru/x.pdf';
    expect(maskRelayPaths(t, () => undefined)).toEqual({ text: t, swaps: [] });
  });
});

describe('runBackfill', () => {
  it('выборка: ответы ассистента и реплики человека старше часа', () => {
    expect(SELECT_BACKFILL_ROWS_SQL).not.toMatch(/sender_type = 'ai'/);
    expect(SELECT_BACKFILL_ROWS_SQL).toMatch(/sender_type/);
    expect(SELECT_BACKFILL_ROWS_SQL).toMatch(/created_at < now\(\) - interval '1 hour'/);
  });

  it('сухой прогон ничего не пишет и раскладывает адреса по ответу релея', async () => {
    const pg = makePg([
      { id: 1, content: `[Скачать a.pdf](${P}/a.pdf)\n[Скачать b.pdf](${P}/b.pdf)\n[Скачать c.pdf](${P}/c.pdf)` },
      { id: 2, content: `не открывается ${P}/b.pdf`, sender_type: 'human' },
      { id: 3, content: `[Скачать d.pdf](${R}/d.pdf)` },
    ]);
    const store = { persist: jest.fn() };

    const r = await runBackfill({
      pg, store, agentUrl: AGENT, apply: false, fsKey,
      probe: probeBy({ 'a.pdf': 'alive', 'b.pdf': 'missing', 'c.pdf': 'unknown', 'd.pdf': 'missing' }),
      journal: jest.fn(), log: jest.fn(),
    });

    expect(r).toMatchObject({
      rows: 3, humanRows: 1, urls: 4, alive: 1, missing: 2, unknown: 1, maskable: 1,
      updatedRows: 0, copied: 0, masked: 0,
    });
    expect(r.missingUrls.sort()).toEqual([`${P}/b.pdf`, `${R}/d.pdf`]);
    expect(store.persist).not.toHaveBeenCalled();
    expect(updates(pg)).toEqual([]);
  });

  it('--apply: живые — в хранилище, как раньше; файла нет — номер в адресе на fsKey; журнал на обе замены', async () => {
    const pg = makePg([{ id: 1, content: `[Скачать a.pdf](${P}/a.pdf) и [Скачать gone.pdf](${P}/gone.pdf)` }]);
    const store = { persist: jest.fn(async (urls: string[]) => new Map(urls.map((u) => [u, stored(u)]))) };
    const journal: JournalEntry[] = [];

    const r = await runBackfill({
      pg, store, agentUrl: AGENT, apply: true, fsKey,
      probe: probeBy({ 'a.pdf': 'alive', 'gone.pdf': 'missing' }),
      journal: (e) => journal.push(e), log: jest.fn(),
    });

    // Копируются только живые.
    expect(store.persist).toHaveBeenCalledWith([`${P}/a.pdf`], { budgetMs: Infinity, fileTimeoutMs: BACKFILL_FILE_TIMEOUT_MS });
    expect(pg.table.get(1)).toBe(
      `[Скачать a.pdf](https://pub/linkeon-chat-files/id/a.pdf) и [Скачать gone.pdf](${AGENT}/files/${FK}_12_ru/gone.pdf)`,
    );
    expect(pg.table.get(1)).not.toContain('70000000000');
    expect(journal).toEqual([
      { rowId: 1, relayUrl: `${P}/a.pdf`, storedUrl: 'https://pub/linkeon-chat-files/id/a.pdf' },
      { rowId: 1, relayUrl: `${P}/gone.pdf`, maskedUrl: `${AGENT}/files/${FK}_12_ru/gone.pdf` },
    ]);
    expect(r).toMatchObject({ updatedRows: 1, skippedRows: 0, alive: 1, missing: 1, copied: 1, masked: 1 });
  });

  it('релей не ответил или копия не удалась — ссылка остаётся как была', async () => {
    const content = `[Скачать a.pdf](${P}/a.pdf)\n[Скачать c.pdf](${P}/c.pdf)`;
    const pg = makePg([{ id: 1, content }]);
    const store = { persist: jest.fn(async () => new Map<string, string>()) };

    const r = await runBackfill({
      pg, store, agentUrl: AGENT, apply: true, fsKey,
      probe: probeBy({ 'a.pdf': 'alive', 'c.pdf': 'unknown' }),
      journal: jest.fn(), log: jest.fn(),
    });

    expect(pg.table.get(1)).toBe(content);
    expect(r).toMatchObject({ updatedRows: 0, copied: 0, masked: 0, unknown: 1 });
  });

  it('файла нет, но в папке нет идентификатора — ссылка остаётся', async () => {
    const content = `[Скачать d.pdf](${R}/d.pdf)`;
    const pg = makePg([{ id: 1, content }]);

    const r = await runBackfill({
      pg, store: { persist: jest.fn(async () => new Map()) }, agentUrl: AGENT, apply: true, fsKey,
      probe: probeBy({ 'd.pdf': 'missing' }), journal: jest.fn(), log: jest.fn(),
    });

    expect(pg.table.get(1)).toBe(content);
    expect(r).toMatchObject({ missing: 1, maskable: 0, masked: 0, updatedRows: 0 });
  });

  it('без fsKey номер не маскируется — только копии, как раньше', async () => {
    const content = `[Скачать gone.pdf](${P}/gone.pdf)`;
    const pg = makePg([{ id: 1, content }]);

    const r = await runBackfill({
      pg, store: { persist: jest.fn(async () => new Map()) }, agentUrl: AGENT, apply: true,
      probe: probeBy({ 'gone.pdf': 'missing' }), journal: jest.fn(), log: jest.fn(),
    });

    expect(pg.table.get(1)).toBe(content);
    expect(r).toMatchObject({ missing: 1, maskable: 0, masked: 0 });
  });

  it('строку изменили во время переноса — она пропускается, журнала нет', async () => {
    const pg = makePg([{ id: 1, content: `[Скачать a.pdf](${P}/a.pdf)` }]);
    const store = {
      persist: jest.fn(async (urls: string[]) => {
        pg.table.set(1, 'переписано пользователем');
        return new Map(urls.map((u) => [u, stored(u)]));
      }),
    };
    const journal = jest.fn();

    const r = await runBackfill({
      pg, store, agentUrl: AGENT, apply: true, fsKey, probe: probeBy({ 'a.pdf': 'alive' }), journal, log: jest.fn(),
    });

    expect(r).toMatchObject({ updatedRows: 0, skippedRows: 1 });
    expect(journal).not.toHaveBeenCalled();
    expect(pg.table.get(1)).toBe('переписано пользователем');
  });

  it('повторный запуск — ноль замен', async () => {
    const pg = makePg([{ id: 1, content: `[Скачать a.pdf](${P}/a.pdf) [Скачать gone.pdf](${P}/gone.pdf)` }]);
    const store = { persist: jest.fn(async (urls: string[]) => new Map(urls.map((u) => [u, stored(u)]))) };
    // Замаскированный адрес релей тоже не знает — для него тот же ответ «нет файла».
    const probe = async (u: string): Promise<ProbeResult> => (u.endsWith('a.pdf') ? 'alive' : 'missing');
    const args = { pg, store, agentUrl: AGENT, apply: true, fsKey, probe, journal: jest.fn(), log: jest.fn() };

    await runBackfill(args);
    const first = pg.table.get(1);
    const second = await runBackfill(args);

    expect(second).toMatchObject({ updatedRows: 0, copied: 0, masked: 0 });
    expect(pg.table.get(1)).toBe(first);
  });
});

// Список мёртвых адресов — с номерами: в сухом прогоне его нет вовсе (только
// счётчики, как обещает шапка скрипта), при --apply — рядом с журналом, 600.
describe('saveMissingList', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-missing-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('сухой прогон — файла нет', () => {
    expect(saveMissingList(false, path.join(dir, 'backfill-chat-files-x.jsonl'), [`${P}/gone.pdf`])).toBeNull();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('--apply — список рядом с журналом, права 600', () => {
    const old = process.umask(0o022);
    try {
      const file = saveMissingList(true, path.join(dir, 'backfill-chat-files-x.jsonl'), [`${P}/gone.pdf`]);
      expect(file).toBe(path.join(dir, 'backfill-chat-files-x.missing.txt'));
      expect(fs.statSync(file!).mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(file!, 'utf8')).toBe(`${P}/gone.pdf\n`);
    } finally {
      process.umask(old);
    }
  });
});

describe('revertBackfill', () => {
  it('возвращает адреса релея по журналу — и копии, и замены номера', async () => {
    const pg = makePg([
      { id: 1, content: `[Скачать a.pdf](https://pub/linkeon-chat-files/id/a.pdf) [Скачать gone.pdf](${AGENT}/files/${FK}_12_ru/gone.pdf)` },
    ]);
    const r = await revertBackfill({
      pg,
      entries: [
        { rowId: 1, relayUrl: `${P}/a.pdf`, storedUrl: 'https://pub/linkeon-chat-files/id/a.pdf' },
        { rowId: 1, relayUrl: `${P}/gone.pdf`, maskedUrl: `${AGENT}/files/${FK}_12_ru/gone.pdf` },
      ],
      log: jest.fn(),
    });

    expect(r).toEqual({ reverted: 1, skipped: 0 });
    expect(pg.table.get(1)).toBe(`[Скачать a.pdf](${P}/a.pdf) [Скачать gone.pdf](${P}/gone.pdf)`);
  });

  it('возвращает номер в путях релея по журналу', async () => {
    const pg = makePg([{ id: 1, content: `путь /tmp/agent-output/${FK}_12_ru/a.pdf и /tmp/agent-output/${FK}_12_ru/b.pdf` }]);

    const r = await revertBackfill({
      pg,
      entries: [{ rowId: 1, pathFrom: '/tmp/agent-output/70000000000', pathTo: `/tmp/agent-output/${FK}` }],
      log: jest.fn(),
    });

    expect(r).toEqual({ reverted: 1, skipped: 0 });
    expect(pg.table.get(1)).toBe('путь /tmp/agent-output/70000000000_12_ru/a.pdf и /tmp/agent-output/70000000000_12_ru/b.pdf');
  });
});
