import * as os from 'os';
import * as path from 'path';
import { Logger } from '@nestjs/common';

// Мокаем spawn ДО импорта сервиса: сервис берёт spawn из 'child_process' на
// уровне модуля.
jest.mock('child_process', () => ({ spawn: jest.fn() }));
import { spawn } from 'child_process';
import { ClaudeCliCallError, ClaudeCliService } from './claude-cli.service';

/**
 * Ошибки CLI без сырого текста (spec 2026-11-02-safe-cli-errors): сырой текст
 * сбоя — result, stdout (NDJSON хода или итоговый JSON), stderr, errors[],
 * сообщение JSON.parse (оно цитирует начало stdout) — несёт фрагменты
 * разговоров. Он только классифицируется внутри сервиса; наружу — в message,
 * stack и журналы — уходят вид сбоя, код ответа API, код выхода, диагностика
 * CLI и отказ самого CLI (фраза и хвост из белого списка, refusalDetail).
 * Ошибка без признаков (не от CLI) — other без доступа, текст по её коду.
 */

const spawnMock = spawn as unknown as jest.Mock;

/** Маркер «фрагмента разговора» в сыром выводе CLI. Проверка — по первому
 *  слову: сообщение JSON.parse цитирует начало вывода и может его обрезать. */
const SECRET = 'СЕКРЕТ-ИЗ-ОТВЕТА';
/** Латинский маркер — для хвоста после фразы отказа: текст с кириллицей
 *  looksLikeCliRefusal отказом не считает, и до детали он не дошёл бы. */
const LATIN = 'SECRET-FROM-ANSWER';
const LEAK = /СЕКРЕТ|SECRET/;
/** Фраза отказа CLI с начала, дальше — ответ модели (ревью 02.11, I1). */
const REFUSAL_WITH_ANSWER = `Invalid API key means the token ${LATIN} is wrong`;

/** Фейковый процесс: на следующем тике отдаёт stdout и stderr и закрывается с кодом code. */
function fakeProc(stdout: string, code = 0, stderr = '') {
  const outH: Array<(b: Buffer) => void> = [];
  const errH: Array<(b: Buffer) => void> = [];
  const on: Record<string, (...a: any[]) => void> = {};
  const proc: any = {
    stdout: { on: (e: string, cb: any) => { if (e === 'data') outH.push(cb); } },
    stderr: { on: (e: string, cb: any) => { if (e === 'data') errH.push(cb); } },
    on: (e: string, cb: any) => { on[e] = cb; },
    kill: () => {},
  };
  setImmediate(() => {
    if (stdout) outH.forEach((cb) => cb(Buffer.from(stdout)));
    if (stderr) errH.forEach((cb) => cb(Buffer.from(stderr)));
    on['close']?.(code);
  });
  return proc;
}

/** Процесс, который не отвечает никогда (для таймаута). */
function hangingProc() {
  return { stdout: { on: () => {} }, stderr: { on: () => {} }, on: () => {}, kill: () => {} } as any;
}

/** Висит до kill(); после kill закрывается сигналом, как настоящий процесс. */
function killableProc() {
  const on: Record<string, (...a: any[]) => void> = {};
  return {
    stdout: { on: () => {} },
    stderr: { on: () => {} },
    on: (e: string, cb: any) => { on[e] = cb; },
    kill: (sig?: string) => { setImmediate(() => on['close']?.(null, sig ?? 'SIGTERM')); },
  } as any;
}

/** Процесс, убитый сигналом извне (OOM, kill): close(null, сигнал) без вывода. */
function signalProc(signal: string) {
  const on: Record<string, (...a: any[]) => void> = {};
  const proc: any = {
    stdout: { on: () => {} },
    stderr: { on: () => {} },
    on: (e: string, cb: any) => { on[e] = cb; },
    kill: () => {},
  };
  setImmediate(() => on['close']?.(null, signal));
  return proc;
}

/** Синхронный отказ spawn, как у Node 22 при NUL в аргументе: сообщение
 *  цитирует начало аргумента — у нас это промпт. */
const argNulError = (quoted: string) =>
  Object.assign(new TypeError(`The argument 'args[1]' must be a string without null bytes. Received '${quoted}'`), {
    code: 'ERR_INVALID_ARG_VALUE',
  });

