import { Readable } from 'stream';
import axios from 'axios';
import { ChatService, SdkUsageTotals } from './chat.service';
import { SEAT_TOKENS_PER_USD } from '../common/billing-rates';
import { sendTelegramAlert } from '../common/telegram-alert';

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
 * Страховка снизу — 0.15 формулы. Прогон по логу списаний прода (382 хода с
 * 14.10): счёт CLI к формуле у opus-5-5 — 0.49–0.80 (медиана 0.63), у проб
 * мониторинга на Haiku — ровно 0.20, дороже формулы — ни одного хода. 0.5
 * резала честный счёт Haiku и части opus-5-5; 0.15 ниже цены любой модели,
 * но ловит релей, приславший почти ноль.
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
/** Страховка по умолчанию — решение владельца 15.10.2026 после прогона по логу прода. */
const DEFAULT_FLOOR = 0.15;

function makeService(o: { costGrowth?: { recordTurn: jest.Mock }; agentRow?: boolean } = {}) {
  const calls: { sql: string; params: any[] }[] = [];
  const pg = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      // Голосовой путь (generateAgentReplyWithCharge) сначала ищет ассистента.
      if (o.agentRow && /FROM agents/.test(sql)) return { rows: [{ id: 7, name: 'Роман', system_prompt: '' }] };
      if (/FROM speech_clips|FROM video_jobs|FROM calendar_proposals/.test(sql)) return { rows: [] };
      if (/AS spent/.test(sql)) return { rows: [{ spent: 0 }] };
      if (/SELECT tokens FROM ai_profiles_consolidated/.test(sql)) return { rows: [{ tokens: 1_000_000 }] };
      return { rows: [] };
    }),
  };
  const language = { resolveUserLanguage: jest.fn(async () => 'ru') };
  const svc = new ChatService(
    pg as any, null as any, null as any,
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

/** Метаданные строки списания — то, что доедет до token_transactions. */
function taskMeta(calls: { sql: string; params: any[] }[]): any {
  const row = calls.find((c) => /INSERT INTO token_consumption_tasks/.test(c.sql));
  return row?.params[5] ? JSON.parse(row.params[5]) : undefined;
}

function sseStream(events: any[]): Readable {
  const s = new Readable({ read() {} });
  process.nextTick(() => {
    for (const ev of events) s.push(`data: ${JSON.stringify(ev)}\n`);
    s.push(null);
  });
  return s;
}

/**
 * Обычный ход чата целиком. Каждый массив событий — один вызов релея: пустой
 * поток сервис повторяет один раз (self-heal), и второму вызову нужен свой.
 */
async function runStream(svc: ChatService, ...runs: any[][]): Promise<any[]> {
  for (const events of runs) (axios.post as jest.Mock).mockResolvedValueOnce({ data: sseStream(events) });
  const written: any[] = [];
  const res: any = {
    status: jest.fn(), setHeader: jest.fn(), end: jest.fn(),
    write: jest.fn((s: string) => { try { written.push(JSON.parse(s)); } catch {} return true; }),
  };
  await (svc as any).streamUniversalAgent(
    'u1', 'привет', '7', '7', [], '', res, 'Роман', '', '', undefined, false, undefined,
  );
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
  return written;
}

/** Алерты «Страховка списания» среди всего, что ушло в Telegram. */
const floorAlerts = () =>
  (sendTelegramAlert as jest.Mock).mock.calls.map((c) => String(c[0])).filter((t) => t.includes('Страховка списания'));

const sum = (a: SdkUsageTotals, b: SdkUsageTotals): SdkUsageTotals =>
  Object.fromEntries(Object.keys(a).map((k) => [k, (a as any)[k] + (b as any)[k]])) as SdkUsageTotals;

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
  it('CLI дешевле формулы — списан счёт CLI (ход 15.10: $2.70 против $1.66)', () => {
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

  it('CLI ниже страховки (0.15 формулы) — списана страховка, в раскладе видно «пол»', () => {
    // $0.01 при формуле $0.1425 — 0.07 от неё: так выглядит релей, ошибшийся
    // в вычитании cost-state, а не цена какой-либо модели.
    const { svc } = makeService();

    const c = charge(svc, USAGE, 0.01);

    expect(c.tokens).toBe(forUsd(DEFAULT_FLOOR * formulaUsd(USAGE)));
    expect(c.usd).toBeCloseTo(DEFAULT_FLOOR * formulaUsd(USAGE), 10);
    expect(c.note).toContain('взято=пол');
    // Счёт CLI в раскладе остаётся — по нему и видно, насколько сработала страховка.
    expect(c.note).toContain('ход=$0.0100');
  });

  it('Haiku-ход: CLI = 0.20 формулы — взят CLI, не пол', () => {
    // Пробы мониторинга на Haiku в логе прода — ровно 0.20 формулы, все 252 хода.
    const { svc } = makeService();
    const haiku = 0.2 * formulaUsd(USAGE);

    const c = charge(svc, USAGE, haiku);

    expect(c.tokens).toBe(forUsd(haiku));
    expect(c.note).toContain('взято=ход');
  });

  it('opus-5-5 на нижнем краю (0.49 формулы) — взят CLI, не пол', () => {
    // Два таких хода в логе прода: при страховке 0.5 их резала бы она.
    const { svc } = makeService();
    const low = 0.49 * formulaUsd(USAGE_1510);

    const c = charge(svc, USAGE_1510, low);

    expect(c.tokens).toBe(forUsd(low));
    expect(c.note).toContain('взято=ход');
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
    // 30 поисков = $0.30 сверху к $0.1425. Счёт CLI $0.03 выше 0.15 одних
    // токенов ($0.021), но ниже 0.15 формулы с поисками ($0.066).
    const { svc } = makeService();
    const usage = { ...USAGE, webSearch: 30 };

    const c = charge(svc, usage, 0.03);

    expect(c.tokens).toBe(forUsd(DEFAULT_FLOOR * formulaUsd(usage)));
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
  it('0.3: ход выше этой страховки — списан счёт CLI', () => {
    process.env[ENV] = '0.3';
    const { svc } = makeService();

    // $0.05 — 0.35 формулы ($0.1425), выше 0.3 от неё ($0.043).
    const c = charge(svc, USAGE, 0.05);

    expect(c.tokens).toBe(forUsd(0.05));
    expect(c.note).toContain('взято=ход');
  });

  it('0.3: ход выше страховки по умолчанию, но ниже 0.3 — списано 0.3 формулы', () => {
    // $0.03 — 0.21 формулы: при 0.15 списали бы его, при 0.3 — страховку.
    // Так видно, что значение из окружения действительно читается.
    process.env[ENV] = '0.3';
    const { svc } = makeService();

    const c = charge(svc, USAGE, 0.03);

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

  it.each(['abc', '0', '-1', '1.5', '', 'Infinity'])('бессмысленное значение «%s» — 0.15', (raw) => {
    process.env[ENV] = raw;
    const { svc } = makeService();

    const c = charge(svc, USAGE, 0.01);

    expect(c.tokens).toBe(forUsd(DEFAULT_FLOOR * formulaUsd(USAGE)));
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
    // Что легло в основу — и в метаданных списания: по ним считают без pm2-логов.
    expect(taskMeta(calls)).toMatchObject({ source: 'usage', taken: 'turn', turnCostUsd: TURN_1510 });
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
    expect(taskMeta(calls)).toMatchObject({ source: 'usage', taken: 'turn' });
  });

  it('голосовой путь (generateAgentReplyWithCharge): по счёту CLI, строка billing[voice:…] в логе', async () => {
    // Голосовые консультации списывают то, что вернул этот метод. Раньше
    // расклад здесь нигде не печатался — сработавшую страховку не было видно.
    const { svc } = makeService({ agentRow: true });
    const log = jest.spyOn((svc as any).logger, 'log');
    (axios.post as jest.Mock).mockResolvedValueOnce({
      data: sseStream([
        { type: 'delta', text: ANSWER },
        { type: 'done', costUsd: SESSION_USD, usage: USAGE_1510, turnCostUsd: TURN_1510 },
      ]),
    });

    const reply = await svc.generateAgentReplyWithCharge('u1', '7', 'привет');

    expect(reply.tokens).toBe(forUsd(TURN_1510));
    const line = log.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith('billing[voice:'));
    expect(line).toContain(`billing[voice:usage]: tokens=${forUsd(TURN_1510)} `);
    expect(line).toContain('взято=ход');
  });

  it('generateAgentReply без списания (пробы, поездки, пуши) строку billing[…] не печатает', async () => {
    // Его вызывающие токены не списывают: «billing» в логе соврал бы.
    const { svc } = makeService({ agentRow: true });
    const log = jest.spyOn((svc as any).logger, 'log');
    (axios.post as jest.Mock).mockResolvedValueOnce({
      data: sseStream([
        { type: 'delta', text: ANSWER },
        { type: 'done', costUsd: SESSION_USD, usage: USAGE_1510, turnCostUsd: TURN_1510 },
      ]),
    });

    await svc.generateAgentReply('u1', '7', 'привет');

    expect(log.mock.calls.map((c) => String(c[0])).some((l) => l.startsWith('billing['))).toBe(false);
  });
});

/**
 * Self-heal: пустой поток релей повторяет, и оба прогона оплачены — usage и
 * стоимость хода складываются. Если хоть один прогон пришёл без стоимости,
 * сумма стоимостей покрывает не весь ход, а usage — весь. Сравнивать их нельзя:
 * стоимость хода неизвестна, списание — по формуле.
 */
describe('стоимость хода по двум прогонам релея', () => {
  const empty = (done: Record<string, unknown>) => [{ type: 'done', costUsd: SESSION_USD, usage: USAGE, ...done }];
  const full = (done: Record<string, unknown>) => [
    { type: 'delta', text: ANSWER },
    { type: 'done', costUsd: SESSION_USD, usage: USAGE, ...done },
  ];

  it('первый прогон без стоимости, второй с ней — неизвестна: формула по сумме usage', async () => {
    const costGrowth = { recordTurn: jest.fn(async () => {}) };
    const { svc, calls } = makeService({ costGrowth });

    // $0.05 по счёту второго прогона выше 0.15 формулы обоих ($0.043) — без
    // «липкого» неизвестно списали бы её, недосчитав первый прогон.
    await runStream(svc, empty({}), full({ turnCostUsd: 0.05 }));

    expect(chargedTokens(calls)).toBe(forUsd(formulaUsd(sum(USAGE, USAGE))));
    expect(taskMeta(calls)).toMatchObject({ taken: 'usage', turnCostUsd: null });
    const [, turn] = costGrowth.recordTurn.mock.calls[0] as any[];
    expect(turn.note).toContain('взято=usage');
  });

  it('первый прогон со стоимостью, второй без — тоже неизвестна', async () => {
    const { svc, calls } = makeService();

    await runStream(svc, empty({ turnCostUsd: 0.05 }), full({ turnCostUsd: null }));

    expect(chargedTokens(calls)).toBe(forUsd(formulaUsd(sum(USAGE, USAGE))));
    expect(taskMeta(calls)).toMatchObject({ taken: 'usage', turnCostUsd: null });
  });

  it('оба прогона со стоимостью — сумма', async () => {
    const { svc, calls } = makeService();

    await runStream(svc, empty({ turnCostUsd: 0.02 }), full({ turnCostUsd: 0.03 }));

    expect(chargedTokens(calls)).toBe(forUsd(0.02 + 0.03));
    expect(taskMeta(calls)).toMatchObject({ taken: 'turn', turnCostUsd: 0.05 });
  });
});

/**
 * Сработавшая страховка — признак поломки релея (честный счёт CLI так низко не
 * бывает), а не повод тихо списать. Алерт — раз в 6 часов на процесс: одна
 * поломка бьёт по каждому ходу, сотня одинаковых сообщений ничего не добавит.
 */
describe('алерт «Страховка списания»', () => {
  const upload = (svc: ChatService, turnCostUsd: number, extra: Record<string, unknown> = {}) =>
    svc.persistUploadTurn({
      userId: 'u1', assistantId: '12', userMsg: '📎 scan.jpg', assistantMsg: 'Перевод готов.',
      usage: USAGE, costUsd: SESSION_USD, turnCostUsd, durationMs: 1000, ...extra,
    });

  it('ход по страховке — один алерт: сколько прислал релей, формула, юзер, ассистент, расклад', async () => {
    const { svc, calls } = makeService();

    await upload(svc, 0.01);

    expect(taskMeta(calls)).toMatchObject({ taken: 'floor' });
    const alerts = floorAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('$0.0100');
    expect(alerts[0]).toContain('$0.1425');
    expect(alerts[0]).toContain('страховка 0.15');
    expect(alerts[0]).toContain('<code>u1</code>');
    expect(alerts[0]).toContain('ассистент 12');
    expect(alerts[0]).toContain('взято=пол');
  });

  it('два хода по страховке за 6 часов — один алерт', async () => {
    const { svc } = makeService();

    await upload(svc, 0.01);
    await upload(svc, 0.01);

    expect(floorAlerts()).toHaveLength(1);
  });

  it('через 6 часов — снова', async () => {
    const { svc } = makeService();
    const now = jest.spyOn(Date, 'now');
    try {
      now.mockReturnValue(1_000_000_000_000);
      await upload(svc, 0.01);
      now.mockReturnValue(1_000_000_000_000 + 6 * 60 * 60 * 1000 + 1);
      await upload(svc, 0.01);
    } finally {
      now.mockRestore();
    }

    expect(floorAlerts()).toHaveLength(2);
  });

  it('ход по счёту CLI — алерта нет', async () => {
    const { svc } = makeService();

    await upload(svc, 0.05);

    expect(floorAlerts()).toHaveLength(0);
  });

  it('прерванный ход не выставлен — и алерта о его списании нет', async () => {
    const { svc } = makeService();

    await upload(svc, 0.01, { turnFailed: true, failReason: 'interrupted' });

    expect(floorAlerts()).toHaveLength(0);
  });

  it('обычный ход чата по страховке — алерт и taken=floor в метаданных', async () => {
    const { svc, calls } = makeService();

    await runStream(svc, [
      { type: 'delta', text: ANSWER },
      { type: 'done', costUsd: SESSION_USD, usage: USAGE, turnCostUsd: 0.01 },
    ]);

    expect(chargedTokens(calls)).toBe(forUsd(DEFAULT_FLOOR * formulaUsd(USAGE)));
    expect(taskMeta(calls)).toMatchObject({ taken: 'floor' });
    expect(floorAlerts()).toHaveLength(1);
  });

  it('голосовой путь по страховке — алерт', async () => {
    const { svc } = makeService({ agentRow: true });
    (axios.post as jest.Mock).mockResolvedValueOnce({
      data: sseStream([
        { type: 'delta', text: ANSWER },
        { type: 'done', costUsd: SESSION_USD, usage: USAGE, turnCostUsd: 0.01 },
      ]),
    });

    await svc.generateAgentReplyWithCharge('u1', '7', 'привет');

    expect(floorAlerts()).toHaveLength(1);
  });
});
