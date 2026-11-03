import { Readable } from 'stream';
import axios from 'axios';
import { ChatService } from './chat.service';
import { relaySessionKey } from './relay-session';
import { RelaySessionBusyError } from './relay-session-busy';
import { resolveAnswerProvider } from './answer-provider';

jest.mock('axios');
jest.mock('../common/telegram-alert', () => ({ sendTelegramAlert: jest.fn(async () => {}) }));
// Только resolveAnswerProvider подменяется (управляемая задержка для гонки
// ревью 03.11: await между проверкой занятости и openMark) — остальные
// экспорты (relayProviderFields и т.д.) остаются настоящими.
jest.mock('./answer-provider', () => {
  const actual = jest.requireActual('./answer-provider');
  return { ...actual, resolveAnswerProvider: jest.fn(actual.resolveAnswerProvider) };
});
const actualResolveAnswerProvider = jest.requireActual('./answer-provider').resolveAnswerProvider;

/**
 * agentReply (generateAgentReply/generateAgentReplyWithCharge) — путь рутин
 * (RoutinePushService.deliver) и «Пути» (TripService.generateFramingAsync).
 * Без sessionIdOverride он пишет в ТУ ЖЕ сессию релея, что и чат человека
 * (relaySessionKey — общая формула), и до этой правки вообще не был виден
 * ни relayRunning (строка о прерванном ходе человека), ни activeStreams
 * (deploy.sh), ни друг другу (два фоновых хода могли столкнуться в одной
 * сессии) — бэклог e777aa94.
 *
 * Харнес — как chat.relay-running.spec.ts: свой axios.post на управляемых
 * Readable-потоках SSE релея, общая очередь queue/post, settle() домётывает
 * микрозадачи между вызовом axios.post и обработчиками потока.
 */

const DELTA = 'data: ' + JSON.stringify({ type: 'delta', text: 'ответ' }) + '\n';
const DONE = 'data: ' + JSON.stringify({ type: 'done', costUsd: 0.1 }) + '\n';
const DONE_FAILED =
  'data: ' + JSON.stringify({ type: 'done', costUsd: 0.1, failed: true, failReason: 'preempted' }) + '\n';
const NOTE = 'тот ход прерван';

