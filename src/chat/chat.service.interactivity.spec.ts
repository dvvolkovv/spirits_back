import { Readable } from 'stream';
import axios from 'axios';
import { ChatService } from './chat.service';
import { ASK_RULE } from './ask-rule';
import { LANGUAGE_REPLY_LINE } from '../common/services/language.service';

jest.mock('axios');

/**
 * Шаги работы и карточки вопросов на пути релея (streamUniversalAgent).
 * Гоняется НАСТОЯЩИЙ метод с замоканными axios/pg/res — как в
 * chat.service.speech-marker.spec.ts.
 */

const PHONE = '79030169187';

function sseStream(events: any[]): Readable {
  const s = new Readable({ read() {} });
  process.nextTick(() => {
    for (const ev of events) s.push(`data: ${JSON.stringify(ev)}\n`);
    s.push(null);
  });
  return s;
}

/** Поля multipart-запроса к релею. */
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

const EVENTS = [
  { type: 'tool', tool: 'WebSearch', input: '{"query":"офис Казань"}' },
  { type: 'tool', tool: 'Bash', input: '{"command":"sleep 4"}' },
  { type: 'delta', text: 'Нашёл три варианта.' },
  { type: 'done' },
];

function makeHarness() {
  const written: any[] = [];
  const pg = {
    query: jest.fn(async (sql: string) => {
      if (/AS spent/.test(sql)) return { rows: [{ spent: 0 }] };
      return { rows: [] };
    }),
  };
  const language = { resolveUserLanguage: jest.fn(async () => 'ru') };
  const svc = new ChatService(
    pg as any, null as any, null as any, null as any, null as any,
    language as any, undefined, undefined, undefined, undefined,
  );
  const post = axios.post as jest.Mock;
  post.mockResolvedValue({ data: sseStream(EVENTS) });
  const res: any = {
    status: jest.fn(),
    setHeader: jest.fn(),
    write: jest.fn((l: string) => { written.push(JSON.parse(l)); return true; }),
    end: jest.fn(),
  };
  const run = async (ui?: { activity: boolean; ask: boolean }) => {
    await (svc as any).streamUniversalAgent(
      PHONE, 'найди офис', '12', '12', [], '', res, 'Роман', '', '', undefined, false,
      undefined, undefined, undefined, undefined, undefined, false, ui,
    );
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  };
  return { written, post, run };
}

describe('streamUniversalAgent: шаги работы и правило карточек', () => {
  // persistResponse ставит таймер очистки dedup-карты; без unref jest не выходит.
  const realSetTimeout = global.setTimeout;
  const OLD_SECRET = process.env.JWT_SECRET;
  beforeAll(() => {
    process.env.JWT_SECRET = 'test-secret-interactivity';
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

  it('клиенту, который умеет, уходит шаг — без служебного sleep', async () => {
    const h = makeHarness();
    await h.run({ activity: true, ask: false });
    expect(h.written.filter((w) => w.type === 'activity'))
      .toEqual([{ type: 'activity', kind: 'web_search', detail: 'офис Казань' }]);
  });

  it('шаг не попадает в текст ответа', async () => {
    const h = makeHarness();
    await h.run({ activity: true, ask: false });
    const text = h.written.filter((w) => w.type === 'item').map((w) => w.content).join('');
    expect(text).toBe('Нашёл три варианта.');
  });

  it('без ui шагов нет — мобилка получает ход как раньше', async () => {
    const h = makeHarness();
    await h.run(undefined);
    expect(h.written.some((w) => w.type === 'activity')).toBe(false);
  });

  it('правило карточек — в системном промпте при ui.ask, а не в реплике', async () => {
    const h = makeHarness();
    await h.run({ activity: false, ask: true });
    const f = fieldsOf(h.post.mock.calls[0][1]);
    expect(f.systemPrompt).toContain(ASK_RULE);
    // В реплике правило копилось бы в резюмируемой сессии на каждом ходе.
    expect(f.message).not.toContain('УТОЧНЯЮЩИЕ ВОПРОСЫ');
    // Язык по-прежнему последней строкой перед репликой.
    expect(f.message).toContain(LANGUAGE_REPLY_LINE.ru);
  });

  it('без ui.ask правила нет нигде', async () => {
    const h = makeHarness();
    await h.run(undefined);
    const f = fieldsOf(h.post.mock.calls[0][1]);
    expect(f.systemPrompt).not.toContain('УТОЧНЯЮЩИЕ ВОПРОСЫ');
    expect(f.message).not.toContain('УТОЧНЯЮЩИЕ ВОПРОСЫ');
  });
});

describe('buildUploadHandoff: системный промпт загрузки совпадает с текстовым ходом', () => {
  it('при ask — с правилом карточек, без — без', async () => {
    const pg = {
      query: jest.fn(async (sql: string) => {
        if (/FROM agents WHERE id/.test(sql)) {
          return { rows: [{ id: 12, name: 'Роман', description: '', system_prompt: '', category: 'business', is_active: true }] };
        }
        return { rows: [] };
      }),
    };
    const language = { resolveUserLanguage: jest.fn(async () => 'ru') };
    const svc = new ChatService(
      pg as any, null as any, null as any, null as any, null as any,
      language as any, undefined, undefined, undefined, undefined,
    );
    const withAsk = await svc.buildUploadHandoff({ userId: PHONE, assistantId: '12', ask: true });
    const without = await svc.buildUploadHandoff({ userId: PHONE, assistantId: '12' });
    expect(withAsk.systemPrompt).toContain(ASK_RULE);
    expect(without.systemPrompt).not.toContain('УТОЧНЯЮЩИЕ ВОПРОСЫ');
  });
});