/** Процесс, который не запустился (событие error, как у spawn без бинаря). */
function spawnErrorProc(code: string) {
  const on: Record<string, (...a: any[]) => void> = {};
  const proc: any = {
    stdout: { on: () => {} },
    stderr: { on: () => {} },
    on: (e: string, cb: any) => { on[e] = cb; },
    kill: () => {},
  };
  setImmediate(() => on['error']?.(Object.assign(new Error(`spawn /usr/bin/claude ${code}`), { code })));
  return proc;
}

const lines = (...evs: object[]) => evs.map((e) => JSON.stringify(e)).join('\n') + '\n';
const OK = (result: string, cost = 0.01) => JSON.stringify({ is_error: false, result, total_cost_usd: cost, duration_ms: 5 });
/** stream-json: onProgress переключает CLI в него. */
const STREAM = { onProgress: () => {} };
// Так errors[] собирает CLI 2.1.x: первой — диагностика, дальше — ошибки хода
// (error.stack || error.message: пути файлов, цитаты запроса).
const DIAG = '[ede_diagnostic] result_type=user last_content_type=tool_result stop_reason=null';

/** Все вызовы логгера сервиса, на всех уровнях — строкой на вызов. */
let logSpies: jest.SpyInstance[] = [];
const asText = (a: unknown): string => {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return `${a.message}\n${a.stack}`;
  try { return JSON.stringify(a); } catch { return String(a); }
};
const logged = (): string[] => logSpies.flatMap((s) => s.mock.calls.map((c) => c.map(asText).join(' ')));

const VARS = ['QWEN_FALLBACK_API_KEY', 'KIMI_FALLBACK_API_KEY', 'LLM_FALLBACK_BREAKER_MS', 'QWEN_FALLBACK_BREAKER_MS'];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  spawnMock.mockReset();
  saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
  for (const k of VARS) delete process.env[k];
  logSpies = (['log', 'error', 'warn', 'debug', 'verbose', 'fatal'] as const)
    .filter((l) => typeof (Logger.prototype as any)[l] === 'function')
    .map((l) => jest.spyOn(Logger.prototype as any, l).mockImplementation(() => undefined));
});