function makeService() {
  const pg = {
    query: jest.fn(async (sql: string) => {
      // Фоновые пути (generateAgentReply/agentReply) сами ищут ассистента в БД —
      // в отличие от streamUniversalAgent, которому агента передают параметром.
      if (/FROM agents WHERE/.test(sql)) {
        return { rows: [{ id: 14, name: '14', display_name: 'Ассистент', description: '', system_prompt: '' }] };
      }
      if (/AS spent/.test(sql)) return { rows: [{ spent: 0 }] };
      return { rows: [] };
    }),
  };
  const language = { resolveUserLanguage: jest.fn(async (_uid: string, hint?: string) => hint || 'ru') };
  return new ChatService(
    pg as any, null as any, null as any, null as any, language as any,
    undefined, undefined, undefined, undefined,
  );
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
afterEach(() => jest.clearAllMocks());

/** Значение поля multipart-формы, которой ушёл вызов axios.post под номером call. */
function field(call: any[], name: string): string {
  const parts: any[] = (call[1] as any)._streams || [];
  const idx = parts.findIndex((p) => typeof p === 'string' && new RegExp(`name="${name}"`).test(p));
  return String(parts[idx + 1] ?? '');
}
const msg = (i: number) => field(post.mock.calls[i], 'message');

async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

/** Фоновый ход (без sessionIdOverride) — делит сессию релея с человеком. */
function bgTurn(svc: ChatService, message = 'рутина', userId = 'u1', assistantId = '14') {
  const up = new Readable({ read() {} });
  queue.push(up);
  const call = svc.generateAgentReply(userId, assistantId, message);
  return { up, call };
}

/** Ход со своим sessionIdOverride — эфемерная сессия, занятость не проверяется. */
function overrideTurn(svc: ChatService, sessionId: string, message = 'план действий', userId = 'u1', assistantId = '14') {
  const up = new Readable({ read() {} });
  queue.push(up);
  const call = svc.generateAgentReply(userId, assistantId, message, sessionId);
  return { up, call };
}

/** Текстовый ход человека (streamUniversalAgent) той же пары. */
function textTurn(svc: ChatService, message: string, userId = 'u1', assistantId = '14') {
  const up = new Readable({ read() {} });
  queue.push(up);
  const res: any = { status: jest.fn(), setHeader: jest.fn(), write: jest.fn(() => true), end: jest.fn() };
  const done = (svc as any).streamUniversalAgent(
    userId, message, assistantId, assistantId, [], '', res, 'Ассистент', '', '', undefined, false, undefined,
  );
  return { up, done };
}

describe('фоновый ход (agentReply без sessionIdOverride) и занятая сессия человека', () => {
  it('идёт ход человека этой сессии — фоновый ход бросает RelaySessionBusyError, релей не вызывается', async () => {
    const svc = makeService();
    const sid = relaySessionKey('u1', '14', 'ru');
    const mark = svc.beginRelayRun(sid);
    try {
      await expect(svc.generateAgentReply('u1', '14', 'привет')).rejects.toThrow(RelaySessionBusyError);
      expect(post).not.toHaveBeenCalled();
    } finally {
      svc.endRelayRun(sid, mark);
    }
  });

  it('идёт другой фоновый ход этой сессии — второй фоновый ход тоже бросает RelaySessionBusyError', async () => {
    const svc = makeService();
    const first = bgTurn(svc, 'рутина 1');
    await settle();
    expect(post).toHaveBeenCalledTimes(1); // первый реально дошёл до релея

    await expect(svc.generateAgentReply('u1', '14', 'рутина 2')).rejects.toThrow(RelaySessionBusyError);
    expect(post).toHaveBeenCalledTimes(1); // второй — нет

    first.up.push(DELTA); first.up.push(DONE); first.up.push(null);
    await expect(first.call).resolves.toBe('ответ');
  });

  it('с sessionIdOverride занятость сессии человека не проверяется — ход уходит в релей', async () => {
    const svc = makeService();
    const sid = relaySessionKey('u1', '14', 'ru');
    const mark = svc.beginRelayRun(sid);
    try {
      const t = overrideTurn(svc, 'action_plan_x');
      await settle();
      expect(post).toHaveBeenCalledTimes(1);
      t.up.push(DELTA); t.up.push(DONE); t.up.push(null);
      await expect(t.call).resolves.toBe('ответ');
    } finally {
      svc.endRelayRun(sid, mark);
    }
  });

  it('фоновый ход идёт — текстовый ход человека той же сессии НЕ получает строку о прерывании', async () => {
    const svc = makeService();
    const bg = bgTurn(svc, 'рутина');
    await settle();
    expect(post).toHaveBeenCalledTimes(1);

    const t = textTurn(svc, 'ты тут?');
    t.up.push(DELTA);
    await settle();
    expect(post).toHaveBeenCalledTimes(2);
    expect(msg(1)).toContain('ты тут?');
    expect(msg(1)).not.toContain(NOTE);

    bg.up.push(DELTA); bg.up.push(DONE); bg.up.push(null);
    t.up.push(DONE); t.up.push(null);
    await Promise.all([bg.call, t.done]);
  });
});

describe('activeStreams считает фоновые и эфемерные ходы agentReply', () => {
  it('во время фонового хода — 1, после — 0', async () => {
    const svc = makeService();
    expect(svc.getActiveStreamCount()).toBe(0);
    const t = bgTurn(svc);
    await settle();
    expect(svc.getActiveStreamCount()).toBe(1);
    t.up.push(DELTA); t.up.push(DONE); t.up.push(null);
    await t.call;
    expect(svc.getActiveStreamCount()).toBe(0);
  });

  it('во время хода с sessionIdOverride — 1, после — 0', async () => {
    const svc = makeService();
    const t = overrideTurn(svc, 'action_plan_x');
    await settle();
    expect(svc.getActiveStreamCount()).toBe(1);
    t.up.push(DELTA); t.up.push(DONE); t.up.push(null);
    await t.call;
    expect(svc.getActiveStreamCount()).toBe(0);
  });

  it('возвращается к 0 даже при ошибке потока', async () => {
    const svc = makeService();
    const t = bgTurn(svc);
    await settle();
    expect(svc.getActiveStreamCount()).toBe(1);
    t.up.destroy(new Error('ECONNRESET'));
    await expect(t.call).rejects.toThrow();
    expect(svc.getActiveStreamCount()).toBe(0);
  });
});

describe('метка фонового хода снимается на любом исходе', () => {
  it('после успешного фонового хода — следующий фоновый ход той же сессии стартует', async () => {
    const svc = makeService();
    const first = bgTurn(svc, 'рутина 1');
    await settle();
    first.up.push(DELTA); first.up.push(DONE); first.up.push(null);
    await first.call;

    const second = bgTurn(svc, 'рутина 2');
    await settle();
    expect(post).toHaveBeenCalledTimes(2); // не бросило RelaySessionBusyError
    second.up.push(DELTA); second.up.push(DONE); second.up.push(null);
    await expect(second.call).resolves.toBe('ответ');
  });

  it('после ошибки потока — следующий фоновый ход той же сессии стартует', async () => {
    const svc = makeService();
    const first = bgTurn(svc, 'рутина 1');
    await settle();
    first.up.destroy(new Error('ECONNRESET'));
    await expect(first.call).rejects.toThrow();

    const second = bgTurn(svc, 'рутина 2');
    await settle();
    expect(post).toHaveBeenCalledTimes(2);
    second.up.push(DELTA); second.up.push(DONE); second.up.push(null);
    await expect(second.call).resolves.toBe('ответ');
  });

  it('после done.failed — следующий фоновый ход той же сессии стартует', async () => {
    const svc = makeService();
    const first = bgTurn(svc, 'рутина 1');
    await settle();
    first.up.push(DELTA); first.up.push(DONE_FAILED); first.up.push(null);
    await expect(first.call).resolves.toBe('');

    const second = bgTurn(svc, 'рутина 2');
    await settle();
    expect(post).toHaveBeenCalledTimes(2);
    second.up.push(DELTA); second.up.push(DONE); second.up.push(null);
    await expect(second.call).resolves.toBe('ответ');
  });
});

describe('done.failed — обрывок прерванного хода наружу не уходит', () => {
  it('generateAgentReply возвращает пустую строку', async () => {
    const svc = makeService();
    const t = bgTurn(svc);
    await settle();
    t.up.push(DELTA); t.up.push(DONE_FAILED); t.up.push(null);
    await expect(t.call).resolves.toBe('');
  });

  it('generateAgentReplyWithCharge отдаёт failed:true и необрезанный обрывок текста', async () => {
    const svc = makeService();
    const up = new Readable({ read() {} });
    queue.push(up);
    const call = svc.generateAgentReplyWithCharge('u1', '14', 'рутина');
    await settle();
    up.push(DELTA); up.push(DONE_FAILED); up.push(null);
    const result = await call;
    expect(result.failed).toBe(true);
    expect(result.text).toBe('ответ');
  });

  it('режим теста версии ассистента — по-прежнему бросает', async () => {
    const svc = makeService();
    const up = new Readable({ read() {} });
    queue.push(up);
    // sessionIdOverride — как в agent-versions.service.ts (testSession): своя
    // эфемерная сессия, занятость сессии человека тут ни при чём.
    const call = svc.generateAgentReplyWithCharge(
      'u1', '14', 'тест версии', 'agent_test_x', { testMode: true, testLanguage: 'ru' },
    );
    await settle();
    up.push(DELTA); up.push(DONE_FAILED); up.push(null);
    await expect(call).rejects.toThrow('Agent version test failed: relay reported failure');
  });
});

describe('гонка: проверка занятости и openMark разделены await (ревью 03.11)', () => {
  // До фикса: проверка занятости считала relaySid и смотрела в relayRunning/
  // backgroundRunning, но СРАЗУ после неё шёл await resolveAnswerProvider(…)
  // (запрос в PG через llmProvider) — и только ПОСЛЕ него ставился openMark.
  // В это окно успевал проскочить кто угодно: другой фоновый ход (RACE1) или
  // текстовый ход человека (RACE2). Финальная проверка должна стоять
  // ВПЛОТНУЮ к beginStream/openMark, без await между ними.
  afterEach(() => {
    (resolveAnswerProvider as jest.Mock).mockReset();
    (resolveAnswerProvider as jest.Mock).mockImplementation(actualResolveAnswerProvider);
  });

  it('RACE1: два фоновых хода одной сессии одновременно — в релей уходит только один, второй RelaySessionBusyError', async () => {
    const svc = makeService();
    const gates: Array<() => void> = [];
    (resolveAnswerProvider as jest.Mock).mockImplementation(
      () => new Promise((resolve) => { gates.push(() => resolve({ provider: 'claude', choice: null })); }),
    );

    const up = new Readable({ read() {} });
    queue.push(up); // только один реально дойдёт до axios.post и его разберёт

    const callA = svc.generateAgentReply('u1', '14', 'рутина A');
    const callB = svc.generateAgentReply('u1', '14', 'рутина B');
    await settle();
    // Оба дошли до одной и той же точки (await route()), не увидев друг
    // друга: ни один пока не поставил метку — RACE1 воспроизведён.
    expect(gates).toHaveLength(2);
    expect(post).not.toHaveBeenCalled();

    gates[0](); gates[1](); // отпускаем оба «одновременно»
    await settle();

    expect(post).toHaveBeenCalledTimes(1); // только один дошёл до релея

    up.push(DELTA); up.push(DONE); up.push(null);
    const results = await Promise.allSettled([callA, callB]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(RelaySessionBusyError);
  });

  it('RACE2: ход человека начинается, пока фоновый ждёт route() — фоновый бросает, релей для него не вызывается', async () => {
    const svc = makeService();
    let releaseRoute!: () => void;
    (resolveAnswerProvider as jest.Mock).mockImplementationOnce(
      () => new Promise((resolve) => { releaseRoute = () => resolve({ provider: 'claude', choice: null }); }),
    );

    const bg = bgTurn(svc, 'рутина');
    await settle();
    expect(typeof releaseRoute).toBe('function'); // фоновый дошёл до route() и встал там
    expect(post).not.toHaveBeenCalled();

    // Человек пишет той же паре, пока фоновый ждёт, — beginRelayRun (внутри
    // streamUniversalAgent) ставит метку в relayRunning раньше, чем фоновый
    // успевает дойти до своего openMark.
    const t = textTurn(svc, 'привет');
    t.up.push(DELTA);
    await settle();
    expect(post).toHaveBeenCalledTimes(1); // дошёл только текстовый ход человека

    releaseRoute(); // отпускаем фоновый — он должен увидеть занятую сессию
    await settle();

    // Сначала — быстрая и однозначная проверка (иначе под старым багом эта
    // проверка молчит, а следующая зависает: фоновый реально ушёл бы в
    // релей вторым вызовом post, но его апстрим в очереди не подготовлен).
    expect(post).toHaveBeenCalledTimes(1); // фоновый до релея так и не дошёл
    await expect(bg.call).rejects.toThrow(RelaySessionBusyError);

    t.up.push(DONE); t.up.push(null);
    await t.done;
  });

  it('axios.post отказал до потока (reject) — activeStreams возвращается к 0, следующий фоновый ход стартует', async () => {
    const svc = makeService();
    queue.push(new Error('ECONNREFUSED'));
    const first = svc.generateAgentReply('u1', '14', 'рутина 1');
    // Без settle() перед этой строкой: иначе первый дойдёт до отказа и
    // останется «висеть» отклонённым без обработчика несколько тиков —
    // Node пометит это как unhandledRejection ДО того, как мы его поймаем.
    await expect(first).rejects.toThrow('ECONNREFUSED');
    expect(svc.getActiveStreamCount()).toBe(0);

    const second = bgTurn(svc, 'рутина 2');
    await settle();
    expect(post).toHaveBeenCalledTimes(2); // второй реально дошёл — метка первого снята
    second.up.push(DELTA); second.up.push(DONE); second.up.push(null);
    await expect(second.call).resolves.toBe('ответ');
  });
});
