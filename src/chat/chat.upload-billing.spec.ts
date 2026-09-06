import { Readable } from 'stream';
import axios from 'axios';
import { ChatService, SdkUsageTotals } from './chat.service';
import { ChatController } from './chat.controller';
import { SEAT_TOKENS_PER_USD } from '../common/billing-rates';

jest.mock('axios');
jest.mock('../common/telegram-alert', () => ({ sendTelegramAlert: jest.fn(async () => {}) }));

/**
 * Биллинг хода с ВЛОЖЕНИЯМИ (`POST /webhook/agent/upload-and-chat`).
 *
 * Инцидент 06.09.2026, пользователь 79096549517: загрузил 7 фото медицинских
 * документов, ассистент их распознал, перевёл на английский и собрал DOCX+PDF.
 * Списано — ноль. В `token_consumption_tasks` строки нет вовсе, в pm2-логе нет
 * даже `billing[skipped]`. Пользователь при этом видел «2073 токена»: обработчик
 * загрузки слал в событии `end` ДЛИНУ ОТВЕТА В СИМВОЛАХ и её же клал в
 * `custom_chat_history.tokens_used`.
 *
 * Причина: `uploadAndChat` — вторая, самостоятельная реализация стрима. Она
 * разбирала событие `done` только ради `outputFiles`, а `usage` и `costUsd`,
 * которые релей присылает с 07.08.2026, молча выбрасывала. По транскриптам
 * релея те два хода стоили $2.97 и $2.83 — около 26 000 токенов по курсу
 * платформы.
 *
 * Тест проверяет ТОЧКУ СПИСАНИЯ (`INSERT INTO token_consumption_tasks`), а не
 * то, что показано пользователю: это разные места, и правка одного показа уже
 * однажды выглядела рабочей, не меняя ни копейки.
 */

const forUsd = (usd: number) => Math.max(1, Math.ceil(usd * SEAT_TOKENS_PER_USD));

/** Взвешенный usage на $0.50: 0.1×1_000_000 + 5×0 = 100 000 единиц × $5/MTok. */
const USAGE_HALF_DOLLAR: SdkUsageTotals = {
  input: 0, output: 0, cacheRead: 1_000_000,
  cacheWrite5m: 0, cacheWrite1h: 0, webSearch: 0, webFetch: 0,
};

/** Ответ намеренно короткий: старая формула дала бы число, не похожее ни на что. */
const ANSWER = 'Перевод готов.';

function sseStream(events: any[]): Readable {
  const s = new Readable({ read() {} });
  process.nextTick(() => {
    for (const ev of events) s.push(`data: ${JSON.stringify(ev)}\n`);
    s.push(null);
  });
  return s;
}

interface Pg {
  query: jest.Mock;
  calls: { sql: string; params: any[] }[];
}

function makePg(balance = 1_000_000): Pg {
  const calls: { sql: string; params: any[] }[] = [];
  const query = jest.fn(async (sql: string, params: any[] = []) => {
    calls.push({ sql, params });
    if (/SELECT tokens FROM ai_profiles_consolidated/.test(sql)) return { rows: [{ tokens: balance }] };
    return { rows: [] };
  });
  return { query, calls } as Pg;
}

function makeService(pg: Pg): ChatService {
  const language = { resolveUserLanguage: jest.fn(async () => 'ru') };
  return new ChatService(
    pg as any, null as any, null as any, null as any, null as any, null as any,
    null as any, language as any, undefined, undefined, undefined, undefined,
  );
}

/**
 * Сколько РЕАЛЬНО списали: сумма input+output из INSERT INTO
 * token_consumption_tasks. `undefined` — строки нет, ход бесплатный.
 */
function chargedTokens(calls: { sql: string; params: any[] }[]): number | undefined {
  const row = calls.find((c) => /INSERT INTO token_consumption_tasks/.test(c.sql));
  if (!row) return undefined;
  const [, , , inputTokens, outputTokens] = row.params;
  return Number(inputTokens) + Number(outputTokens);
}

/** Что записали в историю как стоимость хода. */
function historyTokens(calls: { sql: string; params: any[] }[]): number | undefined {
  const row = calls.find((c) => /INSERT INTO custom_chat_history/.test(c.sql) && /tokens_used/.test(c.sql));
  return row ? Number(row.params[3]) : undefined;
}

