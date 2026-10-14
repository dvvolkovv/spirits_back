import { Readable } from 'stream';
import axios from 'axios';
import { ChatService, SdkUsageTotals } from './chat.service';
import { SEAT_TOKENS_PER_USD } from '../common/billing-rates';

jest.mock('axios');
jest.mock('../common/telegram-alert', () => ({ sendTelegramAlert: jest.fn(async () => {}) }));

/**
 * Сторож «стоимость растёт с каждым ответом» подключён к веб-чату — к обеим
 * точкам списания: обычному ходу (streamUniversalAgent) и ходу с файлами
 * (persistUploadTurn). Спека: docs/superpowers/specs/2026-10-14-cost-growth-alert-design.md.
 *
 * 14.10.2026 каждый следующий ответ длинной сессии стоил дороже предыдущего, и
 * ни один алерт этого не видел. Сторож смотрит на СПИСАННОЕ — поэтому здесь
 * проверяется, что в него уходит ровно то число, что легло в списание, а не
 * «какая-то» стоимость хода.
 *
 * Ожидания выводятся из курса SEAT_TOKENS_PER_USD, а не зашиты числами: смена
 * курса не должна красить тест, ничего не сказав о проводке.
 */

const forUsd = (usd: number) => Math.max(1, Math.ceil(usd * SEAT_TOKENS_PER_USD));

const BALANCE = 743_495;

/** Взвешенный usage на $0.50: 0.1×1_000_000 + 5×0 = 100 000 единиц × $5/MTok. */
const USAGE_HALF_DOLLAR: SdkUsageTotals = {
  input: 0, output: 0, cacheRead: 1_000_000,
  cacheWrite5m: 0, cacheWrite1h: 0, webSearch: 0, webFetch: 0,
};

function sseStream(events: any[]): Readable {
  const s = new Readable({ read() {} });
  process.nextTick(() => {
    for (const ev of events) s.push(`data: ${JSON.stringify(ev)}\n`);
    s.push(null);
  });
  return s;
}

function makeService(costGrowth: { recordTurn: jest.Mock }) {
  const calls: { sql: string; params: any[] }[] = [];
  const pg = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      if (/FROM speech_clips|FROM video_jobs|FROM calendar_proposals/.test(sql)) return { rows: [] };
      if (/AS spent/.test(sql)) return { rows: [{ spent: 0 }] };
      if (/SELECT tokens FROM ai_profiles_consolidated/.test(sql)) return { rows: [{ tokens: BALANCE }] };
      return { rows: [] };
    }),
  };
  const language = { resolveUserLanguage: jest.fn(async () => 'ru') };
  const svc = new ChatService(
    pg as any, null as any, null as any, null as any,
    null as any, language as any, undefined, undefined, undefined, undefined,
  );
  // Сторож — последний @Optional-параметр; спеки собирают сервис позиционно,
  // поэтому подставляем его после сборки.
  (svc as any).costGrowth = costGrowth;
  return { svc, calls };
}

/** Обычный ход чата целиком: релей отдаёт поток, сервис его сохраняет и списывает. */
async function runTurn(svc: ChatService, events: any[]) {
  (axios.post as jest.Mock).mockResolvedValueOnce({ data: sseStream(events) });
  const res: any = { status: jest.fn(), setHeader: jest.fn(), write: jest.fn(() => true), end: jest.fn() };
  await (svc as any).streamUniversalAgent(
    'u1', 'привет', '7', '7', [], '', res, 'Роман', '', '', undefined, false, undefined,
  );
  // Персист хода уходит в setImmediate — даём ему добежать.
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
}

const billingRow = (calls: { sql: string; params: any[] }[]) =>
  calls.find((c) => /INSERT INTO token_consumption_tasks/.test(c.sql));

