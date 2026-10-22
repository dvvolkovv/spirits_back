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
  /** Наружу — чтобы подсмотреть строку `billing[...]` в логе: по ней разбирают списания на проде. */
  svc: ChatService;
}

/**
 * `costUsd: null` — релей старой сборки, поле вообще не приходит.
 * `usage` — сырой расход; если не задан, проверяется откат на costUsd.
 * `turnCostUsd` — стоимость ЭТОГО хода по счёту CLI; не задан — релей старой сборки.
 */
function makeHarness(opts: {
  answer: string; costUsd: number | null; usage?: Record<string, number>; turnCostUsd?: number | null;
}): Harness {
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
    null as any, // tools
    null as any, // claudeCli
    language as any, // language
    undefined, // balanceCtx
    undefined, // tasksService
    undefined, // events
    undefined, // talerIdOauth
  );

  const done: any = { type: 'done' };
  if (opts.costUsd !== null) done.costUsd = opts.costUsd;
  if (opts.usage) done.usage = opts.usage;
  if (opts.turnCostUsd !== undefined) done.turnCostUsd = opts.turnCostUsd;

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

  return { pgCalls, run, svc };
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

  it('считает по взвешенной формуле, когда стоимость хода неизвестна', async () => {
    // 1000 + 0.1×100000 + 1.25×10000 + 5×1000 = 28 500 единиц → $0.1425.
    // costUsd = 0 убирает его из сравнения по максимуму, остаётся чистая
    // проверка весов. Приоритет между двумя источниками проверяется отдельно,
    // в блоке про субагентов.
    const h = makeHarness({ answer: ANSWER, costUsd: 0, usage: BASE_USAGE });
    await h.run();

    expect(chargedTokens(h.pgCalls)).toBe(forUsd(0.1425));
    expect(chargedTokens(h.pgCalls)).not.toBe(ANSWER.length * 2);
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
  it('зафиксирован на 7200 — бизнес-решение, а не случайное число', () => {
    // 20.10.2026: 4500 → 7200 по решению владельца («стоимость ответов
    // занижена»). С 15.10 ход списывается по счёту CLI в ценах claude-opus-5-5 —
    // это 0.63 от прежней формулы, и выручка с хода упала на треть без всякой
    // правки курса. 4500 / 0.63 ≈ 7140 → 7200. Обоснование целиком — в
    // common/billing-rates.ts.
    //
    // 17.08.2026: 3600 → 4500. Пакеты и балансы оба раза намеренно не тронуты —
    // курс действует только вперёд.
    //
    // Если этот тест покраснел — курс поменяли. Убедись, что это осознанно и
    // что оценка «≈ N сообщений» на витрине (spirits_front,
    // config/tokenPackages.ts) по-прежнему не ниже среднего хода: иначе
    // обещание переживёт курс.
    expect(SEAT_TOKENS_PER_USD).toBe(7200);
  });
});

/**
 * costUsd от релея — не стоимость хода.
 *
 * С Claude CLI 2.1.280 (на релее с 23.09.2026) total_cost_usd у возобновлённой
 * (--resume) сессии — накопленная стоимость ВСЕЙ сессии: CLI пишет в транскрипт
 * записи cost-state и при resume продолжает счёт с них. Списание по максимуму из
 * usage и costUsd брало эту сумму за каждый ход, и чем дольше жила сессия, тем
 * дороже становился каждый следующий ответ. Жалоба 14.10.2026: ход за $0.16
 * списан как $6.21 — 27 940 токенов вместо 734.
 */