afterEach(() => {
  for (const k of VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  jest.restoreAllMocks();
});

/** Один запуск Claude без цепочки: сбой уходит вызывающему исходным объектом. */
async function failOnce(make: () => any, opts: object = {}): Promise<any> {
  spawnMock.mockImplementationOnce(make);
  return new ClaudeCliService().text('x', { ...opts, noFallback: true }).then(
    (text) => { throw new Error(`ожидался сбой, пришёл ответ: ${text}`); },
    (e) => e,
  );
}

describe('ClaudeCliService — сырой текст сбоя не выходит наружу', () => {
  const LEAKS: Array<[string, object, () => any]> = [
    ['json: result при is_error (код 0)', {}, () => fakeProc(JSON.stringify({ is_error: true, result: `API Error: 500 ${SECRET}` }), 0)],
    ['json: result при is_error (код 1)', {}, () => fakeProc(JSON.stringify({ is_error: true, result: `Failed to authenticate. ${SECRET}` }), 1)],
    ['json: обычный ответ при коде 1', {}, () => fakeProc(JSON.stringify({ is_error: false, result: SECRET }), 1)],
    ['json: поле error при коде 1', {}, () => fakeProc(JSON.stringify({ error: `boom ${SECRET}` }), 1)],
    ['json: stdout не JSON при коде 1', {}, () => fakeProc(`${SECRET} — сырой вывод`, 1)],
    ['json: stderr при коде 1', {}, () => fakeProc('', 1, `Error: ${SECRET}\n    at /home/u/doc.pdf`)],
    ['json: errors[] при коде 1', {}, () => fakeProc(JSON.stringify({ is_error: true, subtype: 'error_during_execution', errors: [DIAG, `Error: ${SECRET}`] }), 1)],
    ['json: errors[] при is_error (код 0)', {}, () => fakeProc(JSON.stringify({ is_error: true, subtype: 'error_during_execution', errors: [`Error: ${SECRET}`] }), 0)],
    ['json: неверный JSON (код 0)', {}, () => fakeProc(`${SECRET} не JSON`, 0)],
    ['stream: result при is_error (код 0)', STREAM, () => fakeProc(lines({ type: 'result', is_error: true, result: `API Error: 500 ${SECRET}` }), 0)],
    ['stream: result при is_error (код 1)', STREAM, () => fakeProc(lines({ type: 'result', is_error: true, result: `Failed to authenticate. ${SECRET}` }), 1)],
    ['stream: поле error при is_error (код 1)', STREAM, () => fakeProc(lines({ type: 'result', is_error: true, error: `boom ${SECRET}` }), 1)],
    ['stream: stderr при коде 1', STREAM, () => fakeProc('', 1, `Error: ${SECRET}`)],
    ['stream: неверный JSON в stdout при коде 1', STREAM, () => fakeProc(`${SECRET} не JSON\n`, 1)],
    ['stream: ответ модели в NDJSON хода, код 1 без result', STREAM, () => fakeProc(lines({ type: 'assistant', message: { content: [{ type: 'text', text: SECRET }] } }), 1)],
    ['stream: errors[] (error_during_execution, код 1)', STREAM, () => fakeProc(lines({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [DIAG, `Error: ${SECRET}`] }), 1)],
    ['stream: диагностика с маркером не проходит строгую проверку', STREAM, () => fakeProc(lines({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [`[ede_diagnostic] a=${SECRET}`] }), 0)],
    // Ревью 02.11, I1: фраза отказа CLI с начала, дальше — латинский текст ответа.
    ['json: отказ CLI с хвостом ответа модели (is_error, код 0)', {}, () => fakeProc(JSON.stringify({ is_error: true, result: REFUSAL_WITH_ANSWER }), 0)],
    ['json: отказ CLI с хвостом ответа модели (is_error, код 1)', {}, () => fakeProc(JSON.stringify({ is_error: true, result: REFUSAL_WITH_ANSWER }), 1)],
    ['json: отказ CLI с хвостом в stderr (код 1)', {}, () => fakeProc('', 1, `Not logged in ${LATIN}`)],
    ['stream: отказ CLI с хвостом ответа модели (is_error, код 0)', STREAM, () => fakeProc(lines({ type: 'result', is_error: true, result: REFUSAL_WITH_ANSWER }), 0)],
    ['stream: отказ CLI с хвостом ответа модели (is_error, код 1)', STREAM, () => fakeProc(lines({ type: 'result', is_error: true, result: REFUSAL_WITH_ANSWER }), 1)],
    // Ревью 02.11, I2: синхронный отказ spawn цитирует начало промпта.
    ['spawn: синхронный отказ (NUL в аргументе)', {}, () => { throw argNulError(`${SECRET} ${LATIN}`); }],
  ];

  it.each(LEAKS)('%s — маркера нет ни в message, ни в stack, ни в журнале', async (_name, opts, make) => {
    const err = await failOnce(make, opts);
    expect(err).toBeInstanceOf(ClaudeCliCallError);
    expect(err.message).toMatch(/^claude CLI /);
    expect(err.message).not.toMatch(LEAK);
    expect(String(err.stack)).not.toMatch(LEAK);
    expect(String(err.stack)).toContain(err.message);
    expect(logged().join('\n')).not.toMatch(LEAK);
  });

  it('журнал кода выхода — безопасный текст и размеры вывода вместо содержимого', async () => {
    const stdout = `${SECRET} — сырой вывод`;
    const stderr = `Error: ${SECRET}`;
    const err = await failOnce(() => fakeProc(stdout, 1, stderr));
    expect(logged()).toContain(
      `${err.message} (stdout ${Buffer.byteLength(stdout)} байт, stderr ${Buffer.byteLength(stderr)} байт)`,
    );
  });

  it('журнал неверного JSON — без сообщения JSON.parse и без stdout', async () => {
    const stdout = `${SECRET} не JSON`;
    const err = await failOnce(() => fakeProc(stdout, 0));
    expect(err.message).toBe(`claude CLI неверный JSON (stdout ${Buffer.byteLength(stdout)} байт): other`);
    const all = logged().join('\n');
    expect(all).toContain(err.message);
    expect(all).not.toMatch(/Unexpected token|not valid JSON|in JSON at position/);
  });
});

describe('ClaudeCliService — признаки сбоя (kind, access, status)', () => {
  it('401 в stream-json с api_error_status — auth, доступ, status 401', async () => {
    const err = await failOnce(() => fakeProc(lines({
      type: 'result', is_error: true, api_error_status: 401,
      result: `Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid bearer token ${SECRET}"}}`,
    }), 1), STREAM);
    expect(err).toBeInstanceOf(ClaudeCliCallError);
    expect(err).toMatchObject({ kind: 'auth', access: true, status: 401 });
    expect(err.message).toBe('claude CLI код выхода 1: auth, status 401');
  });

  it('401 в json-режиме с api_error_status — status из итогового JSON', async () => {
    const err = await failOnce(() => fakeProc(JSON.stringify({
      is_error: true, api_error_status: 401, result: 'Failed to authenticate. API Error: 401 Invalid API-key provided.',
    }), 1));
    expect(err).toMatchObject({ kind: 'auth', access: true, status: 401 });
    expect(err.message).toBe('claude CLI код выхода 1: auth, status 401');
  });

  it('401 без api_error_status — auth, доступ, status нет', async () => {
    const err = await failOnce(() => fakeProc(JSON.stringify({
      is_error: true, result: 'Failed to authenticate: OAuth session expired and could not be refreshed',
    }), 1));
    expect(err).toMatchObject({ kind: 'auth', access: true });
    expect(err.status).toBeUndefined();
    expect(err.message).toBe('claude CLI код выхода 1: auth');
  });

  it.each(['401', 999, 401.5, null])('api_error_status %p — не код HTTP: не берётся', async (st) => {
    const err = await failOnce(() => fakeProc(JSON.stringify({ is_error: true, api_error_status: st, result: 'API Error: 401' }), 1));
    expect(err.status).toBeUndefined();
    expect(err.message).toBe('claude CLI код выхода 1: auth');
  });

  it('529 (is_error при коде 0) — overloaded, доступ, status 529', async () => {
    const err = await failOnce(() => fakeProc(lines({
      type: 'result', is_error: true, api_error_status: 529,
      result: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    }), 0), STREAM);
    expect(err).toMatchObject({ kind: 'overloaded', access: true, status: 529 });
    expect(err.message).toBe('claude CLI ошибка: overloaded, status 529');
  });

  it('403 AccessDenied (Qwen без плана) — other, но доступ', async () => {
    const err = await failOnce(() => fakeProc(JSON.stringify({
      is_error: true, result: 'API Error: 403 {"code":"AccessDenied.Unpurchased","message":"Access denied"}',
    }), 1));
    expect(err).toMatchObject({ kind: 'other', access: true });
  });

  it('Arrearage (долг у Alibaba) — other, но доступ', async () => {
    const err = await failOnce(() => fakeProc(JSON.stringify({ is_error: true, result: 'API Error: 400 Arrearage: your account is overdue' }), 0));
    expect(err).toMatchObject({ kind: 'other', access: true });
    expect(err.message).toBe('claude CLI ошибка: other');
  });

  it('переполнение контекста — вид weekly_limit по тексту, но без доступа: признаки независимы', async () => {
    const err = await failOnce(() => fakeProc(JSON.stringify({ is_error: true, result: 'Context limit reached · /compact or /clear to continue' }), 0));
    expect(err).toMatchObject({ kind: 'weekly_limit', access: false });
  });

  it('prompt is too long — без доступа', async () => {
    const err = await failOnce(() => fakeProc(JSON.stringify({ is_error: true, result: 'Prompt is too long: 250000 tokens' }), 1));
    expect(err.access).toBe(false);
  });

  it('таймаут — timeout, без доступа; текст прежний', async () => {
    const err = await failOnce(() => hangingProc(), { timeoutMs: 5 });
    expect(err).toBeInstanceOf(ClaudeCliCallError);
    expect(err).toMatchObject({ kind: 'timeout', access: false });
    expect(err.message).toBe('claude CLI timeout after 5ms');
  });

  it('процесс не запустился (событие error) — other, без доступа; в тексте только код', async () => {
    const err = await failOnce(() => spawnErrorProc('ENOENT'));
    expect(err).toBeInstanceOf(ClaudeCliCallError);
    expect(err).toMatchObject({ kind: 'other', access: false });
    expect(err.message).toBe('claude CLI не запустился (ENOENT): other');
  });

  it('неверный JSON — other, без доступа, даже если в выводе «401»', async () => {
    const stdout = 'API Error: 401 Unauthorized — не JSON';
    const err = await failOnce(() => fakeProc(stdout, 0));
    expect(err).toMatchObject({ kind: 'other', access: false });
    expect(err.message).toBe(`claude CLI неверный JSON (stdout ${Buffer.byteLength(stdout)} байт): other`);
  });

  it('error_during_execution со строкой [ede_diagnostic] (stream, код 1) — диагностика в message', async () => {
    const err = await failOnce(() => fakeProc(lines({
      type: 'result', subtype: 'error_during_execution', is_error: true, errors: [DIAG, 'Error: Request was aborted.'],
    }), 1), STREAM);
    expect(err.message).toBe(`claude CLI код выхода 1: other, ${DIAG}`);
  });

  it('[ede_diagnostic] в errors[] итогового JSON (is_error при коде 0) — диагностика в message', async () => {
    const err = await failOnce(() => fakeProc(JSON.stringify({
      is_error: true, subtype: 'error_during_execution', api_error_status: 500, errors: ['Error: x', DIAG],
    }), 0));
    expect(err.message).toBe(`claude CLI ошибка: other, status 500, ${DIAG}`);
  });

  it.each([
    ["You've hit your limit · resets 3pm (Europe/Moscow)", 'weekly_limit', "You've hit your limit · resets 3pm (Europe/Moscow)"],
    // Дата сброса — в белом списке; текст после неё — нет.
    ["You've hit your weekly limit · resets Nov 3", 'weekly_limit', "You've hit your weekly limit · resets Nov 3"],
    [`You've hit your weekly limit · resets Nov 3 ${LATIN}`, 'weekly_limit', "You've hit your weekly limit"],
    [REFUSAL_WITH_ANSWER, 'auth', 'Invalid API key'],
  ])('отказ CLI в is_error — в message только фраза и хвост из белого списка: %p', async (result, kind, detail) => {
    const err = await failOnce(() => fakeProc(JSON.stringify({ is_error: true, result }), 0));
    expect(err).toMatchObject({ kind, access: true });
    expect(err.message).toBe(`claude CLI ошибка: ${kind}, ${detail}`);
  });

  it('отказ CLI при коде 1 (stream) — текст отказа в message', async () => {
    const err = await failOnce(() => fakeProc(lines({ type: 'result', is_error: true, result: 'Not logged in · Please run /login' }), 1), STREAM);
    expect(err).toMatchObject({ kind: 'auth', access: true });
    expect(err.message).toBe('claude CLI код выхода 1: auth, Not logged in · Please run /login');
  });

  it('отказ CLI обычным ответом — сбой доступа: переход на запасного, окно Claude; в журнале вид и фраза', async () => {
    process.env.QWEN_FALLBACK_API_KEY = 'sk-sp-test';
    spawnMock
      .mockImplementationOnce(() => fakeProc(OK("You've hit your limit · resets 3pm", 0)))
      .mockImplementationOnce(() => fakeProc(OK('q')));
    const svc = new ClaudeCliService();
    expect(await svc.text('x')).toBe('q');
    expect(svc.fallbackStats().breakerOpenUntil).toBeGreaterThan(0);
    expect(logged()).toContain(
      "claude CLI → запасной Qwen qwen3.6-flash (weekly_limit): claude CLI отказ: weekly_limit, You've hit your limit · resets 3pm",
    );
  });

  it('ClaudeCliCallError без признаков — поля не заданы; с признаками — читаются', () => {
    const bare = new ClaudeCliCallError('claude CLI ошибка: other', false);
    expect(bare).toMatchObject({ message: 'claude CLI ошибка: other', toolUsed: false, name: 'ClaudeCliCallError' });
    expect(bare.kind).toBeUndefined();
    expect(bare.access).toBeUndefined();
    expect(bare.status).toBeUndefined();
    const full = new ClaudeCliCallError('m', true, { kind: 'auth', access: true, status: 401 });
    expect(full).toMatchObject({ toolUsed: true, kind: 'auth', access: true, status: 401 });
  });

  it('признака refusal у ошибки нет: его никто не читает', () => {
    const err = new ClaudeCliCallError('m', false, { kind: 'weekly_limit', access: true, refusal: true } as any);
    expect('refusal' in err).toBe(false);
  });
});

/**
 * Цепочка Claude → Qwen → Kimi при сырых текстах с маркером: переход идёт по
 * признакам попытки (текст ошибки безопасен и для классификации не годится),
 * журналы и итоговая ошибка — из безопасных текстов, у итоговой — сводные
 * признаки: вид — сильнейший по попыткам, доступ — хоть одна попытка с ним.
 */
describe('ClaudeCliService — цепочка при сырых текстах с маркером', () => {
  const RAW_401 = (who: string) =>
    JSON.stringify({ is_error: true, api_error_status: 401, result: `Failed to authenticate. API Error: 401 ${who} ${SECRET}` });
  /** Ключ i-го запуска; undefined — запуск Claude (своего окружения нет). */
  const tokenOf = (i: number) => spawnMock.mock.calls[i][2]?.env?.ANTHROPIC_AUTH_TOKEN as string | undefined;

  beforeEach(() => {
    process.env.QWEN_FALLBACK_API_KEY = 'sk-sp-test';
    process.env.KIMI_FALLBACK_API_KEY = 'sk-kimi-test';
  });

  it('Claude 401 → Qwen 401 → отвечает Kimi; окна по признаку доступа; в журналах — безопасный текст', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeProc(RAW_401('claude'), 1, `Error: ${SECRET}`))
      .mockImplementationOnce(() => fakeProc(RAW_401('qwen'), 1))
      .mockImplementationOnce(() => fakeProc(OK('ок от kimi')));
    const svc = new ClaudeCliService();
    expect(await svc.text('x')).toBe('ок от kimi');
    expect(spawnMock).toHaveBeenCalledTimes(3);
    expect(tokenOf(0)).toBeUndefined();
    expect(tokenOf(1)).toBe('sk-sp-test');
    expect(tokenOf(2)).toBe('sk-kimi-test');
    const st = svc.fallbackStats();
    expect(st.breakerOpenUntil).toBeGreaterThan(0);
    expect(st.providers.qwen.downUntil).toBeGreaterThan(0);
    expect(st.providers).toMatchObject({ qwen: { ok: 0, failed: 1 }, kimi: { ok: 1, failed: 0 } });
    const log = logged();
    expect(log).toContain('claude CLI → запасной Qwen qwen3.6-flash (auth): claude CLI код выхода 1: auth, status 401');
    expect(log).toContain('Qwen → запасной Kimi k3.1-pro (auth): claude CLI код выхода 1: auth, status 401');
    expect(log.join('\n')).not.toMatch(LEAK);
  });

  it('упали все — итоговая ошибка: склейка безопасных текстов, сводные признаки, маркера нет', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeProc(RAW_401('claude'), 1))
      .mockImplementationOnce(() => fakeProc(RAW_401('qwen'), 1, `Error: ${SECRET}`))
      .mockImplementationOnce(() => fakeProc(RAW_401('kimi'), 1));
    const err = await new ClaudeCliService().text('x').catch((e) => e);
    expect(err).toBeInstanceOf(ClaudeCliCallError);
    expect(err.message).toBe([
      'claude CLI код выхода 1: auth, status 401',
      'qwen fallback: claude CLI код выхода 1: auth, status 401',
      'kimi fallback: claude CLI код выхода 1: auth, status 401',
    ].join(' | '));
    expect(err).toMatchObject({ kind: 'auth', access: true, toolUsed: false });
    expect(String(err.stack)).not.toMatch(LEAK);
    const log = logged();
    expect(log).toContain(`запасные тоже не ответили: ${err.message}`);
    expect(log.join('\n')).not.toMatch(LEAK);
  });

  it('сводный вид — сильнейший: лимит Claude, таймаут Qwen → weekly_limit, доступ есть', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeProc(JSON.stringify({ is_error: true, result: "You've hit your weekly limit · resets Nov 3" }), 0))
      .mockImplementationOnce(() => hangingProc());
    const err = await new ClaudeCliService().text('x', { timeoutMs: 50 }).catch((e) => e);
    expect(err).toBeInstanceOf(ClaudeCliCallError);
    expect(err.message).toMatch(
      /^claude CLI ошибка: weekly_limit, You've hit your weekly limit · resets Nov 3 \| qwen fallback: claude CLI timeout after \d+ms$/,
    );
    expect(err).toMatchObject({ kind: 'weekly_limit', access: true });
    expect(spawnMock).toHaveBeenCalledTimes(2); // таймаут Qwen — не сбой доступа, Kimi не пробуется
  });

  it('ни одной попытки со сбоем доступа — access false: выбранный Kimi с неверным JSON, Claude по таймауту', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeProc(`${SECRET} не JSON`, 0))
      .mockImplementationOnce(() => hangingProc());
    const err = await new ClaudeCliService().text('x', { provider: 'kimi', timeoutMs: 50 }).catch((e) => e);
    expect(err).toBeInstanceOf(ClaudeCliCallError);
    expect(err.message).toMatch(
      /^kimi \(выбран\): claude CLI неверный JSON \(stdout \d+ байт\): other \| claude fallback: claude CLI timeout after \d+ms$/,
    );
    expect(err).toMatchObject({ kind: 'timeout', access: false });
    expect(tokenOf(0)).toBe('sk-kimi-test');
    expect(tokenOf(1)).toBeUndefined();
    expect(logged().join('\n')).not.toMatch(LEAK);
  });

  it('модель рубильника под noFallback (ход гостя) — одна попытка: «для всех», безопасный текст, признаки', async () => {
    spawnMock.mockImplementationOnce(() => fakeProc(RAW_401('qwen'), 1));
    const err = await new ClaudeCliService()
      .text('x', { provider: 'qwen', providerChoice: 'global', noFallback: true })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ClaudeCliCallError);
    expect(err.message).toBe('qwen (для всех): claude CLI код выхода 1: auth, status 401');
    expect(err).toMatchObject({ kind: 'auth', access: true });
  });

  it('отказ текстом последней попыткой — его текст в склейке, вид в сводке', async () => {
    delete process.env.KIMI_FALLBACK_API_KEY;
    spawnMock
      .mockImplementationOnce(() => fakeProc(RAW_401('claude'), 1))
      .mockImplementationOnce(() => fakeProc(OK("You've hit your limit · resets 3pm", 0)));
    const err = await new ClaudeCliService().text('x').catch((e) => e);
    expect(err).toBeInstanceOf(ClaudeCliCallError);
    expect(err.message).toBe(
      "claude CLI код выхода 1: auth, status 401 | qwen fallback: claude CLI отказ: weekly_limit, You've hit your limit · resets 3pm",
    );
    expect(err).toMatchObject({ kind: 'weekly_limit', access: true });
  });

  it('сбой доступа без повтора (инструмент с последствиями) — журнал с безопасным текстом', async () => {
    spawnMock.mockImplementationOnce(() => fakeProc(lines(
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__products__manage_product', input: {} }] } },
      { type: 'result', is_error: true, api_error_status: 529, result: `API Error: 529 Overloaded ${SECRET}` },
    ), 1));
    const err = await new ClaudeCliService().text('x', STREAM).catch((e) => e);
    expect(err).toMatchObject({ kind: 'overloaded', access: true, toolUsed: true });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(logged()).toContain(
      'claude CLI: сбой доступа (overloaded), вызов не повторяется (инструмент с последствиями или показанный текст): claude CLI код выхода 1: overloaded, status 529',
    );
    expect(logged().join('\n')).not.toMatch(LEAK);
  });

  it('синхронный отказ spawn (NUL в аргументе) — «не запустился» по коду, без перехода; цитата промпта не выходит', async () => {
    delete process.env.KIMI_FALLBACK_API_KEY;
    spawnMock
      .mockImplementationOnce(() => { throw argNulError(`API Error: 429 Too Many Requests ${SECRET}`); })
      .mockImplementationOnce(() => fakeProc(OK('q')));
    const err = await new ClaudeCliService().text('x').catch((e) => e);
    expect(err).toBeInstanceOf(ClaudeCliCallError);
    expect(err).toMatchObject({ message: 'claude CLI не запустился (ERR_INVALID_ARG_VALUE): other', kind: 'other', access: false });
    // «429» в цитате аргумента — не сбой доступа: на запасного не переходим.
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(String(err.stack)).not.toMatch(LEAK);
    expect(logged().join('\n')).not.toMatch(LEAK);
  });

  it('ошибка без признаков (подготовка вызова, не CLI) — other без доступа, текст по коду, без перехода', async () => {
    delete process.env.KIMI_FALLBACK_API_KEY;
    const svc = new ClaudeCliService();
    // Каталога нет: mkdtemp для копий вложений падает с ENOENT, а его
    // сообщение цитирует путь — здесь в пути маркер.
    (svc as any).tmpRoot = () => path.join(os.tmpdir(), `нет-такого-каталога-${SECRET}`);
    const err = await svc.text('x', { attachments: [__filename] }).catch((e) => e);
    expect(err).toBeInstanceOf(ClaudeCliCallError);
    expect(err).toMatchObject({ message: 'claude CLI сбой (ENOENT): other', kind: 'other', access: false });
    expect(spawnMock).not.toHaveBeenCalled();
    expect(String(err.stack)).not.toMatch(LEAK);
    expect(logged().join('\n')).not.toMatch(LEAK);
  });

  it('отказ обычным ответом с хвостом ответа модели — в склейке и журнале только фраза', async () => {
    delete process.env.KIMI_FALLBACK_API_KEY;
    spawnMock
      .mockImplementationOnce(() => fakeProc(OK(REFUSAL_WITH_ANSWER, 0)))
      .mockImplementationOnce(() => fakeProc(RAW_401('qwen'), 1));
    const err = await new ClaudeCliService().text('x').catch((e) => e);
    expect(err).toBeInstanceOf(ClaudeCliCallError);
    expect(err.message).toBe('claude CLI отказ: auth, Invalid API key | qwen fallback: claude CLI код выхода 1: auth, status 401');
    expect(err).toMatchObject({ kind: 'auth', access: true });
    expect(String(err.stack)).not.toMatch(LEAK);
    const log = logged();
    expect(log).toContain('claude CLI → запасной Qwen qwen3.6-flash (auth): claude CLI отказ: auth, Invalid API key');
    expect(log.join('\n')).not.toMatch(LEAK);
  });

  it('итоговая ошибка: toolUsed — хоть одна попытка с инструментом с последствиями', async () => {
    spawnMock.mockImplementationOnce(() => fakeProc(lines(
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__products__manage_product', input: {} }] } },
      { type: 'result', is_error: true, result: `API Error: 500 ${SECRET}` },
    ), 1));
    const err = await new ClaudeCliService().text('x', { ...STREAM, provider: 'kimi' }).catch((e) => e);
    expect(err).toBeInstanceOf(ClaudeCliCallError);
    expect(err.message).toBe('kimi (выбран): claude CLI код выхода 1: other');
    expect(err).toMatchObject({ toolUsed: true, kind: 'other', access: false });
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});