describe('сторож роста стоимости: веб-чат', () => {
  afterEach(() => jest.clearAllMocks());

  it('обычный ход: пара «юзер + ассистент», списанные токены, стоимость и расклад', async () => {
    const costGrowth = { recordTurn: jest.fn(async () => {}) };
    const { svc, calls } = makeService(costGrowth);

    await runTurn(svc, [{ type: 'delta', text: 'ответ' }, { type: 'done', costUsd: 0.5 }]);

    expect(costGrowth.recordTurn).toHaveBeenCalledTimes(1);
    const [pair, turn, ctx] = costGrowth.recordTurn.mock.calls[0] as any[];
    // Имя ассистента — параметр streamUniversalAgent, в точке списания оно под
    // рукой: в алерте видно не только id, но и кто это.
    expect(pair).toEqual({ kind: 'chat', userId: 'u1', assistantId: '7', assistantName: 'Роман' });
    expect(turn.tokens).toBe(forUsd(0.5));
    // Ровно то, что ушло в списание: сторож смотрит на то же число, что видит юзер.
    const [, , , inputTokens, outputTokens] = billingRow(calls)!.params;
    expect(turn.tokens).toBe(Number(inputTokens) + Number(outputTokens));
    expect(turn.usd).toBeCloseTo(0.5, 6);
    expect(typeof turn.note).toBe('string');
    expect(turn.note).toContain('costUsd=$0.5000');
    // Баланс — геттер: в базу за ним ходят, только когда алерт сработал.
    expect(await ctx.balance()).toBe(BALANCE);
  });

  it('оборванный ход: в сторож уходит с нулём — сам сторож такой ход не пишет', async () => {
    // Точка вызова передаёт ход как есть (списано 0, стоимость 0), а отбрасывает
    // его CostGrowthService.recordTurn: ход ≤ 0 токенов в историю не попадает
    // (cost-growth.service.spec.ts). Если фильтр переедет в точку вызова — здесь
    // станет not.toHaveBeenCalled(). Главное — ни при каком раскладе не
    // charge.tokens: невыставленный ход не должен дорожать в глазах сторожа.
    const costGrowth = { recordTurn: jest.fn(async () => {}) };
    const { svc, calls } = makeService(costGrowth);

    await runTurn(svc, [
      { type: 'delta', text: 'частичный текст' },
      { type: 'notice', text: '_(связь с моделью прервалась)_' },
      { type: 'done', costUsd: 0.5, failed: true, failReason: 'transient_after_partial' },
    ]);

    expect(billingRow(calls)).toBeUndefined();
    expect(costGrowth.recordTurn.mock.calls.map((c: any[]) => c[1].tokens)).toEqual([0]);
    expect(costGrowth.recordTurn.mock.calls.map((c: any[]) => c[1].usd)).toEqual([0]);
  });

  it('сторож завис — ход всё равно сохранён и списан: его не ждут', async () => {
    const costGrowth = { recordTurn: jest.fn(() => new Promise<void>(() => {})) };
    const { svc, calls } = makeService(costGrowth);

    await runTurn(svc, [{ type: 'delta', text: 'ответ' }, { type: 'done', costUsd: 0.5 }]);

    expect(costGrowth.recordTurn).toHaveBeenCalledTimes(1);
    expect(billingRow(calls)).toBeDefined();
  });

  it('ход с файлами (persistUploadTurn): пара «юзер + ассистент» и списанное', async () => {
    const costGrowth = { recordTurn: jest.fn(async () => {}) };
    const { svc, calls } = makeService(costGrowth);

    const charged = await svc.persistUploadTurn({
      userId: 'u1', assistantId: '12', userMsg: '📎 scan.jpg\nпереведи', assistantMsg: 'Перевод готов.',
      usage: USAGE_HALF_DOLLAR, costUsd: 0.5, durationMs: 1000,
    });

    expect(costGrowth.recordTurn).toHaveBeenCalledTimes(1);
    const [pair, turn, ctx] = costGrowth.recordTurn.mock.calls[0] as any[];
    expect(pair).toEqual({ kind: 'chat', userId: 'u1', assistantId: '12' });
    expect(turn.tokens).toBeGreaterThan(0);
    expect(turn.tokens).toBe(charged);
    expect(turn.tokens).toBe(forUsd(0.5));
    const [, , , inputTokens, outputTokens] = billingRow(calls)!.params;
    expect(turn.tokens).toBe(Number(inputTokens) + Number(outputTokens));
    expect(turn.usd).toBeCloseTo(0.5, 6);
    expect(typeof turn.note).toBe('string');
    expect(await ctx.balance()).toBe(BALANCE);
  });
});
