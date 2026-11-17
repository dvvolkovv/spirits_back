import { Readable } from 'stream';
import axios from 'axios';
import { ChatService } from './chat.service';
import { SEAT_TOKENS_PER_USD } from '../common/billing-rates';

jest.mock('axios');
jest.mock('../common/telegram-alert', () => ({ sendTelegramAlert: jest.fn(async () => {}) }));

/**
 * Списание за оборванный ход — за то, что успело прийти (решение владельца
 * 16–17.11.2026, бэклог 85841119; спек
 * docs/superpowers/specs/2026-11-17-partial-turn-billing-design.md).
 *
 * Правило — partial-billing.ts (своя таблица в partial-billing.spec.ts). Здесь —
 * проводка: одно решение на индикатор «N токенов» в `end` и на точку списания
 * (token_consumption_tasks), у веб-хода и у хода с файлом. Обвязка — как в
 * chat.relay-drain.spec.ts.
 */

const forUsd = (usd: number) => Math.max(1, Math.ceil(usd * SEAT_TOKENS_PER_USD));

/** Текст модели и служебная реплика релея разной длины — запасной путь по длине их различает. */
const MODEL = 'Нашёл три подходящих варианта, начинаю сравнивать цены';
const NOTICE = '\n\n_(связь с моделью прервалась, ответ оборван — повторите вопрос.)_';
const PREEMPTED = '\n\n_(ответ прерван: вы отправили новое сообщение, и ассистент переключился на него.)_';

const delta = (text: string) => ({ type: 'delta', text });
const notice = (text: string) => ({ type: 'notice', text });
/** done с расходом хода $0.50 по счёту CLI; usage нет — списание идёт source=cost. */
const done = (extra: Record<string, unknown> = {}) => ({ type: 'done', costUsd: 0.5, turnCostUsd: 0.5, ...extra });

function sse(events: any[]): Readable {
  const s = new Readable({ read() {} });
  process.nextTick(() => {
    for (const ev of events) s.push(`data: ${JSON.stringify(ev)}\n`);
    s.push(null);
  });
  return s;
}

function makeService() {
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
  const track = jest.fn();
  (svc as any).events = { track };
  const warn = jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => {});
  const log = jest.spyOn((svc as any).logger, 'log').mockImplementation(() => {});
  return { svc, calls, track, warn, log };
}

const queue: Readable[] = [];
const post = jest.fn(async (..._args: any[]) => {
  const next = queue.shift();
  if (!next) throw new Error('апстрим для этого вызова не подготовлен тестом');
  return { data: next };
});

beforeEach(() => {
  queue.length = 0;
  post.mockClear();
  (axios as any).default = { post };
  (axios as any).post = post;
});

async function settle() {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
}

function newRes(): any {
  return {
    status: jest.fn().mockReturnThis(), setHeader: jest.fn(), write: jest.fn(() => true),
    end: jest.fn(), json: jest.fn().mockReturnThis(), send: jest.fn().mockReturnThis(),
  };
}

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
/** Индикатор «N токенов» — usage.total единственного `end`. */
function shownTokens(res: any): number {
  const ends = writes(res).filter((w) => w.type === 'end');
  expect(ends).toHaveLength(1);
  return ends[0].usage.total;
}

type Calls = { sql: string; params: any[] }[];
const tokenRows = (calls: Calls) => calls.filter((c) => /INSERT INTO token_consumption_tasks/.test(c.sql));
/** Списанное: input + output строки token_consumption_tasks; undefined — строки нет. */
function charged(calls: Calls): number | undefined {
  const rows = tokenRows(calls);
  if (rows.length === 0) return undefined;
  expect(rows).toHaveLength(1);
  return Number(rows[0].params[3]) + Number(rows[0].params[4]);
}
/** Метаданные списания (ChargeFacts). */
const chargeMeta = (calls: Calls) => JSON.parse(String(tokenRows(calls)[0].params[5]));
/** tokens_used строки ответа ассистента в истории. */
function historyTokens(calls: Calls): number | undefined {
  const rows = calls.filter((c) => /INSERT INTO custom_chat_history/.test(c.sql) && /tokens_used/.test(c.sql));
  return rows.length ? Number(rows[rows.length - 1].params[3]) : undefined;
}
/** props итоговой записи chat_quality хода (у неё, в отличие от self-heal, есть ok). */
function quality(track: jest.Mock): any {
  const q = track.mock.calls.filter(([n, p]: any[]) => n === 'chat_quality' && p?.props && 'ok' in p.props);
  expect(q).toHaveLength(1);
  return q[0][1].props;
}
const lines = (spy: jest.SpyInstance) => spy.mock.calls.map((c) => String(c[0]));

