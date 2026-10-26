import { Readable } from 'stream';
import axios from 'axios';
import { ChatService } from './chat.service';
import { verifyProductToolToken } from '../products/product-tool.token';
import { customAssistantHelpLine, platformGuide } from './platform-guide';

jest.mock('axios');

/**
 * Справка на пути релея: токен точки продуктов несёт язык, клиент и вид
 * ассистента, системный промпт — карту с правилом справки. Гоняется НАСТОЯЩИЙ
 * streamUniversalAgent с замоканными axios/pg/res — как в
 * chat.service.interactivity.spec.ts.
 */

const HELP = 'mcp__products__linkeon_help';

function sseStream(events: any[]): Readable {
  const s = new Readable({ read() {} });
  process.nextTick(() => {
    for (const ev of events) s.push(`data: ${JSON.stringify(ev)}\n`);
    s.push(null);
  });
  return s;
}

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

function harness() {
  const pg = {
    query: jest.fn(async (sql: string) => {
      if (/AS spent/.test(sql)) return { rows: [{ spent: 0 }] };
      return { rows: [] };
    }),
  };
  const language = { resolveUserLanguage: jest.fn(async () => 'ru') };
  const svc = new ChatService(pg as any, null as any, null as any, null as any, language as any, undefined, undefined, undefined, undefined);
  const post = axios.post as jest.Mock;
  post.mockResolvedValue({ data: sseStream([{ type: 'delta', text: 'ок' }, { type: 'done' }]) });
  const res: any = { status: jest.fn(), setHeader: jest.fn(), write: jest.fn(() => true), end: jest.fn() };
  const run = async (agentId: string, ui?: { activity: boolean; ask: boolean }, storeBuild = false) => {
    await (svc as any).streamUniversalAgent(
      'u-test', 'как привязать домен?', agentId, agentId, [], '', res, 'Роман', '', 'Ты Роман.', undefined, false,
      undefined, undefined, undefined, undefined, undefined, false, ui, storeBuild,
    );
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    return fieldsOf(post.mock.calls[post.mock.calls.length - 1][1]);
  };
  return { run };
}

describe('streamUniversalAgent: справка', () => {
  const realSetTimeout = global.setTimeout;
  const OLD_SECRET = process.env.JWT_SECRET;
  beforeAll(() => {
    process.env.JWT_SECRET = 'test-secret-help-fields';
    // persistResponse ставит таймер очистки dedup-карты; без unref jest не выходит.
    (global as any).setTimeout = (fn: any, ms?: number, ...a: any[]) => {
      const t: any = (realSetTimeout as any)(fn, ms, ...a);
      if (t && typeof t.unref === 'function') t.unref();
      return t;
    };
  });
  afterAll(() => {
    (global as any).setTimeout = realSetTimeout;
    process.env.JWT_SECRET = OLD_SECRET;
  });
  beforeEach(() => jest.clearAllMocks());

  it('веб: токен несёт язык, клиент web и штатного ассистента', async () => {
    const f = await harness().run('12', { activity: true, ask: false });
    expect(verifyProductToolToken(f.products_token)).toEqual({ userId: 'u-test', channel: 'web', lang: 'ru', client: 'web', agent: 'staff' });
  });

  it('без ui (Flutter) — клиент app', async () => {
    const f = await harness().run('12');
    expect(verifyProductToolToken(f.products_token).client).toBe('app');
  });

  it('сборка из стора — клиент store, карта без партнёров', async () => {
    const f = await harness().run('12', undefined, true);
    expect(verifyProductToolToken(f.products_token).client).toBe('store');
    expect(f.systemPrompt).toContain(platformGuide('ru', { helpTool: HELP, store: true, initiative: true }));
  });

  it('свой ассистент — agent custom и строка про справку в промпте', async () => {
    const f = await harness().run('custom:6f1c2b9e-0000-4000-8000-000000000000', { activity: true, ask: false });
    expect(verifyProductToolToken(f.products_token).agent).toBe('custom');
    expect(f.systemPrompt).toContain(customAssistantHelpLine(HELP));
  });
});
