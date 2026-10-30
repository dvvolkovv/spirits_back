// src/guest-trial/guest-turn.service.spec.ts
jest.mock('../common/telegram-alert', () => ({ sendTelegramAlert: jest.fn(async () => {}) }));
import { sendTelegramAlert } from '../common/telegram-alert';
import { clockRedis } from '../auth/fake-redis.forspec';
import { CHAT_MODEL } from '../common/chat-model';
import { GUEST_MODE_BLOCK } from './guest-prompt';
import { DEFAULT_GUEST_LIMITS, GuestLimits, GuestMode } from './guest-trial.types';
import { GuestTurnService, parseGuestTurnInput } from './guest-turn.service';

const AGENT = { id: 12, name: 'Роман', description: 'персональный ассистент', persona: 'Ты Роман.' };

function makeRes() {
  const chunks: string[] = [];
  const res: any = {
    statusCode: 200,
    jsonBody: undefined as any,
    ended: false,
    get writableEnded() { return this.ended; },
    status(code: number) { this.statusCode = code; return this; },
    setHeader() {},
    write(s: string) { chunks.push(s); return true; },
    json(b: any) { this.jsonBody = b; this.ended = true; return this; },
    end() { this.ended = true; },
  };
  const events = () => chunks.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { res, events };
}

/** Пробы в памяти — тот же интерфейс, что у GuestSessionsService. */
function memorySessions() {
  const rows = new Map<string, any>();
  const byHash = new Map<string, string>();
  const msgs = new Map<string, any[]>();
  let n = 0;
  return {
    rows,
    create: jest.fn(async (p: any) => {
      const id = `s${++n}`;
      const row = { id, assistant_id: p.assistantId, lang: p.lang, answers: 0, claimed_by_hash: null, claimed_at: null, last_message_at: new Date() };
      rows.set(id, row);
      byHash.set(p.tokenHash, id);
      msgs.set(id, []);
      return { ...row };
    }),
    findLive: jest.fn(async (hash: string) => {
      const id = byHash.get(hash);
      return id ? { ...rows.get(id) } : null;
    }),
    messages: jest.fn(async (id: string) => [...(msgs.get(id) ?? [])]),
    recordExchange: jest.fn(async (id: string, human: string, ai: string) => {
      msgs.get(id)!.push({ sender_type: 'human', content: human }, { sender_type: 'ai', content: ai });
      const r = rows.get(id);
      r.answers += 1;
      return r.answers;
    }),
  };
}

const okReply = async (_p: string, o: any) => {
  o.onTextDelta?.('Здра');
  o.onTextDelta?.('вствуйте');
  return { text: 'Здравствуйте', costUsd: 0.05 };
};

function harness(opts: {
  mode?: GuestMode;
  limits?: Partial<GuestLimits>;
  reply?: (p: string, o: any) => Promise<{ text: string; costUsd: number }>;
  /** Состояние окна запасного пути на Qwen (дополнение по ревью A1) — по умолчанию закрыто. */
  fallbackStats?: () => { breakerOpenUntil: number };
} = {}) {
  const limits = { ...DEFAULT_GUEST_LIMITS, ...opts.limits };
  const store = { settings: jest.fn(async () => ({ mode: opts.mode ?? 'on', limits })) };
  const pg = { query: jest.fn(async (sql: string, params: any[]) => (/FROM agents a/.test(sql) && params[0] === 12 ? { rows: [AGENT] } : { rows: [] })) };
  const redis = clockRedis();
  const cli = {
    textWithCost: jest.fn(opts.reply ?? okReply),
    fallbackStats: jest.fn(opts.fallbackStats ?? (() => ({ breakerOpenUntil: 0 }))),
  };
  const sessions = memorySessions();
  const chat = { beginStream: jest.fn(), endStream: jest.fn() };
  const events = { track: jest.fn() };
  const svc = new GuestTurnService(pg as any, redis as any, cli as any, store as any, sessions as any, chat as any, events as any);
  svc.redisTimeoutMs = 50;
  const turn = async (body: any = {}) => {
    const { res, events: evs } = makeRes();
    await svc.handle(parseGuestTurnInput({ assistantId: '12', message: 'Привет', lang: 'ru', ...body }), res);
    return { res, evs: evs() };
  };
  return { svc, turn, cli, sessions, chat, events, redis, store };
}

