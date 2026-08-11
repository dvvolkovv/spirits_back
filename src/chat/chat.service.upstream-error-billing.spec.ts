import { Readable } from 'stream';
import axios from 'axios';
import { ChatService, isUpstreamErrorReply } from './chat.service';

/**
 * Ход, где расход неизвестен, а вместо ответа приехала ошибка апстрима.
 *
 * 11.08.2026 с 05:00 до 05:15 четырём пользователям (включая 79030169187 и
 * 79236230446) в чат уехало «Your organization has disabled Claude subscription
 * access for Claude Code · Use an Anthropic API key instead» — текст ошибки
 * Claude CLI, отданный как ответ ассистента. Ровно 144 символа, и с каждого
 * списали 288 токенов: ни usage, ни costUsd релей не прислал, сработал откат
 * «длина ответа × 2».
 *
 * Обнулять весь откат нельзя: за 08–10.08 по нему прошли и настоящие ответы на
 * 214–3322 символа, где релей просто не прислал расход. Обнулив ветку целиком,
 * мы подарили бы реальную работу — включая субагентную. Поэтому не списываем
 * только тогда, когда ответ распознан как ошибка апстрима.
 */

function sseStream(events: any[]): Readable {
  const s = new Readable({ read() {} });
  process.nextTick(() => {
    for (const ev of events) s.push(`data: ${JSON.stringify(ev)}\n`);
    s.push(null);
  });
  return s;
}

function makeHarness(opts: { answer: string; costUsd: number | null; usage?: Record<string, number> }) {
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
    null as any, null as any, null as any, null as any, null as any, null as any,
    language as any,
    undefined, undefined, undefined,
  );

  const done: any = { type: 'done' };
  if (opts.costUsd !== null) done.costUsd = opts.costUsd;
  if (opts.usage) done.usage = opts.usage;

  (axios.post as jest.Mock).mockResolvedValue({
    data: sseStream([{ type: 'delta', text: opts.answer }, done]),
  });

  const res: any = {
    status: jest.fn(), setHeader: jest.fn(), write: jest.fn(() => true), end: jest.fn(),
  };

  const run = async () => {
    await (svc as any).streamUniversalAgent(
      'u1', 'привет', '7', '7', [], '', res, 'Роман', '', '', undefined, false, undefined,
    );
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  };

  return { pgCalls, run };
}

/** Сколько РЕАЛЬНО списали — по INSERT в token_consumption_tasks. */
function chargedTokens(pgCalls: { sql: string; params: any[] }[]): number | undefined {
  const row = pgCalls.find((c) => /INSERT INTO token_consumption_tasks/.test(c.sql));
  if (!row) return undefined;
  const [, , , inputTokens, outputTokens] = row.params;
  return Number(inputTokens) + Number(outputTokens);
}

jest.mock('axios');

/** Точный текст с прода, 144 символа. */
const CLI_ERROR =
  'Your organization has disabled Claude subscription access for Claude Code · ' +
  'Use an Anthropic API key instead, or contact your administrator';

describe('isUpstreamErrorReply', () => {
  it('узнаёт отвал подписки', () => {
    expect(isUpstreamErrorReply(CLI_ERROR)).toBe(true);
  });

  it('узнаёт протухший OAuth и упавший CLI', () => {
    expect(isUpstreamErrorReply('OAuth token has expired · Please run /login')).toBe(true);
    expect(isUpstreamErrorReply('Claude Code process exited with code 1')).toBe(true);
    expect(isUpstreamErrorReply('Invalid API key · Please run /login')).toBe(true);
  });

  it('не трогает обычные ответы ассистента', () => {
    expect(isUpstreamErrorReply('Вот это уже сильная позиция. Скажу прямо: снижение неустойки…')).toBe(false);
    expect(isUpstreamErrorReply('Запускаю проверку по четырём направлениям параллельно')).toBe(false);
    expect(isUpstreamErrorReply('ок')).toBe(false);
    expect(isUpstreamErrorReply('')).toBe(false);
  });

  // Ассистент вполне может ОБСУЖДАТЬ ошибку подписки, если его спросили: это
  // полноценная работа, и списать за неё надо. Признак — короткий ответ ровно
  // из текста ошибки, а не любое упоминание.
  it('не срабатывает, когда ассистент разбирает ошибку в длинном ответе', () => {
    const long =
      'Разберём вашу ошибку. Сообщение "Your organization has disabled Claude subscription access '
      + 'for Claude Code" означает, что администратор организации отключил доступ. '
      + 'Что делать: '.repeat(20);
    expect(isUpstreamErrorReply(long)).toBe(false);
  });
});

describe('Списание за ход, где вместо ответа пришла ошибка апстрима', () => {
  afterEach(() => jest.clearAllMocks());

  it('не списывает ничего', async () => {
    const h = makeHarness({ answer: CLI_ERROR, costUsd: null });
    await h.run();

    const charged = chargedTokens(h.pgCalls);
    // Либо списания нет вовсе, либо оно нулевое — но не 288.
    expect(charged ?? 0).toBe(0);
    expect(charged ?? 0).not.toBe(CLI_ERROR.length * 2);
  });

  it('настоящий ответ без расхода по-прежнему считается по длине', async () => {
    // Без пробела на концах: хвостовой пробел по пути обрезается, и ассерт
    // проверял бы обработку whitespace вместо самой формулы.
    const real = 'Считаю твою карту по точным данным и недельные транзиты.'.repeat(10);
    const h = makeHarness({ answer: real, costUsd: null });
    await h.run();

    expect(chargedTokens(h.pgCalls)).toBe(real.length * 2);
  });

  // Страховка от «починили откат, сломали основную ветку».
  it('ход с известной стоимостью не задет, даже если текст похож на ошибку', async () => {
    const h = makeHarness({ answer: CLI_ERROR, costUsd: 0.5 });
    await h.run();

    expect(chargedTokens(h.pgCalls)).toBeGreaterThan(0);
  });
});