async function webTurn(svc: ChatService, events: any[]) {
  queue.push(sse(events));
  const res = newRes();
  await (svc as any).streamUniversalAgent(
    'u1', 'сравни варианты', '7', '7', [], '', res, 'Роман', '', '', undefined, false, undefined,
  );
  await settle();
  return res;
}

describe('веб-ход: оборванный ход списывается за пришедшее', () => {
  it('P1: transient_after_partial с текстом — списание с пометкой, индикатор = списанному, partial_billed', async () => {
    const { svc, calls, track, warn } = makeService();
    const res = await webTurn(svc, [
      delta(MODEL), notice(NOTICE), done({ failed: true, failReason: 'transient_after_partial' }),
    ]);

    expect(charged(calls)).toBe(forUsd(0.5));
    expect(chargeMeta(calls)).toMatchObject({ partial: 'transient_after_partial', source: 'cost', turnCostUsd: 0.5 });
    expect(shownTokens(res)).toBe(forUsd(0.5));
    expect(historyTokens(calls)).toBe(forUsd(0.5));
    // Для мониторинга ход по-прежнему неудачный — и видно, что он списан.
    expect(quality(track)).toMatchObject({
      ok: false, failed: true, fail_reason: 'transient_after_partial', partial_billed: true,
    });
    expect(lines(warn)).toContainEqual(
      expect.stringContaining(`billing[partial:transient_after_partial:cost]: tokens=${forUsd(0.5)} `),
    );
  });

  it('P2: preempted до первого слова (одна служебная реплика) — без списания, индикатор 0', async () => {
    const { svc, calls, track, warn } = makeService();
    const res = await webTurn(svc, [notice(PREEMPTED), done({ failed: true, failReason: 'preempted' })]);

    expect(charged(calls)).toBeUndefined();
    expect(shownTokens(res)).toBe(0);
    expect(historyTokens(calls)).toBe(0);
    expect(quality(track).partial_billed).toBeUndefined();
    expect(lines(warn)).toContainEqual(expect.stringContaining('billing[skipped:preempted]'));
  });

  it('P3: сбой до ответа (cli_fatal) — без списания, даже если обрывок текста успел уйти', async () => {
    const { svc, calls, track } = makeService();
    const res = await webTurn(svc, [
      delta(MODEL), notice('\n\n_(модель недоступна)_'), done({ failed: true, failReason: 'cli_fatal' }),
    ]);

    expect(charged(calls)).toBeUndefined();
    expect(shownTokens(res)).toBe(0);
    expect(quality(track)).toMatchObject({ failed: true, fail_reason: 'cli_fatal' });
    expect(quality(track).partial_billed).toBeUndefined();
  });

  it('P4: max_turns без usage и стоимости — по длине текста модели, служебная реплика не в счёт', async () => {
    const { svc, calls, warn } = makeService();
    const res = await webTurn(svc, [
      delta(MODEL), notice(NOTICE), { type: 'done', failed: true, failReason: 'max_turns' },
    ]);

    // Множитель запасного пути — из сервиса (SDK_TEXT_MULTIPLIER), а не числом:
    // его смена не должна красить тест. С репликой длина была бы больше.
    const byLength = MODEL.length * (svc as any).SDK_TEXT_MULTIPLIER;
    expect(byLength).toBeGreaterThan(0);
    expect(charged(calls)).toBe(byLength);
    expect(shownTokens(res)).toBe(byLength);
    expect(chargeMeta(calls)).toMatchObject({ partial: 'max_turns', source: 'length' });
    expect(lines(warn)).toContainEqual(
      expect.stringContaining(`billing[partial:max_turns:length]: tokens=${byLength} `),
    );
  });

  it('P5: transient_after_write без текста, но с файлом — списание за файл', async () => {
    const { svc, calls, track } = makeService();
    const res = await webTurn(svc, [
      notice('_(связь с моделью прервалась после действия — проверьте результат, возможно всё прошло; при необходимости повторите)_'),
      done({
        failed: true, failReason: 'transient_after_write',
        outputFiles: [{ name: 'plan.pdf', url: '/files/u1_7_ru/plan.pdf' }],
      }),
    ]);

    expect(charged(calls)).toBe(forUsd(0.5));
    expect(chargeMeta(calls)).toMatchObject({ partial: 'transient_after_write' });
    expect(shownTokens(res)).toBe(forUsd(0.5));
    expect(quality(track).partial_billed).toBe(true);
  });

  it('P6: обычный ход — как раньше: списание без пометки, журнал billing[cost]', async () => {
    const { svc, calls, track, log } = makeService();
    const res = await webTurn(svc, [delta(MODEL), done()]);

    expect(charged(calls)).toBe(forUsd(0.5));
    expect(chargeMeta(calls).partial).toBeUndefined();
    expect(shownTokens(res)).toBe(forUsd(0.5));
    expect(quality(track)).toMatchObject({ ok: true, failed: false });
    expect(quality(track).partial_billed).toBeUndefined();
    expect(lines(log)).toContainEqual(expect.stringContaining(`billing[cost]: tokens=${forUsd(0.5)} `));
  });

  it('P7: transient_after_partial после одних пробельных delta — человек не увидел ни слова, без списания', async () => {
    // Релей шлёт и пустые text_delta («\n\n»), после них считает, что текст
    // пошёл, и при обрыве отдаёт transient_after_partial. «Пришедшим» считается
    // только видимый текст модели.
    const { svc, calls, warn } = makeService();
    const res = await webTurn(svc, [
      delta('\n\n'), notice(NOTICE), done({ failed: true, failReason: 'transient_after_partial' }),
    ]);

    expect(charged(calls)).toBeUndefined();
    expect(shownTokens(res)).toBe(0);
    expect(lines(warn)).toContainEqual(expect.stringContaining('billing[skipped:transient_after_partial]'));
  });

  it('P8: transient_after_write только с файлом и без расхода в done — строки списания с нулём нет', async () => {
    // Ноль в token_consumption_tasks планировщик превращает в минимум 1 токен
    // (TokenAccountingService), а индикатор и история показали бы 0.
    const { svc, calls } = makeService();
    const res = await webTurn(svc, [
      notice('_(связь с моделью прервалась после действия — проверьте результат, возможно всё прошло; при необходимости повторите)_'),
      {
        type: 'done', failed: true, failReason: 'transient_after_write',
        outputFiles: [{ name: 'plan.pdf', url: '/files/u1_7_ru/plan.pdf' }],
      },
    ]);

    expect(charged(calls)).toBeUndefined();
    expect(shownTokens(res)).toBe(0);
    expect(historyTokens(calls)).toBe(0);
  });

  it('P9: причина из списка, но текст — отказ CLI — без списания, в журнале cli_fatal_text', async () => {
    const { svc, calls, warn } = makeService();
    const res = await webTurn(svc, [
      delta("You've hit your session limit · resets 11:50am (UTC)"),
      notice(NOTICE),
      done({ failed: true, failReason: 'transient_after_partial' }),
    ]);

    expect(charged(calls)).toBeUndefined();
    expect(shownTokens(res)).toBe(0);
    expect(lines(warn)).toContainEqual(expect.stringContaining('billing[skipped:cli_fatal_text]'));
  });
});