beforeEach(() => (sendTelegramAlert as jest.Mock).mockClear());

describe('ход гостя: режимы', () => {
  it('«выкл» — стена closed, модель не зовётся', async () => {
    const h = harness({ mode: 'off' });
    const { evs } = await h.turn();
    expect(evs.map((e) => e.type)).toEqual(['guest', 'wall']);
    expect(evs[1]).toEqual({ type: 'wall', reason: 'closed' });
    expect(h.cli.textWithCost).not.toHaveBeenCalled();
  });

  it('«предпросмотр» — только с preview', async () => {
    const h = harness({ mode: 'preview' });
    expect((await h.turn()).evs[1]).toEqual({ type: 'wall', reason: 'closed' });
    expect((await h.turn({ preview: true })).evs.find((e) => e.type === 'end')).toEqual({ type: 'end', content: 'Здравствуйте' });
    expect(h.events.track).toHaveBeenCalledWith('guest_trial_answer', expect.objectContaining({
      props: expect.objectContaining({ preview: true }),
    }));
  });
});

describe('ход гостя: поток', () => {
  it('новая проба: ключ, остаток, куски, итог — и запись пары', async () => {
    const h = harness();
    const { evs } = await h.turn();
    expect(evs[0].type).toBe('guest');
    expect(evs[0].token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(evs[0].left).toBe(3);
    expect(evs.slice(1).map((e) => e.type)).toEqual(['begin', 'item', 'item', 'end']);
    expect(h.sessions.recordExchange).toHaveBeenCalledWith('s1', 'Привет', 'Здравствуйте', expect.any(Date), 0.05);
    expect(h.events.track).toHaveBeenCalledWith('guest_trial_answer', expect.objectContaining({
      props: expect.objectContaining({ n: 1, trial: 's1', assistant_id: '12', lang: 'ru', cost_usd: 0.05, preview: false }),
    }));
  });

  it('куски пришли, итог похож на отказ CLI — всё равно ответ (M3)', async () => {
    const h = harness({
      reply: async (_p: string, o: any) => {
        o.onTextDelta?.('Напи');
        o.onTextDelta?.('шем так:');
        return { text: "You've hit your limit · resets 10am (UTC)", costUsd: 0.01 };
      },
    });
    const { evs } = await h.turn();
    expect(evs.find((e) => e.type === 'end')).toEqual({ type: 'end', content: "You've hit your limit · resets 10am (UTC)" });
    expect(h.sessions.recordExchange).toHaveBeenCalledWith('s1', 'Привет', "You've hit your limit · resets 10am (UTC)", expect.any(Date), 0.01);
  });

  it('модель зовётся без инструментов, без запасного Qwen, с персоной и пробным режимом', async () => {
    const h = harness();
    await h.turn();
    const [prompt, o] = h.cli.textWithCost.mock.calls[0];
    expect(prompt).toBe('USER: Привет');
    expect(o).toMatchObject({ model: CHAT_MODEL, noFallback: true });
    expect(o.tools).toBeUndefined();
    expect(o.mcpServers).toBeUndefined();
    expect(o.allowedTools).toBeUndefined();
    expect(o.system).toContain('Ты Роман.');
    expect(o.system).toContain(GUEST_MODE_BLOCK);
  });

  it('третий ответ — стена limit после итога; четвёртый — стена без модели', async () => {
    const h = harness();
    const first = await h.turn();
    const token = first.evs[0].token;
    await h.turn({ token });
    const third = await h.turn({ token });
    expect(third.evs.slice(-2)).toEqual([{ type: 'end', content: 'Здравствуйте' }, { type: 'wall', reason: 'limit' }]);
    const calls = h.cli.textWithCost.mock.calls.length;
    const fourth = await h.turn({ token });
    expect(fourth.evs).toEqual([{ type: 'guest', left: 0 }, { type: 'wall', reason: 'limit' }]);
    expect(h.cli.textWithCost.mock.calls.length).toBe(calls);
  });

  it('второй ход видит первую пару в промпте', async () => {
    const h = harness();
    const token = (await h.turn()).evs[0].token;
    await h.turn({ token, message: 'А ещё?' });
    expect(h.cli.textWithCost.mock.calls[1][0]).toBe('USER: Привет\n\nASSISTANT: Здравствуйте\n\nUSER: А ещё?');
  });

  it('история в промпте ограничена последними двумя парами (I2)', async () => {
    const h = harness({ limits: { answersPerTrial: 5 } });
    const token = (await h.turn()).evs[0].token;
    await h.turn({ token, message: 'Второй' });
    await h.turn({ token, message: 'Третий' });
    await h.turn({ token, message: 'Четвёртый' });
    const prompt = h.cli.textWithCost.mock.calls[3][0];
    expect(prompt).toBe('USER: Второй\n\nASSISTANT: Здравствуйте\n\nUSER: Третий\n\nASSISTANT: Здравствуйте\n\nUSER: Четвёртый');
    expect(prompt).not.toContain('Привет');
  });
});

describe('ход гостя: отказы', () => {
  it('незнакомый ассистент и слишком длинное сообщение — 400', async () => {
    const h = harness({ limits: { maxChars: 10 } });
    expect((await h.turn({ assistantId: '999' })).res.statusCode).toBe(400);
    expect((await h.turn({ message: 'x'.repeat(11) })).res.statusCode).toBe(400);
    expect(h.cli.textWithCost).not.toHaveBeenCalled();
  });

  it('чужой ключ — 404, ключ другого ассистента — 409', async () => {
    const h = harness();
    expect((await h.turn({ token: 'x'.repeat(43) })).res.statusCode).toBe(404);
    const token = (await h.turn()).evs[0].token;
    h.sessions.rows.get('s1').assistant_id = 14;
    expect((await h.turn({ token })).res.statusCode).toBe(409);
  });

  it('сбой модели и отказ CLI текстом — error, пара не пишется', async () => {
    const failing = harness({ reply: async () => { throw new Error('claude CLI exited with code 1'); } });
    expect((await failing.turn()).evs.slice(-1)).toEqual([{ type: 'error', code: 'model' }]);
    expect(failing.sessions.recordExchange).not.toHaveBeenCalled();
    expect(failing.events.track).toHaveBeenCalledWith('guest_trial_error', { props: { reason: 'model', assistant_id: '12' } });

    const refusal = harness({ reply: async () => ({ text: "You've hit your weekly limit · resets 10am (UTC)", costUsd: 0 }) });
    expect((await refusal.turn()).evs.slice(-1)).toEqual([{ type: 'error', code: 'model' }]);
    expect(refusal.sessions.recordExchange).not.toHaveBeenCalled();
  });

  it('проба перенесена посреди хода (recordExchange → null) — error model, без события end (I1)', async () => {
    const h = harness();
    const token = (await h.turn()).evs[0].token;
    h.sessions.recordExchange.mockResolvedValueOnce(null);
    const { evs } = await h.turn({ token });
    expect(evs.slice(-1)).toEqual([{ type: 'error', code: 'model' }]);
    expect(evs.find((e) => e.type === 'end')).toBeUndefined();
    expect(h.events.track).toHaveBeenCalledWith('guest_trial_error', { props: { reason: 'claimed', assistant_id: '12' } });
  });

  it('сбой после начала ответа (recordExchange бросает) — error, счётчики парные, следующий ход не 409 (I3)', async () => {
    const h = harness();
    h.sessions.recordExchange.mockImplementationOnce(() => { throw new Error('db down'); });
    const first = await h.turn();
    expect(first.evs.slice(-1)).toEqual([{ type: 'error', code: 'model' }]);
    expect(first.evs.find((e) => e.type === 'end')).toBeUndefined();
    expect(h.chat.beginStream).toHaveBeenCalledTimes(1);
    expect(h.chat.endStream).toHaveBeenCalledTimes(1);
    const token = first.evs[0].token;
    expect((await h.turn({ token })).res.statusCode).not.toBe(409);
  });

  it('окно запасного пути на Qwen открыто — сразу error model, модель не зовётся', async () => {
    const h = harness({ fallbackStats: () => ({ breakerOpenUntil: Date.now() + 60_000 }) });
    const { evs } = await h.turn();
    expect(evs.slice(-1)).toEqual([{ type: 'error', code: 'model' }]);
    expect(h.cli.textWithCost).not.toHaveBeenCalled();
    expect(h.redis.peek('guest-lim:answers:h')).toBeNull();
  });

  it('общий потолок ответов — closed и одно сообщение владельцу за окно', async () => {
    const h = harness({ limits: { answersPerHour: 1 } });
    await h.turn();
    const second = await h.turn();
    expect(second.evs.slice(-1)).toEqual([{ type: 'wall', reason: 'closed' }]);
    await h.turn();
    await new Promise((r) => setImmediate(r));
    expect(sendTelegramAlert).toHaveBeenCalledTimes(1);
    expect(h.events.track).toHaveBeenCalledWith('guest_trial_closed', { props: { scope: 'answers_hour' } });
  });

  it('Redis висит — closed за срок, модель не зовётся', async () => {
    const h = harness();
    (h.redis as any).eval = () => new Promise(() => {});
    const { evs } = await h.turn();
    expect(evs.slice(-1)).toEqual([{ type: 'wall', reason: 'closed' }]);
    expect(h.cli.textWithCost).not.toHaveBeenCalled();
  });

  it('потолок одновременных ходов — error busy; счётчики возвращаются', async () => {
    let release: () => void = () => {};
    let calls = 0;
    const h = harness({
      limits: { concurrentTurns: 1 },
      // Первый ход висит, пока его не отпустят; следующие отвечают сразу.
      reply: () => (++calls === 1
        ? new Promise((resolve) => { release = () => resolve({ text: 'Готово', costUsd: 0 }); })
        : Promise.resolve({ text: 'Потом', costUsd: 0 })),
    });
    const first = h.turn();
    await new Promise((r) => setTimeout(r, 20));
    const second = await h.turn();
    expect(second.evs.slice(-1)).toEqual([{ type: 'error', code: 'busy' }]);
    release();
    await first;
    expect(h.chat.beginStream).toHaveBeenCalledTimes(1);
    expect(h.chat.endStream).toHaveBeenCalledTimes(1);
    expect((await h.turn()).evs.find((e) => e.type === 'end')).toBeTruthy();
  });

  it('второй ход той же пробы, пока идёт первый, — 409', async () => {
    let release: () => void = () => {};
    let calls = 0;
    const h = harness({
      reply: () => (++calls === 1
        ? Promise.resolve({ text: 'Первый', costUsd: 0 })
        : new Promise((resolve) => { release = () => resolve({ text: 'Второй', costUsd: 0 }); })),
    });
    const token = (await h.turn()).evs[0].token;
    const pending = h.turn({ token });
    await new Promise((r) => setTimeout(r, 20));
    expect((await h.turn({ token })).res.statusCode).toBe(409);
    release();
    await pending;
  });
});

describe('разбор тела хода', () => {
  it('источник — только из известных видов, sid — только безопасные знаки', () => {
    const i = parseGuestTurnInput({ assistantId: '12', message: 'x', lang: 'de-DE', source: 'utm:vk/cpc', sid: 's_ab.c-1', preview: true });
    expect(i).toMatchObject({ lang: 'de', source: 'utm:vk/cpc', sid: 's_ab.c-1', preview: true, token: null });
    const j = parseGuestTurnInput({ source: '<script>', sid: 'a b', preview: 'true' });
    expect(j).toMatchObject({ source: null, sid: null, preview: false });
  });
});
