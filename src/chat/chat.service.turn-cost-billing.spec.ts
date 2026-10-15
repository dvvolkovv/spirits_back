import { Readable } from 'stream';
import axios from 'axios';
import { ChatService, SdkUsageTotals } from './chat.service';
import { SEAT_TOKENS_PER_USD } from '../common/billing-rates';

jest.mock('axios');
jest.mock('../common/telegram-alert', () => ({ sendTelegramAlert: jest.fn(async () => {}) }));

/**
 * Ход веб-чата списывается по счёту CLI за ход, формула из usage — запасной
 * путь и страховка снизу. Спека: docs/superpowers/specs/2026-10-15-bill-by-cli-turn-cost-design.md.
 *
 * До 15.10.2026 списание было max(формула, счёт CLI). Формула переводит usage в
 * доллары по цене Opus 5 ($5 за миллион входных), а веб-чат с 23.09 крутится на
 * claude-opus-5-5, которую CLI считает дешевле. max() поэтому почти всегда брал
 * формулу и выставлял на 10–65% больше счёта CLI. Первый алерт роста стоимости
 * 15.10: формула $2.70, CLI $1.66.
 *
 * Ожидания выводятся из курса и из правила формулы, а не зашиты числами: курс —
 * бизнес-решение и меняется через env.
 */

const forUsd = (usd: number) => Math.max(1, Math.ceil(usd * SEAT_TOKENS_PER_USD));

/**
 * Формула из usage — как её задаёт правило: веса — отношения цен Anthropic к
 * input (read 0.1, запись 5м 1.25, запись 1ч 2, output 5), единица — по $5 за
 * миллион (Opus 5), веб-поиск — $10 за тысячу запросов. Порядок действий тот же,
 * что в сервисе: округление вверх в токены должно совпасть до единицы.
 */
const formulaUsd = (u: SdkUsageTotals) => {
  const weighted = u.input * 1 + u.cacheRead * 0.1 + u.cacheWrite5m * 1.25 + u.cacheWrite1h * 2 + u.output * 5;
  return (weighted * 5) / 1e6 + u.webSearch * 0.01;
};

const NO_USAGE: SdkUsageTotals = {
  input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, webSearch: 0, webFetch: 0,
};

/** Обычный ход: 1000 + 0.1×100 000 + 1.25×10 000 + 5×1000 = 28 500 единиц → $0.1425. */
const USAGE: SdkUsageTotals = { ...NO_USAGE, input: 1000, output: 1000, cacheRead: 100_000, cacheWrite5m: 10_000 };

/**
 * Ход из первого алерта роста стоимости (15.10.2026): формула $2.70, счёт CLI
 * $1.6628. В алерте была только сумма формулы, разложение по видам токенов
 * восстановлено так, чтобы её повторить: 0.1×5 000 000 + 5×8 000 = 540 000 единиц.
 */
const USAGE_1510: SdkUsageTotals = { ...NO_USAGE, cacheRead: 5_000_000, output: 8_000 };
const TURN_1510 = 1.6628;
/** total_cost_usd всей сессии (CLI 2.1.280) — в списание не идёт ни при каком раскладе. */
const SESSION_USD = 9.8731;

const ANSWER = 'x'.repeat(100);
const ENV = 'SDK_TURN_COST_FLOOR';

function makeService(o: { costGrowth?: { recordTurn: jest.Mock } } = {}) {
  const calls: { sql: string; params: any[] }[] = [];
  const pg = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      if (/FROM speech_clips|FROM video_jobs|FROM calendar_proposals/.test(sql)) return { rows: [] };
      if (/AS spent/.test(sql)) return { rows: [{ spent: 0 }] };
      if (/SELECT tokens FROM ai_profiles_consolidated/.test(sql)) return { rows: [{ tokens: 1_000_000 }] };
      return { rows: [] };
    }),
  };
  const language = { resolveUserLanguage: jest.fn(async () => 'ru') };
  const svc = new ChatService(
    pg as any, null as any, null as any, null as any,
    null as any, language as any, undefined, undefined, undefined, undefined,
  );
  // Сторож — последний @Optional-параметр; спеки собирают сервис позиционно.
  if (o.costGrowth) (svc as any).costGrowth = o.costGrowth;
  return { svc, calls };
}

type Charge = { tokens: number; usd: number; source: 'usage' | 'cost' | 'length'; note: string };

