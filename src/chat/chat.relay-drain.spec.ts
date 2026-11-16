import { Readable } from 'stream';
import axios from 'axios';
import { ChatService } from './chat.service';
import { ChatController } from './chat.controller';
import { chatFailureText } from './chat-failure-texts';

jest.mock('axios');
jest.mock('../common/telegram-alert', () => ({ sendTelegramAlert: jest.fn(async () => {}) }));

/**
 * Пункт aa27b1d5: на выкате релей отвечает 502/503 (шлагбаум deploy-relay.sh,
 * nginx при рестарте). Ход ждёт и повторяет (relay-drain-retry.ts), а не падает
 * сразу. Здесь — настоящая проводка: веб-ход (streamUniversalAgent) и загрузка
 * (ChatController.uploadAndChat), та же обвязка, что в chat.relay-running.spec.ts.
 */

const NOTE = 'тот ход прерван';
const DELTA = 'data: ' + JSON.stringify({ type: 'delta', text: 'ответ' }) + '\n';
const DONE = 'data: ' + JSON.stringify({ type: 'done', costUsd: 0.1 }) + '\n';

function makeServiceWithPgCalls() {
  const calls: { sql: string; params: any[] }[] = [];
  const pg = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      if (/SELECT tokens FROM ai_profiles_consolidated/.test(sql)) return { rows: [{ tokens: 1_000_000 }] };
      if (/AS spent/.test(sql)) return { rows: [{ spent: 0 }] };
      return { rows: [] };
    }),
  };
  const language = { resolveUserLanguage: jest.fn(async (_uid: string, hint?: string) => hint || 'ru') };
  const svc = new ChatService(
    pg as any, null as any, null as any, null as any, language as any,
    undefined, undefined, undefined, undefined,
  );
  return { svc, calls };
}

const queue: (Readable | Error)[] = [];
const post = jest.fn(async (..._args: any[]) => {
  const next = queue.shift();
  if (!next) throw new Error('апстрим для этого вызова не подготовлен тестом');
  if (next instanceof Error) throw next;
  return { data: next };
});

beforeEach(() => {
  queue.length = 0;
  post.mockClear();
  (axios as any).default = { post };
  (axios as any).post = post;
});
afterEach(() => jest.useRealTimers());

/** Значение поля multipart-формы, которой ушёл вызов axios.post под номером call. */
function field(call: any[], name: string): string {
  const parts: any[] = (call[1] as any)._streams || [];
  const idx = parts.findIndex((p) => typeof p === 'string' && new RegExp(`name="${name}"`).test(p));
  return String(parts[idx + 1] ?? '');
}
const msg = (i: number) => field(post.mock.calls[i], 'message');
const sid = (i: number) => field(post.mock.calls[i], 'sessionId');

async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

const err503 = () => Object.assign(new Error('Request failed with status code 503'), {
  response: { status: 503, data: Readable.from([]) },
});
const stream = () => new Readable({ read() {} });

/** Строки NDJSON, ушедшие клиенту. */
function writes(res: any): any[] {
  const out: any[] = [];
  for (const c of res.write.mock.calls) {
    for (const line of String(c[0]).split('\n')) {
      if (!line) continue;
      try { out.push(JSON.parse(line)); } catch { /* не JSON — не наше */ }
    }
  }
  return out;
}
const ends = (res: any) => writes(res).filter((w) => w.type === 'end');
const items = (res: any) => writes(res).filter((w) => w.type === 'item').map((w) => w.content);

function newRes(): any {
  return {
    status: jest.fn().mockReturnThis(), setHeader: jest.fn(), write: jest.fn(() => true),
    end: jest.fn(), json: jest.fn().mockReturnThis(), send: jest.fn().mockReturnThis(),
  };
}

function turn(svc: ChatService, message: string, upstreams: (Readable | Error)[], lang?: string) {
  queue.push(...upstreams);
  const res = newRes();
  const done = (svc as any).streamUniversalAgent(
    'u1', message, '7', '7', [], '', res, 'Роман', '', '', undefined, false, undefined, lang,
  );
  return { done, res };
}