describe('ClaudeCliService — запуск процесса: NUL, сигналы, закрытие после таймаута', () => {
  it('NUL в промпте и системе вычищается до spawn', async () => {
    const NUL = String.fromCharCode(0);
    spawnMock.mockImplementationOnce(() => fakeProc(OK('ок')));
    expect(await new ClaudeCliService().text(`при${NUL}вет`, { system: `сис${NUL}тема`, noFallback: true })).toBe('ок');
    const args: string[] = spawnMock.mock.calls[0][1];
    expect(args.some((a) => a.includes(NUL))).toBe(false);
    const prompt = args[args.indexOf('-p') + 1];
    expect(prompt).toContain('привет');
    expect(prompt).toContain('система');
  });

  it.each([['json', {}], ['stream', STREAM]] as Array<[string, object]>)(
    '%s: процесс убит сигналом — в тексте имя сигнала, а не «код null»',
    async (_mode, opts) => {
      const err = await failOnce(() => signalProc('SIGKILL'), opts);
      expect(err).toMatchObject({ message: 'claude CLI сигнал SIGKILL: other', kind: 'other', access: false });
      expect(logged()).toContain('claude CLI сигнал SIGKILL: other (stdout 0 байт, stderr 0 байт)');
    },
  );

  it.each([['json', {}], ['stream', STREAM]] as Array<[string, object]>)(
    '%s: после таймаута закрытие процесса второй записи в журнал не делает',
    async (_mode, opts) => {
      const err = await failOnce(() => killableProc(), { ...opts, timeoutMs: 5 });
      expect(err.message).toBe('claude CLI timeout after 5ms');
      // close приходит после kill — на следующем обороте цикла событий.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(logged()).toEqual([]);
    },
  );
});