/** Расчёт списания — ровно тот метод, которым считают и списание, и индикатор `end`. */
const charge = (svc: ChatService, usage: SdkUsageTotals | null, turnCostUsd?: number | null, costUsd = SESSION_USD): Charge =>
  turnCostUsd === undefined
    ? (svc as any).computeSdkCharge(usage, costUsd, ANSWER)
    : (svc as any).computeSdkCharge(usage, costUsd, ANSWER, turnCostUsd);

function chargedTokens(calls: { sql: string; params: any[] }[]): number | undefined {
  const row = calls.find((c) => /INSERT INTO token_consumption_tasks/.test(c.sql));
  if (!row) return undefined;
  const [, , , inputTokens, outputTokens] = row.params;
  return Number(inputTokens) + Number(outputTokens);
}

function sseStream(events: any[]): Readable {
  const s = new Readable({ read() {} });
  process.nextTick(() => {
    for (const ev of events) s.push(`data: ${JSON.stringify(ev)}\n`);
    s.push(null);
  });
  return s;
}

let savedEnv: string | undefined;
beforeEach(() => {
  savedEnv = process.env[ENV];
  delete process.env[ENV];
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
  jest.clearAllMocks();
});

describe('ход веб-чата: списан счёт CLI, формула — запасной путь и страховка', () => {
  it('CLI дешевле формулы, но выше половины — списан счёт CLI (ход 15.10: $2.70 против $1.66)', () => {
    // Проверка самой подстановки: фикстура и правда даёт формулу из алерта.
    expect(formulaUsd(USAGE_1510)).toBeCloseTo(2.7, 6);
    const { svc } = makeService();

    const c = charge(svc, USAGE_1510, TURN_1510);

    expect(c.tokens).toBe(forUsd(TURN_1510));
    expect(c.usd).toBeCloseTo(TURN_1510, 10);
    expect(c.source).toBe('usage');
    expect(c.note).toContain('implied=$2.7000');
    expect(c.note).toContain('ход=$1.6628');
    expect(c.note).toContain('взято=ход');
    // Именно то, что было до правки: max() выставлял формулу.
    expect(c.tokens).not.toBe(forUsd(formulaUsd(USAGE_1510)));
  });

  it('CLI ниже половины формулы — списана половина формулы, в раскладе видно «пол»', () => {
    const { svc } = makeService();

    const c = charge(svc, USAGE, 0.05);

    expect(c.tokens).toBe(forUsd(0.5 * formulaUsd(USAGE)));
    expect(c.usd).toBeCloseTo(0.5 * formulaUsd(USAGE), 10);
    expect(c.note).toContain('взято=пол');
    // Счёт CLI в раскладе остаётся — по нему и видно, насколько сработала страховка.
    expect(c.note).toContain('ход=$0.0500');
  });

  it('CLI дороже формулы (субагенты, поиски) — списан счёт CLI (ход 13.10: $1.57 против $10.57)', () => {
    const { svc } = makeService();
    const usage = { ...NO_USAGE, cacheRead: 3_149_110 };

    const c = charge(svc, usage, 10.5674);

    expect(c.tokens).toBe(forUsd(10.5674));
    expect(c.note).toContain('взято=ход');
  });

  it.each([
    ['null — релей не прочитал стоимость', null],
    ['0 — стоимость неизвестна', 0],
    ['поле не пришло вовсе (релей старой сборки)', undefined],
  ])('стоимости хода нет (%s) — формула целиком', (_label, turn) => {
    const { svc } = makeService();

    const c = charge(svc, USAGE, turn as number | null | undefined);

    expect(c.tokens).toBe(forUsd(formulaUsd(USAGE)));
    expect(c.note).toContain('взято=usage');
    // Сумма всей сессии в расчёт не попадает и здесь.
    expect(c.tokens).not.toBe(forUsd(SESSION_USD));
  });

  it('поиски входят в формулу — страховка считается от формулы вместе с ними', () => {
    // 30 поисков = $0.30 сверху к $0.1425. Счёт CLI $0.10 выше половины
    // одних токенов ($0.071), но ниже половины формулы с поисками ($0.221).
    const { svc } = makeService();
    const usage = { ...USAGE, webSearch: 30 };

    const c = charge(svc, usage, 0.1);

    expect(c.tokens).toBe(forUsd(0.5 * formulaUsd(usage)));
    expect(c.note).toContain('взято=пол');
    expect(c.note).toContain('поиски=$0.3000');
    expect(c.note).toContain('поисков=30');
  });

  it('без usage и со стоимостью хода — как раньше, по ней', () => {
    const { svc } = makeService();

    const c = charge(svc, null, 0.3);

    expect(c.tokens).toBe(forUsd(0.3));
    expect(c.source).toBe('cost');
  });
});

