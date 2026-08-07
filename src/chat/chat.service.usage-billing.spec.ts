import { Readable } from 'stream';
import axios from 'axios';
import { ChatService } from './chat.service';
import { SEAT_TOKENS_PER_USD } from '../common/billing-rates';

/**
 * Ожидания выводятся из курса, а не зашиты числами: курс — бизнес-решение и
 * меняется через env, формула — код. Иначе смена курса красит тесты, ничего
 * не сообщая о правильности расчёта. Сам курс закреплён отдельным тестом ниже.
 */
const forUsd = (usd: number) => Math.max(1, Math.ceil(usd * SEAT_TOKENS_PER_USD));

jest.mock('axios');

/**
 * Биллинг SDK-пути (streamUniversalAgent → r.linkeon.io) по РЕАЛЬНОЙ стоимости хода.
 *
 * До этой правки списание считалось как `длина ответа × 2`. Замер 2026-08-07
 * показал, что такая формула тарифицирует ~9% расхода (только output) и не видит
 * оставшиеся ~90% (cache_write + cache_read), из-за чего тяжёлый юзер платил
 * столько же, сколько лёгкий.
 *
 * Теперь file-agent присылает `costUsd` в событии `done` (сумма total_cost_usd по
 * всем result-событиям Claude CLI — включая субагентов и внутренние ретраи), а
 * бэкенд переводит его в Linkeon-токены по курсу TOKENS_PER_USD.
 *
 * Тест намеренно подобран так, чтобы две формулы давали РАЗНЫЕ числа: если
 * usage-ветка отвалится и сработает откат, ассерты покраснеют, а не пройдут молча.
 */

function sseStream(events: any[]): Readable {
  const s = new Readable({ read() {} });
  process.nextTick(() => {
    for (const ev of events) s.push(`data: ${JSON.stringify(ev)}\n`);
    s.push(null);
  });
  return s;
}

interface Harness {
  pgCalls: { sql: string; params: any[] }[];
  run: () => Promise<void>;
}

/**
 * `costUsd: null` — релей старой сборки, поле вообще не приходит.
 * `usage` — сырой расход; если не задан, проверяется откат на costUsd.
 */
function makeHarness(opts: { answer: string; costUsd: number | null; usage?: Record<string, number> }): Harness {
  const pgCalls: { sql: string; params: any[] }[] = [];

  const pg = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      pgCalls.push({ sql, params });
      if (/FROM speech_clips/.test(sql)) return { rows: [] };
      if (/FROM video_jobs/.test(sql)) return { rows: [] };
      if (/FROM calendar_proposals/.test(sql)) return { rows: [] };
      if (/AS spent/.test(sql)) return { rows: [{ spent: 0 }] };
      return { rows: [] };
    }),
  };

  const language = { resolveUserLanguage: jest.fn(async () => 'ru') };

  const svc = new ChatService(
    pg as any,
    null as any, // neo4j
    null as any, // kling
    null as any, // tools
    null as any, // smmProducerTools
    null as any, // claudeAgent
    null as any, // claudeCli
    language as any, // language
    undefined, // tasksService
    undefined, // events
    undefined, // talerIdOauth
  );

  const done: any = { type: 'done' };
  if (opts.costUsd !== null) done.costUsd = opts.costUsd;
  if (opts.usage) done.usage = opts.usage;

  (axios.post as jest.Mock).mockResolvedValue({
    data: sseStream([{ type: 'delta', text: opts.answer }, done]),
  });

  const res: any = {
    status: jest.fn(),
    setHeader: jest.fn(),
    write: jest.fn(() => true),
    end: jest.fn(),
  };

  const run = async () => {
    await (svc as any).streamUniversalAgent(
      'u1', 'привет', '7', '7', [], '', res, 'Роман', '', '', undefined, false, undefined,
    );
    // persistResponse уходит в setImmediate — даём ему отработать.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  };

  return { pgCalls, run };
}

/**
 * Сколько РЕАЛЬНО списали. Берём из INSERT INTO token_consumption_tasks —
 * это и есть точка списания (persistResponse → addTokenTask), а не число,
 * показанное юзеру в событии `end`. Раньше эти две величины считались в
 * разных местах, и правка только показа выглядела бы рабочей.
 */
function chargedTokens(pgCalls: { sql: string; params: any[] }[]): number | undefined {
  const row = pgCalls.find((c) => /INSERT INTO token_consumption_tasks/.test(c.sql));
  if (!row) return undefined;
  const [, , , inputTokens, outputTokens] = row.params;
  return Number(inputTokens) + Number(outputTokens);
}

const ANSWER = 'x'.repeat(100); // старая формула: 100 × 2 = 200 токенов

