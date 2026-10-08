// src/chat/chat.service.chat-files.spec.ts
import { Readable } from 'stream';
import axios from 'axios';
import { ChatService } from './chat.service';

jest.mock('axios');

/**
 * Файлы, которые ассистент создал на релее, должны уходить пользователю
 * ссылкой на наш MinIO — и в потоке, и в истории ОДНОЙ И ТОЙ ЖЕ строкой:
 * фронт сверяет ленту с историей посимвольно (historyMerge.ts).
 *
 * Гоняется НАСТОЯЩИЙ streamUniversalAgent с замоканными axios/pg/res, как в
 * chat.service.speech-marker.spec.ts.
 */

const RELAY_FILE = 'https://r.linkeon.io/files/u1_7_ru/report.pdf';
const STORED = 'https://pub/linkeon-chat-files/11111111-2222-4333-8444-555555555555/report.pdf';
const OUTPUT = [{ name: 'report.pdf', url: '/files/u1_7_ru/report.pdf', size: 10 }];

function sseStream(events: any[]): Readable {
  const s = new Readable({ read() {} });
  process.nextTick(() => {
    for (const ev of events) s.push(`data: ${JSON.stringify(ev)}\n`);
    s.push(null);
  });
  return s;
}

function makeHarness(opts: { deltas: string[]; outputFiles?: any[]; store?: any }) {
  const written: any[] = [];
  const pgCalls: { sql: string; params: any[] }[] = [];
  const pg = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      pgCalls.push({ sql, params });
      if (/AS spent/.test(sql)) return { rows: [{ spent: 0 }] };
      return { rows: [] };
    }),
  };
  const language = { resolveUserLanguage: jest.fn(async () => 'ru') };
  const svc = new ChatService(
    pg as any, null as any, null as any, null as any, null as any, language as any,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    opts.store,
  );
  const post = axios.post as jest.Mock;
  post.mockImplementation(async () => ({
    data: sseStream([
      ...opts.deltas.map((text) => ({ type: 'delta', text })),
      { type: 'done', outputFiles: opts.outputFiles ?? [] },
    ]),
  }));
  const res: any = {
    status: jest.fn(),
    setHeader: jest.fn(),
    write: jest.fn((line: string) => { written.push(JSON.parse(line)); return true; }),
    end: jest.fn(),
  };
  const run = async () => {
    await (svc as any).streamUniversalAgent(
      'u1', 'сделай отчёт', '7', '7', [], '', res, 'Роман', '', '', undefined, false, undefined,
    );
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  };
  return { written, pgCalls, run, post };
}

const items = (written: any[]) => written.filter((w) => w.type === 'item').map((w) => w.content as string);
const persistedAiText = (pgCalls: { sql: string; params: any[] }[]) =>
  pgCalls.find((c) => /INSERT INTO custom_chat_history/.test(c.sql) && /'ai'/.test(c.sql))?.params[2] as string | undefined;
const storeOk = () => ({ persist: jest.fn(async (urls: string[]) => new Map(urls.map((u) => [u, STORED]))) });

describe('streamUniversalAgent — файлы хода в нашем хранилище', () => {
  // persistResponse ставит 14-секундный таймер очистки dedup-карты; unref, чтобы jest вышел.
  const realSetTimeout = global.setTimeout;
  beforeAll(() => {
    (global as any).setTimeout = (fn: any, ms?: number, ...a: any[]) => {
      const t: any = (realSetTimeout as any)(fn, ms, ...a);
      if (t && typeof t.unref === 'function') t.unref();
      return t;
    };
  });
  afterAll(() => { (global as any).setTimeout = realSetTimeout; });
  beforeEach(() => { jest.clearAllMocks(); delete process.env.AGENT_URL; });

  it('ссылка уходит клиенту и в историю одной строкой — уже с нашим адресом', async () => {
    const store = storeOk();
    const h = makeHarness({ deltas: ['Готово, отчёт приложил.'], outputFiles: OUTPUT, store });
    await h.run();

    expect(store.persist).toHaveBeenCalledWith([RELAY_FILE]);
    const link = items(h.written).find((c) => c.includes('Скачать report.pdf'));
    expect(link).toBe(`\n\n[Скачать report.pdf](${STORED})`);
    const saved = persistedAiText(h.pgCalls);
    expect(saved).toContain(link);
    expect(saved).not.toContain('r.linkeon.io');
  });

  it('ссылка идёт после текста ответа', async () => {
    const h = makeHarness({ deltas: ['Часть 1. ', 'Часть 2.'], outputFiles: OUTPUT, store: storeOk() });
    await h.run();

    const all = items(h.written);
    expect(all.findIndex((c) => c.includes('Скачать'))).toBeGreaterThan(all.indexOf('Часть 2.'));
  });

  it('файл не скопировался — ссылка остаётся на релей, как раньше', async () => {
    const store = { persist: jest.fn(async () => new Map<string, string>()) };
    const h = makeHarness({ deltas: ['Готово.'], outputFiles: OUTPUT, store });
    await h.run();

    expect(items(h.written)).toContain(`\n\n[Скачать report.pdf](${RELAY_FILE})`);
  });

  it('без хранилища — ссылка на релей, как раньше', async () => {
    const h = makeHarness({ deltas: ['Готово.'], outputFiles: OUTPUT, store: undefined });
    await h.run();

    expect(items(h.written)).toContain(`\n\n[Скачать report.pdf](${RELAY_FILE})`);
  });

  it('ход из одних файлов не считается пустым и релей не гоняется второй раз', async () => {
    const h = makeHarness({ deltas: [], outputFiles: OUTPUT, store: storeOk() });
    await h.run();

    expect(h.post).toHaveBeenCalledTimes(1);
    expect(items(h.written)).toContain(`\n\n[Скачать report.pdf](${STORED})`);
  });

  it('адрес релея, набранный моделью, дописывается ссылкой уже на наше хранилище', async () => {
    const h = makeHarness({ deltas: [`Файл тут: \`${RELAY_FILE}\``], store: storeOk() });
    await h.run();

    expect(items(h.written)).toContain(`\n\n[Скачать report.pdf](${STORED})`);
  });
});