const tokenInserts = (calls: { sql: string }[]) => calls.filter((c) => /INSERT INTO token_consumption_tasks/.test(c.sql));
const savedStrings = (calls: { params: any[] }[]) => calls.flatMap((c) => c.params).filter((p) => typeof p === 'string');

/**
 * Обучение профиля, разбор задач и карточка бизнеса — то, что persistResponse
 * зовёт за ход с текстом ответа. Подменяем зависимости, чтобы видеть вызовы.
 */
function learning(svc: ChatService) {
  const spies = {
    consolidate: jest.fn(async (..._a: any[]) => {}),
    tasks: jest.fn(async (..._a: any[]) => {}),
    business: jest.fn(async (..._a: any[]) => {}),
  };
  (svc as any).neo4j = { consolidateFromChat: spies.consolidate };
  (svc as any).tasksService = { extractFromTurn: spies.tasks, buildContextForPrompt: jest.fn(async () => '') };
  (svc as any).businessProfile = { extractFromTurn: spies.business, renderForPrompt: jest.fn(async () => '') };
  return spies;
}
function expectNoLearning(spies: ReturnType<typeof learning>) {
  expect(spies.consolidate).not.toHaveBeenCalled();
  expect(spies.tasks).not.toHaveBeenCalled();
  expect(spies.business).not.toHaveBeenCalled();
}

