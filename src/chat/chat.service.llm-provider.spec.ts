import { Readable } from 'stream';
import axios from 'axios';
import { ChatService } from './chat.service';

jest.mock('axios');
jest.mock('../common/telegram-alert', () => ({
  sendTelegramAlert: jest.fn(async () => {}),
  sendTelegramPayload: jest.fn(async () => {}),
}));

/**
 * Модель ответов человека на пути релея (spec 2026-10-30-llm-provider-switch,
 * раздел 6): выбор «Qwen» уезжает к релею полем provider, проба — noFallback,
 * а чем релей ответил (done.provider/fallback) — в chat_quality.
 * Гоняется НАСТОЯЩИЙ streamUniversalAgent с замоканными axios/pg/res — как в
 * chat.service.linkeon-fields.spec.ts и chat.service.failed-turn.spec.ts.
 */

function sseStream(events: any[]): Readable {
  const s = new Readable({ read() {} });
  process.nextTick(() => {
    for (const ev of events) s.push(`data: ${JSON.stringify(ev)}\n`);
    s.push(null);
  });
  return s;
}

/** Поля multipart-запроса к релею — то, что реально уехало. */
function fieldsOf(fd: any): Record<string, string> {
  const boundary = fd.getBoundary();
  const raw = fd.getBuffer().toString('utf8');
  const out: Record<string, string> = {};
  for (const part of raw.split(`--${boundary}`)) {
    const name = /name="([^"]+)"/.exec(part);
    const head = part.indexOf('\r\n\r\n');
    if (!name || head < 0) continue;
    out[name[1]] = part.slice(head + 4).replace(/\r\n$/, '');
  }
  return out;
}

const OLD_SECRET = process.env.JWT_SECRET;
const realSetTimeout = global.setTimeout;
beforeAll(() => {
  process.env.JWT_SECRET = 'llm-provider-spec';
  // persistResponse ставит таймер очистки dedup-карты; без unref jest не выходит.
  (global as any).setTimeout = (fn: any, ms?: number, ...a: any[]) => {
    const t: any = (realSetTimeout as any)(fn, ms, ...a);
    if (t && typeof t.unref === 'function') t.unref();
    return t;
  };
});
afterAll(() => {
  (global as any).setTimeout = realSetTimeout;
  if (OLD_SECRET === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = OLD_SECRET;
});
beforeEach(() => jest.clearAllMocks());

function harness(choice: 'claude' | 'qwen', events: any[] = [{ type: 'delta', text: 'ок' }, { type: 'done' }]) {
  const pg = { query: jest.fn(async (sql: string) => (/AS spent/.test(sql) ? { rows: [{ spent: 0 }] } : { rows: [] })) };
  const language = { resolveUserLanguage: jest.fn(async () => 'ru') };
  const tracked: { name: string; props: any }[] = [];
  const ev = { track: jest.fn((name: string, p: any) => tracked.push({ name, props: p.props })) };
  const svc = new ChatService(
    pg as any, null as any, null as any, null as any, language as any, undefined,
    undefined, ev as any, undefined,
  );
  // Позиционная сборка до последнего параметра не доходит — подставляем полем.
  const llmProvider = { get: jest.fn(async () => choice) };
  (svc as any).llmProvider = llmProvider;
  const post = axios.post as jest.Mock;
  post.mockImplementation(async () => ({ data: sseStream(events) }));
  (axios.get as jest.Mock).mockImplementation(async () => ({ data: [] }));
  const res: any = { status: jest.fn(), setHeader: jest.fn(), write: jest.fn(() => true), end: jest.fn() };
  const run = async (probe = false) => {
    await (svc as any).streamUniversalAgent(
      'u-test', 'привет', '12', '12', [], '', res, 'Роман', '', '', undefined, false,
      undefined, undefined, undefined, undefined, undefined, probe,
    );
    for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
  };
  const fields = () => fieldsOf(post.mock.calls[0][1]);
  const quality = () => tracked.find((e) => e.name === 'chat_quality')?.props;
  return { run, fields, quality, llmProvider };
}

describe('streamUniversalAgent: модель ответов человека — запрос к релею', () => {
  it('выбран Qwen — provider=qwen, без noFallback', async () => {
    const h = harness('qwen');
    await h.run();
    const f = h.fields();
    expect(f.provider).toBe('qwen');
    expect(f.noFallback).toBeUndefined();
    expect(h.llmProvider.get).toHaveBeenCalledWith('u-test');
  });

  it('выбран Claude — ни provider, ни noFallback', async () => {
    const h = harness('claude');
    await h.run();
    const f = h.fields();
    expect(f.provider).toBeUndefined();
    expect(f.noFallback).toBeUndefined();
  });

  it('проба при выборе Qwen — noFallback=1, без provider, настройку не читает', async () => {
    const h = harness('qwen');
    await h.run(true);
    const f = h.fields();
    expect(f.noFallback).toBe('1');
    expect(f.provider).toBeUndefined();
    expect(h.llmProvider.get).not.toHaveBeenCalled();
  });
});

describe('streamUniversalAgent: чем ответил релей — в chat_quality', () => {
  it('done с provider/fallback — оба в props', async () => {
    const h = harness('claude', [{ type: 'delta', text: 'ок' }, { type: 'done', provider: 'qwen', fallback: true }]);
    await h.run();
    expect(h.quality()).toMatchObject({ provider: 'qwen', fallback: true });
  });

  it('старый релей (done без полей) — provider и fallback не заданы', async () => {
    const h = harness('claude');
    await h.run();
    const q = h.quality();
    expect(q).toBeDefined();
    expect(q.provider).toBeUndefined();
    expect(q.fallback).toBeUndefined();
  });
});