describe('SDK-биллинг: накопленный costUsd релея не тарифицируется', () => {
  afterEach(() => jest.clearAllMocks());

  const USAGE = {
    input: 1000, output: 1000, cacheRead: 100_000,
    cacheWrite5m: 10_000, cacheWrite1h: 0, webSearch: 0, webFetch: 0,
  }; // = $0.1425 по весам

  it('ход из жалобы: списано по usage хода, а не по сумме всей сессии', async () => {
    // Настоящий ход 14.10.2026: 217 796 прочитано из кэша, 4 144 записано на
    // час, 506 сгенерировано → 32 601.6 единицы × $5/MTok = $0.163008.
    // Релей прислал costUsd = 6.2087 — сумму всех ходов сессии с 07.10.
    const h = makeHarness({
      answer: ANSWER, costUsd: 6.2087,
      usage: { input: 4, output: 506, cacheRead: 217_796, cacheWrite5m: 0, cacheWrite1h: 4_144, webSearch: 0, webFetch: 0 },
    });
    await h.run();

    expect(chargedTokens(h.pgCalls)).toBe(forUsd(0.163008));
    expect(chargedTokens(h.pgCalls)).not.toBe(forUsd(6.2087));
  });

  it('costUsd больше взвешенного — всё равно взвешенное', async () => {
    const h = makeHarness({ answer: ANSWER, costUsd: 0.5, usage: USAGE });
    await h.run();

    expect(chargedTokens(h.pgCalls)).toBe(forUsd(0.1425));
  });

  it('costUsd меньше взвешенного — взвешенное, как и раньше', async () => {
    const h = makeHarness({ answer: ANSWER, costUsd: 0.01, usage: USAGE });
    await h.run();

    expect(chargedTokens(h.pgCalls)).toBe(forUsd(0.1425));
  });

  it('веб-поиск в токенах не виден — $10 за тысячу запросов сверху', async () => {
    // Раньше эту плату приносил costUsd через максимум. Без него поиски
    // стали бы бесплатными.
    const h = makeHarness({ answer: ANSWER, costUsd: 0, usage: { ...USAGE, webSearch: 3 } });
    await h.run();

    expect(chargedTokens(h.pgCalls)).toBe(forUsd(0.1425 + 0.03));
  });
});

/**
 * Стоимость ЭТОГО хода по счёту CLI (`turnCostUsd`).
 *
 * Верхний usage видит только запросы основной модели. Мимо него проходят
 * субагенты и внутренние запросы инструментов: WebSearch и WebFetch CLI гоняет
 * через Haiku и платит за поиск. Ход 13.10.2026 с четырьмя субагентами и 192
 * поисками: usage — $1.57, счёт CLI за ход — $10.57. Релей вычитает из
 * total_cost_usd запись cost-state, с которой CLI продолжил сессию, и присылает
 * разницу.
 *
 * До 15.10.2026 она была нижней границей списания: max(формула, счёт CLI). С
 * 15.10 списывается она сама, формула — запасной путь, когда её нет, и
 * страховка снизу (0.15 формулы) от ошибки релея в вычитании. Подробно —
 * chat.service.turn-cost-billing.spec.ts.
 */
