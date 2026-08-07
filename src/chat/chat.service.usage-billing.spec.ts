import { Readable } from 'stream';
import axios from 'axios';
import { ChatService } from './chat.service';

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

/** `costUsd: null` — релей старой сборки, поле вообще не приходит. */
function makeHarness(opts: { answer: string; costUsd: number | null }): Harness {
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

describe('SDK-биллинг по реальному usage', () => {
  const OLD_FORMULA = ANSWER.length * 2;

  afterEach(() => jest.clearAllMocks());

  it('списывает от costUsd по курсу, а не по длине ответа', async () => {
    // 0.5 × 1200 = 600 — заведомо не совпадает с 200 от старой формулы.
    const h = makeHarness({ answer: ANSWER, costUsd: 0.5 });
    await h.run();

    expect(chargedTokens(h.pgCalls)).toBe(600);
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