describe('страховка из SDK_TURN_COST_FLOOR', () => {
  it('0.3: ход, упиравшийся в половину, теперь выше страховки — списан счёт CLI', () => {
    process.env[ENV] = '0.3';
    const { svc } = makeService();

    // $0.05 ниже половины формулы ($0.071), но выше 0.3 от неё ($0.043).
    const c = charge(svc, USAGE, 0.05);

    expect(c.tokens).toBe(forUsd(0.05));
    expect(c.note).toContain('взято=ход');
  });

  it('0.3: ход ниже и этой страховки — списано 0.3 формулы', () => {
    process.env[ENV] = '0.3';
    const { svc } = makeService();

    const c = charge(svc, USAGE, 0.01);

    expect(c.tokens).toBe(forUsd(0.3 * formulaUsd(USAGE)));
    expect(c.note).toContain('взято=пол');
  });

  it('1 — допустимая граница: не меньше формулы целиком, то есть прежний максимум', () => {
    process.env[ENV] = '1';
    const { svc } = makeService();

    const c = charge(svc, USAGE, 0.05);

    expect(c.tokens).toBe(forUsd(formulaUsd(USAGE)));
    expect(c.note).toContain('взято=пол');
  });

  it.each(['abc', '0', '-1', '1.5', '', 'Infinity'])('бессмысленное значение «%s» — 0.5', (raw) => {
    process.env[ENV] = raw;
    const { svc } = makeService();

    const c = charge(svc, USAGE, 0.05);

    expect(c.tokens).toBe(forUsd(0.5 * formulaUsd(USAGE)));
    expect(c.note).toContain('взято=пол');
  });
});

/**
 * Сквозь обе точки списания веб-чата: индикатор в `end`, строка списания и
 * сторож роста стоимости получают одно и то же число — счёт CLI.
 */
describe('ход 15.10 сквозь точки списания', () => {
  it('обычный ход: индикатор, списание и сторож — по счёту CLI', async () => {
    const costGrowth = { recordTurn: jest.fn(async () => {}) };
    const { svc, calls } = makeService({ costGrowth });
    (axios.post as jest.Mock).mockResolvedValueOnce({
      data: sseStream([
        { type: 'delta', text: ANSWER },
        { type: 'done', costUsd: SESSION_USD, usage: USAGE_1510, turnCostUsd: TURN_1510 },
      ]),
    });
    const written: any[] = [];
    const res: any = {
      status: jest.fn(), setHeader: jest.fn(), end: jest.fn(),
      write: jest.fn((s: string) => { try { written.push(JSON.parse(s)); } catch {} return true; }),
    };

    await (svc as any).streamUniversalAgent(
      'u1', 'привет', '7', '7', [], '', res, 'Роман', '', '', undefined, false, undefined,
    );
    for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));

    expect(chargedTokens(calls)).toBe(forUsd(TURN_1510));
    const end = written.find((w) => w.type === 'end');
    expect(end.usage.total).toBe(chargedTokens(calls));
    expect(costGrowth.recordTurn).toHaveBeenCalledTimes(1);
    const [, turn] = costGrowth.recordTurn.mock.calls[0] as any[];
    expect(turn.tokens).toBe(forUsd(TURN_1510));
    expect(turn.usd).toBeCloseTo(TURN_1510, 10);
    expect(turn.note).toContain('взято=ход');
  });

  it('ход с файлами: списание и сторож — по счёту CLI', async () => {
    const costGrowth = { recordTurn: jest.fn(async () => {}) };
    const { svc, calls } = makeService({ costGrowth });

    const charged = await svc.persistUploadTurn({
      userId: 'u1', assistantId: '12', userMsg: '📎 scan.jpg\nпереведи', assistantMsg: 'Перевод готов.',
      usage: USAGE_1510, costUsd: SESSION_USD, turnCostUsd: TURN_1510, durationMs: 1000,
    });

    expect(charged).toBe(forUsd(TURN_1510));
    expect(chargedTokens(calls)).toBe(forUsd(TURN_1510));
    const [, turn] = costGrowth.recordTurn.mock.calls[0] as any[];
    expect(turn.note).toContain('взято=ход');
  });
});