describe('веб-ход под шлагбаумом выката релея', () => {
  it('W1: 503, потом поток — ответ доходит, ход тарифицируется как обычный', async () => {
    const { svc, calls } = makeServiceWithPgCalls();
    svc.relayDrainDelaysMs = [0];
    const up = stream();
    const t = turn(svc, 'привет', [err503(), up]);
    await settle();
    up.push(DELTA); up.push(DONE); up.push(null);
    await t.done;
    await settle();

    expect(post).toHaveBeenCalledTimes(2);
    expect(sid(1)).toBe(sid(0));
    expect(ends(t.res)[0].content).toContain('ответ');
    expect(tokenInserts(calls).length).toBe(1);
  });

  it('W2: бюджет исчерпан — заглушка «обновляется» на языке человека, без списания', async () => {
    const { svc, calls } = makeServiceWithPgCalls();
    svc.relayDrainDelaysMs = [0];
    const track = jest.fn();
    (svc as any).events = { track };
    const learn = learning(svc);
    const t = turn(svc, 'hello', [err503(), err503()], 'en');
    await t.done;
    await settle();

    const stub = chatFailureText('relayUpdating', 'en');
    expect(items(t.res)).toEqual([stub]);
    expect(ends(t.res)).toEqual([expect.objectContaining({ type: 'end', content: stub, reason: 'relay_draining' })]);
    expect(track).toHaveBeenCalledWith('chat_quality', expect.objectContaining({
      props: expect.objectContaining({ failed: true, fail_reason: 'relay_draining' }),
    }));
    expect(tokenInserts(calls)).toEqual([]);
    expect(savedStrings(calls)).toContain(stub);
    // Заглушка — не разговор: профиль, задачи и карточка бизнеса не учатся.
    expectNoLearning(learn);
  });

  it('W3: новое сообщение, пока ход ждёт, — несёт его текст, ждущий сдаётся молча', async () => {
    const { svc, calls } = makeServiceWithPgCalls();
    let wake: () => void = () => {};
    svc.relayDrainDelaysMs = [1000];
    svc.relayDrainSleep = () => new Promise<void>((r) => { wake = () => r(); });
    const track = jest.fn();
    (svc as any).events = { track };

    const a = turn(svc, 'первое', [err503()]);
    await settle();
    const upB = stream();
    const b = turn(svc, 'второе', [upB]);
    upB.push(DELTA);
    await settle();

    expect(msg(1)).toContain('не дошло');
    expect(msg(1)).toContain('первое');
    expect(msg(1)).toContain('второе');
    expect(msg(1)).not.toContain(NOTE);
    expect(sid(1)).toBe(sid(0));

    wake();
    await a.done;
    await settle();
    expect(ends(a.res)).toEqual([expect.objectContaining({ type: 'end', content: '', reason: 'superseded' })]);
    expect(items(a.res)).toEqual([]);
    // Своя метка: перебитый под шлагбаумом — не пустой ответ модели.
    expect(track).toHaveBeenCalledWith('chat_quality', expect.objectContaining({
      props: expect.objectContaining({ failed: true, fail_reason: 'relay_superseded' }),
    }));

    upB.push(DONE); upB.push(null);
    await b.done;
    await settle();
    const saved = savedStrings(calls).join('\n');
    expect(saved).not.toContain('обновляется');
    expect(saved).not.toContain('Ответ не пришёл');
  });

  it('W4: повтор self-heal тоже ждёт релей, а не глотает 503', async () => {
    // setImmediate/nextTick настоящие — см. T2 в chat.relay-running.spec.ts.
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    const { svc } = makeServiceWithPgCalls();
    svc.relayDrainDelaysMs = [0];
    const empty = stream();
    const retry = stream();
    const t = turn(svc, 'привет', [empty, err503(), retry]);
    await settle();
    empty.push(null); // пустой поток — self-heal ждёт 800 мс и повторяет
    await settle();
    jest.advanceTimersByTime(800);
    await settle();

    expect(post).toHaveBeenCalledTimes(3);
    retry.push(DELTA); retry.push(DONE); retry.push(null);
    await t.done;
    expect(ends(t.res)[0].content).toContain('ответ');
  });

  it('W5: повтор self-heal не дождался релея — заглушка «обновляется», без списания', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    const { svc, calls } = makeServiceWithPgCalls();
    svc.relayDrainDelaysMs = [0];
    const empty = stream();
    const t = turn(svc, 'привет', [empty, err503(), err503()]);
    await settle();
    empty.push(null); // пустой поток — self-heal ждёт 800 мс и повторяет
    await settle();
    jest.advanceTimersByTime(800);
    await t.done;
    await settle();

    const stub = chatFailureText('relayUpdating', 'ru');
    expect(post).toHaveBeenCalledTimes(3);
    expect(items(t.res)).toEqual([stub]);
    expect(ends(t.res)).toEqual([expect.objectContaining({ type: 'end', content: stub, reason: 'relay_draining' })]);
    expect(tokenInserts(calls)).toEqual([]);
  });

  it('W7: бюджет исчерпан — карточку, заведённую за время ожидания другим ходом, не забирает', async () => {
    const { svc, calls } = makeServiceWithPgCalls();
    const learn = learning(svc);
    // Посреди ожидания другой ход того же человека заводит карточку продукта.
    // takeForTurn, как настоящий, по запасному пути отдаёт всё, что заведено
    // не раньше since.
    let midTs = 0;
    const takeForTurn = jest.fn(async (_u: string, _turn: string | null, since: Date) =>
      (midTs > 0 && since.getTime() <= midTs ? [{ id: 'card-other', kind: 'create_bot', payload: {} }] : []));
    (svc as any).productActions = { takeForTurn };
    const pause = () => new Promise<void>((r) => setTimeout(r, 5));
    svc.relayDrainDelaysMs = [1000];
    svc.relayDrainSleep = async () => { await pause(); midTs = Date.now(); await pause(); };

    const t = turn(svc, 'привет', [err503(), err503()]);
    await t.done;
    await settle();

    const stub = chatFailureText('relayUpdating', 'ru');
    expect(midTs).toBeGreaterThan(0);
    expect(takeForTurn).toHaveBeenCalled();
    expect(items(t.res)).toEqual([stub]);
    expect(ends(t.res)).toEqual([expect.objectContaining({ type: 'end', content: stub, reason: 'relay_draining' })]);
    const saved = savedStrings(calls).join('\n');
    expect(saved).toContain(stub);
    expect(saved).not.toContain('card-other');
    expect(tokenInserts(calls)).toEqual([]);
    expectNoLearning(learn);
  });
});
