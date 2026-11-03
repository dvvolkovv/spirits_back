import { Readable } from 'stream';
import axios from 'axios';
import { ChatService } from './chat.service';
import { ChatController } from './chat.controller';

jest.mock('axios');
jest.mock('../common/telegram-alert', () => ({ sendTelegramAlert: jest.fn(async () => {}) }));

/**
 * Пинг клиенту, пока релей шлёт только свой heartbeat.
 *
 * Релей присылает {"type":"heartbeat"} раз в 30 с на всё время хода, и до
 * 03.11.2026 этот трафик сбрасывал счётчик тишины бэкенда: за три минуты
 * долгой работы клиенту без `ui` уходило две строки. Flutter (receiveTimeout
 * 60 с) и внешние клиенты API рвали такой ход. Документация для внешних
 * сервисов обещает строку не реже раза в 30 секунд (client-ping.ts).
 */

const PHONE = '79030169187';
const QUIET_MS = 180_000;
const RELAY_HEARTBEAT_MS = 30_000;
const MAX_GAP_MS = 25_000;

const sse = (ev: Record<string, unknown>) => 'data: ' + JSON.stringify(ev) + '\n';

/** Ответ клиенту: что и когда (по подменённым часам) ему ушло. */
function recorder() {
  const writes: { at: number; line: string }[] = [];
  const afterEnd: string[] = [];
  let ended = false;
  const res: any = {
    status: jest.fn().mockReturnThis(),
    setHeader: jest.fn(),
    write: jest.fn((s: string) => {
      if (ended) afterEnd.push(s);
      else writes.push({ at: Date.now(), line: s });
      return true;
    }),
    end: jest.fn(() => { ended = true; }),
    json: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
  };
  return { res, writes, afterEnd };
}

/** Самая длинная пауза между строками клиенту внутри окна [from, to]. */
function maxGap(writes: { at: number }[], from: number, to: number): number {
  const points = [from, ...writes.map((w) => w.at).filter((t) => t > from && t < to), to];
  let gap = 0;
  for (let i = 1; i < points.length; i++) gap = Math.max(gap, points[i] - points[i - 1]);
  return gap;
}

async function flush(n = 5) {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
}

async function until(cond: () => boolean) {
  for (let i = 0; i < 300 && !cond(); i++) await flush(1);
  if (!cond()) throw new Error('ход не дошёл до релея');
}

/** Три минуты работы без текста: от релея — только heartbeat раз в 30 с. */
async function quietRelay(upstream: Readable) {
  for (let t = 0; t < QUIET_MS; t += RELAY_HEARTBEAT_MS) {
    upstream.push(sse({ type: 'heartbeat' }));
    await flush();
    await jest.advanceTimersByTimeAsync(RELAY_HEARTBEAT_MS);
  }
}

function finishRelay(upstream: Readable) {
  upstream.push(sse({ type: 'delta', text: 'Готово.' }));
  upstream.push(sse({ type: 'done', costUsd: 0.01 }));
  upstream.push(null);
}

describe('пинг клиенту на долгом ходе', () => {
  beforeEach(() => jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] }));
  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('текстовый ход: пауза у клиента не дольше 25 с, после end пингов нет', async () => {
    const pg = {
      query: jest.fn(async (sql: string) => (/AS spent/.test(sql) ? { rows: [{ spent: 0 }] } : { rows: [] })),
    };
    const language = { resolveUserLanguage: jest.fn(async () => 'ru') };
    const events = { track: jest.fn() };
    const svc = new ChatService(
      pg as any, null as any,
      null as any, null as any, language as any, undefined,
      undefined, events as any, undefined,
    );
    const upstream = new Readable({ read() {} });
    (axios.post as jest.Mock).mockResolvedValueOnce({ data: upstream });
    const { res, writes, afterEnd } = recorder();

    const finished = (svc as any).streamUniversalAgent(
      'u1', 'проверь жалобу', '10', '10', [], '', res, 'Алексей', '', '', undefined, false, undefined,
    );
    await until(() => (axios.post as jest.Mock).mock.calls.length > 0);
    const start = Date.now();
    await quietRelay(upstream);
    finishRelay(upstream);
    await finished;

    expect(writes.some((w) => w.line.includes('"type":"end"'))).toBe(true);
    expect(maxGap(writes, start, start + QUIET_MS)).toBeLessThanOrEqual(MAX_GAP_MS);
    await jest.advanceTimersByTimeAsync(120_000);
    expect(afterEnd).toEqual([]);
  });

  it('ход с файлом: пауза у клиента не дольше 25 с, после end пингов нет', async () => {
    const AGENT = { id: 12, name: 'Роман', display_name: 'Роман', description: '', system_prompt: '', category: 'business', is_active: true };
    const pg = {
      query: jest.fn(async (sql: string) => {
        if (/SELECT tokens FROM ai_profiles_consolidated/.test(sql)) return { rows: [{ tokens: 1_000_000 }] };
        if (/FROM agents WHERE id/.test(sql)) return { rows: [AGENT] };
        return { rows: [] };
      }),
    };
    const language = { resolveUserLanguage: jest.fn(async (_u: string, hint?: string) => hint || 'ru') };
    const svc = new ChatService(
      pg as any, null as any, null as any, null as any,
      language as any, undefined, undefined, undefined, undefined,
    );
    const jwtSvc = { verify: jest.fn(() => ({ type: 'access', userId: PHONE })) };
    const ctrl = new ChatController(svc, jwtSvc as any, undefined as any, undefined);
    const upstream = new Readable({ read() {} });
    const post = jest.fn(async () => ({ data: upstream }));
    (axios as any).default = { post };
    (axios as any).post = post;
    const { res, writes, afterEnd } = recorder();

    const finished = ctrl.uploadAndChat({
      headers: { authorization: 'Bearer t' },
      files: [{ originalname: 'egrul.pdf', buffer: Buffer.from('x'), mimetype: 'application/pdf', size: 1 }],
      body: { message: 'сколько листов?', assistantId: '12' },
    } as any, res);
    await until(() => post.mock.calls.length > 0);
    const start = Date.now();
    await quietRelay(upstream);
    finishRelay(upstream);
    await finished;
    await flush();

    expect(writes.some((w) => w.line.includes('"type":"end"'))).toBe(true);
    expect(maxGap(writes, start, start + QUIET_MS)).toBeLessThanOrEqual(MAX_GAP_MS);
    await jest.advanceTimersByTimeAsync(120_000);
    expect(afterEnd).toEqual([]);
  });
});