describe('SDK-биллинг: стоимость хода от релея', () => {
  afterEach(() => jest.clearAllMocks());

  const USAGE = {
    input: 1000, output: 1000, cacheRead: 100_000,
    cacheWrite5m: 10_000, cacheWrite1h: 0, webSearch: 0, webFetch: 0,
  }; // = $0.1425 по весам

  it('больше взвешенного — берётся она: субагенты и веб-инструменты в usage не видны', async () => {
    const h = makeHarness({ answer: ANSWER, costUsd: 11.0993, usage: USAGE, turnCostUsd: 0.5 });
    await h.run();

    expect(chargedTokens(h.pgCalls)).toBe(forUsd(0.5));
  });

  it('ход 13.10: $1.57 по usage основной модели, $10.57 по счёту CLI — списано $10.57', async () => {
    // 3 149 110 × 0.1 = 314 911 единиц — ровно столько показал лог прода.
    const h = makeHarness({
      answer: ANSWER, costUsd: 11.0993,
      usage: { input: 0, output: 0, cacheRead: 3_149_110, cacheWrite5m: 0, cacheWrite1h: 0, webSearch: 0, webFetch: 0 },
      turnCostUsd: 10.5674,
    });
    await h.run();

    expect(chargedTokens(h.pgCalls)).toBe(forUsd(10.5674));
  });

  // До 15.10.2026 здесь было «меньше взвешенного — взвешенное» (max). Веб-чат
  // на claude-opus-5-5, которую CLI считает дешевле формулы по $5/MTok, и max()
  // выставлял формулу всегда: в логе прода с 14.10 нет ни одного хода дороже
  // формулы. Теперь берётся счёт CLI, но не меньше 0.15 формулы.
  it('меньше взвешенного — берётся она', async () => {
    const h = makeHarness({ answer: ANSWER, costUsd: 0.05, usage: USAGE, turnCostUsd: 0.05 });
    const log = jest.spyOn((h.svc as any).logger, 'log');
    await h.run();

    expect(chargedTokens(h.pgCalls)).toBe(forUsd(0.05));
    expect(log.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith('billing['))).toContain('взято=ход');
  });

  it('ниже 0.15 взвешенного — 0.15 взвешенного: релей ошибся в вычитании, а не модель подешевела', async () => {
    const h = makeHarness({ answer: ANSWER, costUsd: 0.01, usage: USAGE, turnCostUsd: 0.01 });
    const log = jest.spyOn((h.svc as any).logger, 'log');
    await h.run();

    expect(chargedTokens(h.pgCalls)).toBe(forUsd(0.15 * 0.1425));
    expect(log.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith('billing['))).toContain('взято=пол');
  });

  it('null — релей не смог прочитать стоимость: только usage, сумма сессии не берётся', async () => {
    const h = makeHarness({ answer: ANSWER, costUsd: 6.2087, usage: USAGE, turnCostUsd: null });
    await h.run();

    expect(chargedTokens(h.pgCalls)).toBe(forUsd(0.1425));
  });

  it('попадает в метаданные списания — по ней видно, за что взяли больше usage', async () => {
    const h = makeHarness({ answer: ANSWER, costUsd: 11.0993, usage: USAGE, turnCostUsd: 0.5 });
    await h.run();

    const row = h.pgCalls.find((c) => /INSERT INTO token_consumption_tasks/.test(c.sql));
    expect(JSON.parse(row!.params[5])).toMatchObject({ turnCostUsd: 0.5 });
  });

  it('путь TG-бота и голоса (generateAgentReplyWithCharge) считает так же', async () => {
    const pg = {
      query: jest.fn(async (sql: string) =>
        /FROM agents/.test(sql) ? { rows: [{ id: 7, name: 'Роман', system_prompt: '' }] } : { rows: [] }),
    };
    const language = { resolveUserLanguage: jest.fn(async () => 'ru') };
    const svc = new ChatService(
      pg as any, null as any, null as any,
      null as any, language as any, undefined, undefined, undefined, undefined,
    );
    (axios.post as jest.Mock).mockResolvedValue({
      data: sseStream([
        { type: 'delta', text: ANSWER },
        { type: 'done', costUsd: 11.0993, usage: USAGE, turnCostUsd: 0.5 },
      ]),
    });

    const reply = await svc.generateAgentReplyWithCharge('u1', '7', 'привет');

    expect(reply.tokens).toBe(forUsd(0.5));
  });
});

/**
 * Ход обязан рассказать о себе в очередь списания.
 *
 * Сумму мы считаем правильно, но в token_transactions она уходила голой:
 * description = NULL, metadata = NULL. Разбор списания на 862 673 токена
 * (2026-08-10) свёлся к чтению pm2-логов и транскриптов релея — при том, что
 * стоимость хода, его длительность и источник расчёта известны ровно здесь.
 *
 * Метаданные едут через token_consumption_tasks.metadata, оттуда
 * TokenAccountingService переносит их в транзакцию (см. его spec).
 */
describe('SDK-биллинг: за что списали', () => {
  afterEach(() => jest.clearAllMocks());

  const taskMeta = (pgCalls: { sql: string; params: any[] }[]) => {
    const row = pgCalls.find((c) => /INSERT INTO token_consumption_tasks/.test(c.sql));
    const raw = row?.params[5];
    return raw ? JSON.parse(raw) : undefined;
  };

  it('кладёт в задачу стоимость хода и источник расчёта', async () => {
    const h = makeHarness({ answer: ANSWER, costUsd: 0.5 });
    await h.run();

    expect(taskMeta(h.pgCalls)).toMatchObject({ costUsd: 0.5, source: 'cost' });
  });

  it('различает источник расчёта — по нему видно, откуда взялась сумма', async () => {
    // Именно это поле объясняет ход 2026-08-10: source=usage при покрытии 2%
    // означает «сумма пришла от costUsd, потому что взвешенное её не видело».
    const h = makeHarness({
      answer: ANSWER, costUsd: 0.5,
      usage: { input: 1000, output: 1000, cacheRead: 100_000, cacheWrite5m: 10_000, cacheWrite1h: 0, webSearch: 0, webFetch: 0 },
    });
    await h.run();

    expect(taskMeta(h.pgCalls)!.source).toBe('usage');
  });

  it('запоминает длительность хода и длину ответа', async () => {
    const h = makeHarness({ answer: ANSWER, costUsd: 0.5 });
    await h.run();

    expect(typeof taskMeta(h.pgCalls)!.durationMs).toBe('number');
    expect(taskMeta(h.pgCalls)!.replyChars).toBe(ANSWER.length);
  });
});