describe('SDK-биллинг: взвешенные токены из сырого usage', () => {
  afterEach(() => jest.clearAllMocks());

  // Веса — отношения цен Anthropic к input: read 0.1, запись 5м 1.25,
  // запись 1ч 2, output 5. Единица переводится в доллары по $5/MTok (opus-5),
  // дальше в Linkeon-токены по курсу SEAT_TOKENS_PER_USD.
  const BASE_USAGE = {
    input: 1000, output: 1000, cacheRead: 100_000,
    cacheWrite5m: 10_000, cacheWrite1h: 0, webSearch: 0, webFetch: 0,
  };

  it('считает по взвешенной формуле, а не по costUsd', async () => {
    // 1000 + 0.1×100000 + 1.25×10000 + 5×1000 = 28 500 единиц → $0.1425.
    // costUsd намеренно завышен: если код возьмёт его вместо usage,
    // спишется втрое больше и тест это поймает.
    const h = makeHarness({ answer: ANSWER, costUsd: 1.0, usage: BASE_USAGE });
    await h.run();

    expect(chargedTokens(h.pgCalls)).toBe(forUsd(0.1425));
    expect(chargedTokens(h.pgCalls)).not.toBe(forUsd(1.0));
  });

  it('часовой кэш дороже пятиминутного — TTL нельзя схлопывать', async () => {
    const short = makeHarness({ answer: ANSWER, costUsd: 0, usage: BASE_USAGE });
    await short.run();

    const long = makeHarness({
      answer: ANSWER, costUsd: 0,
      usage: { ...BASE_USAGE, cacheWrite5m: 0, cacheWrite1h: 10_000 },
    });
    await long.run();

    // 1.25x против 2x при прочих равных: $0.1425 против $0.18.
    expect(chargedTokens(short.pgCalls)).toBe(forUsd(0.1425));
    expect(chargedTokens(long.pgCalls)).toBe(forUsd(0.18));
  });

  it('дешёвый кэш-ридер платит меньше, чем генератор текста', async () => {
    // Одинаковое число сырых токенов, но у одного это cache_read (0.1x),
    // у другого output (5x) — разница в цене ровно пятидесятикратная.
    const reader = makeHarness({
      answer: ANSWER, costUsd: 0,
      usage: { ...BASE_USAGE, input: 0, output: 0, cacheRead: 50_000, cacheWrite5m: 0 },
    });
    await reader.run();

    const writer = makeHarness({
      answer: ANSWER, costUsd: 0,
      usage: { ...BASE_USAGE, input: 0, output: 50_000, cacheRead: 0, cacheWrite5m: 0 },
    });
    await writer.run();

    expect(chargedTokens(writer.pgCalls)! / chargedTokens(reader.pgCalls)!).toBeCloseTo(50, 0);
  });

  it('без usage откатывается на costUsd', async () => {
    const h = makeHarness({ answer: ANSWER, costUsd: 0.5 });
    await h.run();

    expect(chargedTokens(h.pgCalls)).toBe(forUsd(0.5));
  });

  it('нулевой usage не считается за расход — уходит на costUsd', async () => {
    const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, webSearch: 0, webFetch: 0 };
    const h = makeHarness({ answer: ANSWER, costUsd: 0.5, usage: zero });
    await h.run();

    expect(chargedTokens(h.pgCalls)).toBe(forUsd(0.5));
  });
});

describe('SDK-биллинг: запасные пути', () => {
  const OLD_FORMULA = ANSWER.length * 2;

  afterEach(() => jest.clearAllMocks());

  it('списывает от costUsd по курсу, а не по длине ответа', async () => {
    // Сумма от costUsd заведомо не совпадает с 200 от старой формулы.
    const h = makeHarness({ answer: ANSWER, costUsd: 0.5 });
    await h.run();

    expect(chargedTokens(h.pgCalls)).toBe(forUsd(0.5));
    expect(chargedTokens(h.pgCalls)).not.toBe(OLD_FORMULA);
  });

  it('дорогой ход стоит дороже дешёвого при одинаковой длине ответа', async () => {
    // Ровно та регрессия, ради которой правка: старая формула давала обоим 200.
    const cheap = makeHarness({ answer: ANSWER, costUsd: 0.01 });
    await cheap.run();
    const cheapCharge = chargedTokens(cheap.pgCalls)!;

    const heavy = makeHarness({ answer: ANSWER, costUsd: 2.0 });
    await heavy.run();
    const heavyCharge = chargedTokens(heavy.pgCalls)!;

    expect(heavyCharge).toBeGreaterThan(cheapCharge * 100);
  });

  it('округляет вверх — копеечный ход не становится бесплатным', async () => {
    const h = makeHarness({ answer: ANSWER, costUsd: 0.0001 }); // 0.12 токена
    await h.run();

    expect(chargedTokens(h.pgCalls)).toBe(1);
  });

  it('без costUsd откатывается на длину текста, а не списывает ноль', async () => {
    // Релей старой сборки или обрыв до `done`. Ход обязан остаться платным.
    const h = makeHarness({ answer: ANSWER, costUsd: null });
    await h.run();

    expect(chargedTokens(h.pgCalls)).toBe(OLD_FORMULA);
  });

  it('costUsd = 0 трактуется как «стоимость неизвестна», а не как бесплатно', async () => {
    const h = makeHarness({ answer: ANSWER, costUsd: 0 });
    await h.run();

    expect(chargedTokens(h.pgCalls)).toBe(OLD_FORMULA);
  });
});

describe('курс сиденья', () => {
  it('зафиксирован на 3600 — бизнес-решение, а не случайное число', () => {
    // Выведен из экономики сиденья: пользовательская нагрузка ~$6 400/мес,
    // цель — выручка 3x стоимости подписки (~48 000 ₽/мес) при цене пакета
    // 1990 ₽ за 1M токенов. Обоснование целиком — в common/billing-rates.ts.
    //
    // Если этот тест покраснел — курс поменяли. Убедись, что это осознанно и
    // что вместе с ним пересчитаны пакеты и мигрированы балансы пользователей.
    expect(SEAT_TOKENS_PER_USD).toBe(3600);
  });
});