describe('persistUploadTurn: ход с вложениями тарифицируется', () => {
  afterEach(() => jest.clearAllMocks());

  it('списывает по взвешенному usage, а не по длине ответа', async () => {
    const pg = makePg();
    const svc = makeService(pg);

    await svc.persistUploadTurn({
      userId: 'u1', assistantId: '12',
      userMsg: '📎 scan.jpg\nпереведи',
      assistantMsg: ANSWER,
      usage: USAGE_HALF_DOLLAR, costUsd: 0.5, durationMs: 140_000,
    });

    expect(chargedTokens(pg.calls)).toBe(forUsd(0.5));
    // Ровно то, что делал сломанный путь: длина ответа как «токены».
    expect(chargedTokens(pg.calls)).not.toBe(ANSWER.length);
  });

  it('в историю пишет списанное, а не число символов', async () => {
    const pg = makePg();
    const svc = makeService(pg);

    await svc.persistUploadTurn({
      userId: 'u1', assistantId: '12', userMsg: '📎 scan.jpg', assistantMsg: ANSWER,
      usage: USAGE_HALF_DOLLAR, costUsd: 0.5, durationMs: 1000,
    });

    expect(historyTokens(pg.calls)).toBe(forUsd(0.5));
    expect(historyTokens(pg.calls)).not.toBe(ANSWER.length);
  });

  it('без usage откатывается на costUsd', async () => {
    const pg = makePg();
    const svc = makeService(pg);

    await svc.persistUploadTurn({
      userId: 'u1', assistantId: '12', userMsg: '📎 scan.jpg', assistantMsg: ANSWER,
      usage: null, costUsd: 1.25, durationMs: 1000,
    });

    expect(chargedTokens(pg.calls)).toBe(forUsd(1.25));
  });

  it('прерванный ход не тарифицируется — обещание в тексте держится', async () => {
    // Релей дописывает «Токены за прерванный ход не списаны» и шлёт failed:true.
    const pg = makePg();
    const svc = makeService(pg);

    await svc.persistUploadTurn({
      userId: 'u1', assistantId: '12', userMsg: '📎 scan.jpg', assistantMsg: ANSWER,
      usage: USAGE_HALF_DOLLAR, costUsd: 0.5, durationMs: 1000,
      turnFailed: true, failReason: 'interrupted',
    });

    expect(chargedTokens(pg.calls)).toBeUndefined();
    // История всё равно сохраняется — разговор был настоящий.
    expect(historyTokens(pg.calls)).toBe(0);
  });

  it('отказ CLI, долетевший текстом ответа, бесплатен', async () => {
    const pg = makePg();
    const svc = makeService(pg);

    await svc.persistUploadTurn({
      userId: 'u1', assistantId: '12', userMsg: '📎 scan.jpg',
      assistantMsg: 'Not logged in · Please run /login',
      usage: USAGE_HALF_DOLLAR, costUsd: 0.5, durationMs: 1000,
    });

    expect(chargedTokens(pg.calls)).toBeUndefined();
  });
});

/**
 * Сквозная проверка контроллера. Дыра была именно на стыке: данные для
 * тарификации приходили, но между разбором `done` и сохранением терялись.
 * Сервисные тесты выше такую потерю не ловят — они получают usage на вход.
 */
describe('uploadAndChat: usage из события done доезжает до списания', () => {
  afterEach(() => jest.clearAllMocks());

  function makeReq(body: any = {}) {
    return {
      headers: { authorization: 'Bearer token' },
      files: [{ originalname: 'scan.jpg', buffer: Buffer.from('x'), mimetype: 'image/jpeg', size: 1 }],
      body: { message: 'переведи', assistantId: '12', ...body },
    } as any;
  }

  function makeRes() {
    const written: any[] = [];
    return {
      written,
      status: jest.fn().mockReturnThis(),
      setHeader: jest.fn(),
      write: jest.fn((s: string) => { try { written.push(JSON.parse(s)); } catch {} return true; }),
      end: jest.fn(),
      json: jest.fn().mockReturnThis(),
      send: jest.fn().mockReturnThis(),
    } as any;
  }

  function makeController(pg: Pg) {
    const svc = makeService(pg);
    const jwtSvc = { verify: jest.fn(() => ({ type: 'access', userId: 'u1' })) };
    return new ChatController(svc, jwtSvc as any, null as any, undefined);
  }

  async function run(pg: Pg, done: any, res = makeRes()) {
    const ctrl = makeController(pg);
    const post = jest.fn(async () => ({ data: sseStream([{ type: 'delta', text: ANSWER }, done]) }));
    (axios as any).default = { post };
    (axios as any).post = post;

    await ctrl.uploadAndChat(makeReq(), res);
    // persist уходит в setImmediate — даём ему отработать.
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    return res;
  }

  it('списывает стоимость хода, а не длину ответа', async () => {
    const pg = makePg();
    await run(pg, { type: 'done', costUsd: 0.5, usage: USAGE_HALF_DOLLAR });

    expect(chargedTokens(pg.calls)).toBe(forUsd(0.5));
  });

  it('показывает пользователю то же число, что списывает', async () => {
    const pg = makePg();
    const res = await run(pg, { type: 'done', costUsd: 0.5, usage: USAGE_HALF_DOLLAR });

    const end = res.written.find((w: any) => w.type === 'end');
    expect(end.usage.total).toBe(forUsd(0.5));
    expect(end.usage.total).toBe(chargedTokens(pg.calls));
  });

  it('на нулевом балансе не ходит в релей вовсе', async () => {
    const pg = makePg(0);
    const res = makeRes();
    const ctrl = makeController(pg);
    const post = jest.fn();
    (axios as any).default = { post };
    (axios as any).post = post;

    await ctrl.uploadAndChat(makeReq(), res);

    expect(post).not.toHaveBeenCalled();
    expect(chargedTokens(pg.calls)).toBeUndefined();
    const end = res.written.find((w: any) => w.type === 'end');
    expect(end.content).toMatch(/Недостаточно токенов/);
  });
});
