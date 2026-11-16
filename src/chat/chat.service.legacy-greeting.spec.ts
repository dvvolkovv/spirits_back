import axios from 'axios';
import { ChatService } from './chat.service';

jest.mock('axios');

/**
 * Автоприветствие старой вкладки в streamChat (тикет 8cf1c5ae). Клиент до
 * 13.11 сам слал «Привет! Расскажи про себя!» в каждый пустой чат — и при
 * каждом включении «Чистого листа»; ход шёл в модель и списывал токены. Такое
 * сообщение в пустой сессии получает короткий ответ без модели, без списания
 * и без записи в историю.
 *
 * Харнес — как в chat.service.no-tokens-gate.spec.ts. balanceCtx подменён
 * заглушкой, которая падает: если ход прошёл мимо защиты к блоку баланса,
 * тест покажет это сообщением, а не TypeError на null.
 */
const PAST_GUARD = 'ход прошёл мимо защиты от автоприветствия';

function makeService(opts: { history?: Array<{ sender_type: string; content: string }>; tokens?: number } = {}) {
  const pg = {
    query: jest.fn(async (sql: string) => {
      if (/SELECT tokens FROM ai_profiles_consolidated/.test(sql)) return { rows: [{ tokens: opts.tokens ?? 5000 }] };
      if (/^\s*SELECT[\s\S]*FROM custom_chat_history/.test(sql)) return { rows: opts.history ?? [] };
      return { rows: [] };
    }),
  };
  const language = { resolveUserLanguage: jest.fn(async (_u: string, hint?: string) => hint || 'ru') };
  const balanceCtx = { buildContextForPrompt: jest.fn(async () => { throw new Error(PAST_GUARD); }) };
  const svc = new ChatService(
    pg as any, null as any, null as any, null as any, language as any,
    balanceCtx as any,
  );
  jest.spyOn(svc as any, 'resolveAgent').mockResolvedValue({
    id: 7, name: 'Роман', display_name: 'Роман', description: '', system_prompt: '', category: 'assistant',
  });
  return { svc, pg };
}

function makeRes() {
  const writes: any[] = [];
  const res: any = {
    status: jest.fn(),
    setHeader: jest.fn(),
    write: jest.fn((s: string) => { try { writes.push(JSON.parse(s)); } catch {} return true; }),
    end: jest.fn(),
  };
  return { res, writes };
}

const RU_GREETING = 'Привет! Расскажи про себя!';
const FRESH_SESSION = 'u1_7_fresh_1763285453000';

describe('ChatService.streamChat — автоприветствие старой вкладки', () => {
  beforeEach(() => jest.clearAllMocks());

  it('в пустой fresh-сессии отвечает сам: короткий текст, usage 0, без модели', async () => {
    const { svc } = makeService();
    const { res, writes } = makeRes();
    await svc.streamChat('u1', RU_GREETING, '7', FRESH_SESSION, '', res, undefined, true, 'ru');

    expect(writes.map((w) => w.type)).toEqual(['begin', 'item', 'end']);
    const end = writes[2];
    expect(end.content).toBe('Здравствуйте! Чем могу помочь?');
    expect(writes[1].content).toBe(end.content);
    expect(end.usage).toEqual({ input: 0, output: 0, total: 0 });
    // reason: 'no_tokens' открыл бы у старого клиента окно пополнения.
    expect(end.reason).toBeUndefined();
    expect(res.end).toHaveBeenCalled();
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('ничего не пишет в базу: чат остаётся пустым, списания нет', async () => {
    const { svc, pg } = makeService();
    const { res } = makeRes();
    await svc.streamChat('u1', RU_GREETING, '7', FRESH_SESSION, '', res, undefined, true, 'ru');

    const writesToDb = pg.query.mock.calls.map(([sql]) => String(sql)).filter((sql) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql));
    expect(writesToDb).toEqual([]);
  });

  it('историю спрашивает у fresh-сессии из запроса', async () => {
    const { svc, pg } = makeService();
    const { res } = makeRes();
    await svc.streamChat('u1', RU_GREETING, '7', FRESH_SESSION, '', res, undefined, true, 'ru');

    const histCall = pg.query.mock.calls.find(([sql]) => /FROM custom_chat_history/.test(String(sql)));
    expect(histCall?.[1]).toEqual([FRESH_SESSION]);
  });

  it('на нулевом балансе — тот же ответ, а не окно пополнения', async () => {
    const { svc } = makeService({ tokens: 0 });
    const { res, writes } = makeRes();
    await svc.streamChat('u1', RU_GREETING, '7', 'u1_7', '', res);

    const end = writes.find((w) => w.type === 'end');
    expect(end.content).toBe('Здравствуйте! Чем могу помочь?');
    expect(end.reason).toBeUndefined();
  });

  it('язык ответа — язык приветствия, а не профиля', async () => {
    const { svc } = makeService();
    const { res, writes } = makeRes();
    // Профиль (заглушка language) без подсказки ответил бы 'ru'.
    await svc.streamChat('u1', 'Hi! Tell me about yourself!', '7', 'u1_7', '', res);

    const end = writes.find((w) => w.type === 'end');
    expect(end.content).toBe('Hello! How can I help?');
  });

  it('в сессии с историей тот же текст идёт обычным путём (здесь — шлагбаум нуля)', async () => {
    const { svc } = makeService({
      tokens: 0,
      history: [{ sender_type: 'ai', content: 'Здравствуйте!' }],
    });
    const { res, writes } = makeRes();
    await svc.streamChat('u1', RU_GREETING, '7', 'u1_7', '', res, undefined, false, 'ru');

    const end = writes.find((w) => w.type === 'end');
    expect(end.reason).toBe('no_tokens');
  });

  it('похожий, но не тот текст в пустой сессии идёт обычным путём', async () => {
    const { svc } = makeService({ tokens: 0 });
    const { res, writes } = makeRes();
    await svc.streamChat('u1', 'Hi! Tell me about yourself! I am 30', '7', 'u1_7', '', res, undefined, false, 'en');

    const end = writes.find((w) => w.type === 'end');
    expect(end.reason).toBe('no_tokens');
  });
});
