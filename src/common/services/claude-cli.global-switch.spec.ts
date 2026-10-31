import 'reflect-metadata';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from '@nestjs/common';

jest.mock('child_process', () => ({ spawn: jest.fn() }));
import { spawn } from 'child_process';
import { ClaudeCliService } from './claude-cli.service';
import { PgService } from './pg.service';
import { GlobalLlmProviderService } from './global-llm-provider.service';

/** Общий рубильник модели (spec 2026-10-31-global-llm-switch, разделы 1 и 3;
 *  «Уточнения по ревью 31.10»). */

const spawnMock = spawn as unknown as jest.Mock;

function fakeProc(stdout: string, code = 0) {
  const outH: Array<(b: Buffer) => void> = [];
  const on: Record<string, (...a: any[]) => void> = {};
  const proc: any = {
    stdout: { on: (e: string, cb: any) => { if (e === 'data') outH.push(cb); } },
    stderr: { on: () => {} },
    on: (e: string, cb: any) => { on[e] = cb; },
    kill: () => {},
  };
  setImmediate(() => { outH.forEach((cb) => cb(Buffer.from(stdout))); on['close']?.(code); });
  return proc;
}

/** NDJSON-строка для stream-json (onProgress/onTextDelta/MCP) — как streamOk
 *  в claude-cli.chain.spec.ts. */
const lines = (...evs: object[]) => evs.map((e) => JSON.stringify(e)).join('\n') + '\n';
const streamOk = (result: string, cost = 0.01) => lines({ type: 'result', is_error: false, result, total_cost_usd: cost, duration_ms: 1 });
const streamAuthFail = lines({ type: 'result', is_error: true, result: 'Failed to authenticate: OAuth session expired and could not be refreshed' });

const OK = (result: string, cost = 0.01) => JSON.stringify({ is_error: false, result, total_cost_usd: cost, duration_ms: 5 });
const QWEN_401 = JSON.stringify({ is_error: true, result: 'Failed to authenticate. API Error: 401 Invalid API-key provided.' });
const AUTH_FAIL = JSON.stringify({ is_error: true, result: 'Failed to authenticate: OAuth session expired and could not be refreshed' });
/** Ключ i-го запуска; undefined — запуск Claude. */
const tokenOf = (i: number) => spawnMock.mock.calls[i][2]?.env?.ANTHROPIC_AUTH_TOKEN as string | undefined;
const pgMock = () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) });
const event = (pg: any, i = 0) => JSON.parse(pg.query.mock.calls[i][1][0]);
const sw = (p: 'claude' | 'qwen' | 'kimi') => ({ get: jest.fn(async () => p) });

let roots: string[] = [];
function svc(pg?: any, global?: any): ClaudeCliService {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gls-spec-root-'));
  roots.push(root);
  const s = new ClaudeCliService(pg, global);
  (s as any).tmpRoot = () => root;
  return s;
}

const VARS = ['QWEN_FALLBACK_API_KEY', 'KIMI_FALLBACK_API_KEY', 'LLM_FALLBACK_BREAKER_MS', 'QWEN_FALLBACK_BREAKER_MS'];
let saved: Record<string, string | undefined>;
beforeEach(() => {
  spawnMock.mockReset();
  saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
  for (const k of VARS) delete process.env[k];
  process.env.QWEN_FALLBACK_API_KEY = 'sk-sp-test';
  process.env.KIMI_FALLBACK_API_KEY = 'sk-kimi-test';
});
afterEach(() => {
  for (const k of VARS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
  roots = [];
  jest.restoreAllMocks();
});

describe('ClaudeCliService — общий рубильник', () => {
  it('без provider, рубильник Qwen — сразу Qwen; событие: selected qwen, choice global, fallback false', async () => {
    const pg = pgMock();
    spawnMock.mockImplementationOnce(() => fakeProc(OK('q')));
    expect(await svc(pg, sw('qwen')).text('x')).toBe('q');
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(tokenOf(0)).toBe('sk-sp-test');
    expect(event(pg)).toMatchObject({ provider: 'qwen', fallback: false, selected: 'qwen', choice: 'global' });
  });

  it('без provider, рубильник Claude — Claude; в событии нет selected и choice', async () => {
    const pg = pgMock();
    spawnMock.mockImplementationOnce(() => fakeProc(OK('c')));
    expect(await svc(pg, sw('claude')).text('x')).toBe('c');
    expect(tokenOf(0)).toBeUndefined();
    expect(event(pg)).not.toHaveProperty('selected');
    expect(event(pg)).not.toHaveProperty('choice');
  });

  it('явный provider claude — Claude, рубильник не читается', async () => {
    const global = sw('qwen');
    spawnMock.mockImplementationOnce(() => fakeProc(OK('c')));
    expect(await svc(undefined, global).text('x', { provider: 'claude' })).toBe('c');
    expect(tokenOf(0)).toBeUndefined();
    expect(global.get).not.toHaveBeenCalled();
  });

  it('явный provider kimi при рубильнике Qwen — Kimi; choice user, рубильник не читается', async () => {
    const pg = pgMock();
    const global = sw('qwen');
    spawnMock.mockImplementationOnce(() => fakeProc(OK('k')));
    expect(await svc(pg, global).text('x', { provider: 'kimi' })).toBe('k');
    expect(tokenOf(0)).toBe('sk-kimi-test');
    expect(event(pg)).toMatchObject({ provider: 'kimi', selected: 'kimi', choice: 'user' });
    expect(global.get).not.toHaveBeenCalled();
  });

  it('provider мусор или null — как «не задан»: рубильник всё равно применяется', async () => {
    const pg = pgMock();
    spawnMock.mockImplementationOnce(() => fakeProc(OK('q')));
    expect(await svc(pg, sw('qwen')).text('x', { provider: null as any })).toBe('q');
    expect(tokenOf(0)).toBe('sk-sp-test');
    expect(event(pg)).toMatchObject({ provider: 'qwen', selected: 'qwen', choice: 'global' });
  });

  it('noFallback без provider (проба мониторинга) — Claude, рубильник не читается', async () => {
    const global = sw('qwen');
    spawnMock.mockImplementationOnce(() => fakeProc(OK('c')));
    expect(await svc(undefined, global).text('x', { noFallback: true })).toBe('c');
    expect(tokenOf(0)).toBeUndefined();
    expect(global.get).not.toHaveBeenCalled();
  });

  it('noFallback с provider qwen (ход гостя) — только Qwen: его сбой — ошибка, Claude не пробуется, окна не трогает', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    spawnMock.mockImplementationOnce(() => fakeProc(QWEN_401, 1));
    const s = svc(undefined, sw('claude'));
    await expect(s.text('x', { provider: 'qwen', noFallback: true })).rejects.toThrow(/401/);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(tokenOf(0)).toBe('sk-sp-test');
    // Решение по ревью 31.10: сбой доступа выбранного под noFallback не трогает
    // ничьё окно — анонимный гость отказом текстом не должен на 5 минут
    // выключить модель рубильника для всех.
    expect(s.fallbackStats().breakerOpenUntil).toBe(0);
    expect(s.fallbackStats().providers.qwen).toMatchObject({ ok: 0, failed: 0, downUntil: 0 });
  });

  it('noFallback с provider успешно отвечает — всё равно снимает «не отвечает» у модели (успех закрывает, как и обычный путь)', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    spawnMock
      .mockImplementationOnce(() => fakeProc(QWEN_401, 1)) // 1: личный выбор валит Qwen → «не отвечает»
      .mockImplementationOnce(() => fakeProc(OK('c1')))     // 1: обычный путь — Claude
      .mockImplementationOnce(() => fakeProc(OK('q2')));    // 2: ход гостя (noFallback) — Qwen отвечает
    const s = svc();
    await s.text('1', { provider: 'qwen' });
    expect(s.fallbackStats().providers.qwen.downUntil).toBeGreaterThan(0);
    expect(await s.text('2', { provider: 'qwen', noFallback: true })).toBe('q2');
    expect(s.fallbackStats().providers.qwen.downUntil).toBe(0);
  });

  it('noFallback с provider — отказ текстом («Not logged in») не трогает окно модели, downUntil остаётся 0', async () => {
    spawnMock.mockImplementationOnce(() => fakeProc(OK('Not logged in')));
    const s = svc();
    // Отказ CLI, пришедший обычным ответом (без is_error), при одной попытке в
    // плане возвращается как есть — тот же текст, что получал бы вызывающий и
    // раньше (claude-cli.fallback.spec.ts, «без ключа — вызывающий получает
    // тот же текст»); decision B здесь — именно про downUntil, не про throw.
    expect(await s.text('x', { provider: 'qwen', noFallback: true })).toBe('Not logged in');
    expect(s.fallbackStats().providers.qwen.downUntil).toBe(0);
  });

  it('noFallback с provider kimi без ключа — Claude, один запуск', async () => {
    delete process.env.KIMI_FALLBACK_API_KEY;
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    spawnMock.mockImplementationOnce(() => fakeProc(OK('c')));
    expect(await svc().text('x', { provider: 'kimi', noFallback: true })).toBe('c');
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(tokenOf(0)).toBeUndefined();
  });

  it('рубильник Qwen, Qwen упал по доступу — ответ Claude (обычный путь), Qwen «не отвечает», рубильник читается один раз', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const pg = pgMock();
    const global = sw('qwen');
    spawnMock
      .mockImplementationOnce(() => fakeProc(QWEN_401, 1))
      .mockImplementationOnce(() => fakeProc(OK('c')));
    const s = svc(pg, global);
    expect(await s.text('x')).toBe('c');
    expect(tokenOf(0)).toBe('sk-sp-test');
    expect(tokenOf(1)).toBeUndefined();
    expect(s.fallbackStats().providers.qwen.downUntil).toBeGreaterThan(0);
    expect(global.get).toHaveBeenCalledTimes(1);
    expect(event(pg)).toMatchObject({ provider: 'claude', fallback: false, selected: 'qwen', choice: 'global' });
  });

  it('рубильник Kimi без ключа — предупреждение «для всех» и обычный путь', async () => {
    delete process.env.KIMI_FALLBACK_API_KEY;
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    spawnMock.mockImplementationOnce(() => fakeProc(OK('c')));
    expect(await svc(undefined, sw('kimi')).text('x')).toBe('c');
    expect(tokenOf(0)).toBeUndefined();
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/Kimi выбран для всех \(рубильник\).*KIMI_FALLBACK_API_KEY/);
  });

  it('рубильник Kimi без ключа — предупреждение не чаще раза в минуту на модель', async () => {
    delete process.env.KIMI_FALLBACK_API_KEY;
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    spawnMock.mockImplementationOnce(() => fakeProc(OK('c1'))).mockImplementationOnce(() => fakeProc(OK('c2')));
    const s = svc(undefined, sw('kimi'));
    await s.text('1');
    await s.text('2');
    const keyWarnings = warn.mock.calls.filter((c) => String(c[0]).includes('KIMI_FALLBACK_API_KEY'));
    expect(keyWarnings.length).toBe(1);
  });

  it('личный выбор Kimi без ключа — предупреждение не ограничено по частоте: он редкий (ручная правка карточки)', async () => {
    delete process.env.KIMI_FALLBACK_API_KEY;
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    spawnMock.mockImplementationOnce(() => fakeProc(OK('c1'))).mockImplementationOnce(() => fakeProc(OK('c2')));
    const s = new ClaudeCliService();
    await s.text('1', { provider: 'kimi' });
    await s.text('2', { provider: 'kimi' });
    const keyWarnings = warn.mock.calls.filter((c) => String(c[0]).includes('KIMI_FALLBACK_API_KEY'));
    expect(keyWarnings.length).toBe(2);
  });

  it('сервис рубильника бросает — Claude, предупреждение с текстом ошибки', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    spawnMock.mockImplementationOnce(() => fakeProc(OK('c')));
    const broken = { get: jest.fn(async () => { throw new Error('boom'); }) };
    expect(await svc(undefined, broken).text('x')).toBe('c');
    expect(tokenOf(0)).toBeUndefined();
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/рубильник модели не прочитан: boom/);
  });

  it('без сервиса рубильника — как раньше: Claude', async () => {
    spawnMock.mockImplementationOnce(() => fakeProc(OK('c')));
    expect(await svc().text('x')).toBe('c');
    expect(tokenOf(0)).toBeUndefined();
  });
});

describe('ClaudeCliService — рубильник и stream-json', () => {
  it('вызов в stream-json (onProgress) — событие тоже несёт choice: global', async () => {
    const pg = pgMock();
    spawnMock.mockImplementationOnce(() => fakeProc(streamOk('q')));
    expect(await svc(pg, sw('qwen')).text('x', { onProgress: () => {} })).toBe('q');
    expect(event(pg)).toMatchObject({ provider: 'qwen', selected: 'qwen', choice: 'global' });
  });
});

/**
 * providerChoice (spec, «Уточнения по ревью 31.10»): ход гостя сам читает
 * рубильник и передаёт его модель через provider + noFallback — ClaudeCliService
 * прочитать рубильник сам при noFallback не может (fromSwitch ложен), поэтому
 * вызывающий говорит явно, чей это выбор, для события и для текста ошибки.
 */
describe('ClaudeCliService — providerChoice', () => {
  it("provider + providerChoice 'global' + noFallback — событие несёт choice: global", async () => {
    const pg = pgMock();
    spawnMock.mockImplementationOnce(() => fakeProc(OK('q')));
    expect(await new ClaudeCliService(pg as any).text('x', { provider: 'qwen', providerChoice: 'global', noFallback: true })).toBe('q');
    expect(event(pg)).toMatchObject({ provider: 'qwen', selected: 'qwen', choice: 'global' });
  });

  it("provider без providerChoice — по умолчанию 'user', как раньше", async () => {
    const pg = pgMock();
    spawnMock.mockImplementationOnce(() => fakeProc(OK('q')));
    expect(await new ClaudeCliService(pg as any).text('x', { provider: 'qwen', noFallback: true })).toBe('q');
    expect(event(pg)).toMatchObject({ provider: 'qwen', selected: 'qwen', choice: 'user' });
  });

  it('ход гостя (providerChoice global), Qwen падает — текст ошибки «для всех», не «выбран»', async () => {
    spawnMock.mockImplementationOnce(() => fakeProc(QWEN_401, 1));
    const err = await new ClaudeCliService().text('x', { provider: 'qwen', providerChoice: 'global', noFallback: true }).catch((e) => e);
    expect(err.message).toMatch(/^qwen \(для всех\): .*401/);
  });

  it("providerChoice мусор — трактуется как 'user', в событие как есть не уходит", async () => {
    const pg = pgMock();
    spawnMock.mockImplementationOnce(() => fakeProc(OK('q')));
    expect(await new ClaudeCliService(pg as any).text('x', { provider: 'qwen', providerChoice: 'garbage' as any, noFallback: true })).toBe('q');
    expect(event(pg)).toMatchObject({ provider: 'qwen', selected: 'qwen', choice: 'user' });
  });
});

describe('ClaudeCliService — рубильник уважает окно «не отвечает» (respectDown)', () => {
  it('рубильник Qwen, Qwen уже «не отвечает» (с прошлого вызова) — сразу Claude, без лишней попытки на Qwen', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    spawnMock
      .mockImplementationOnce(() => fakeProc(QWEN_401, 1)) // 1: личный выбор qwen падает
      .mockImplementationOnce(() => fakeProc(OK('c1')))     // 1: обычный путь — Claude
      .mockImplementationOnce(() => fakeProc(OK('c2')));    // 2: рубильник — прямо Claude
    const s = svc(undefined, sw('qwen'));
    expect(await s.text('1', { provider: 'qwen' })).toBe('c1');
    expect(s.fallbackStats().providers.qwen.downUntil).toBeGreaterThan(0);
    expect(await s.text('2')).toBe('c2');
    expect(spawnMock).toHaveBeenCalledTimes(3); // не 4 — рубильник не тронул Qwen повторно
    expect(tokenOf(2)).toBeUndefined();
  });

  it('пропуск виден в тексте ошибки, если дальше тоже никто не ответил', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    delete process.env.KIMI_FALLBACK_API_KEY; // без Kimi: после пропуска Qwen в плане только Claude
    spawnMock
      .mockImplementationOnce(() => fakeProc(QWEN_401, 1)) // 1: личный выбор qwen падает
      .mockImplementationOnce(() => fakeProc(OK('c1')))     // 1: обычный путь — Claude
      .mockImplementationOnce(() => fakeProc(AUTH_FAIL, 1)); // 2: рубильник пропускает Qwen, Claude тоже падает
    const s = svc(undefined, sw('qwen'));
    await s.text('1', { provider: 'qwen' });
    const err = await s.text('2').catch((e) => e);
    expect(err.message).toMatch(/^qwen \(для всех\) пропущен: не отвечает \| claude fallback: /);
  });
});

/**
 * Контролёр, ревью 31.10, пункт 1: в конструкторе ClaudeCliService
 * зависимость должна быть объявлена КЛАССОМ GlobalLlmProviderService, а не
 * интерфейсом или Object. Если типаж сотрётся до Object при компиляции —
 * Nest не найдёт провайдер по типу, @Optional() молча подставит undefined, и
 * рубильник тихо выключится на проде, хотя сам сервис зарегистрирован в
 * CommonModule. Образец — chat.service.guest-carry.spec.ts:213-228.
 */
describe('ClaudeCliService — DI рубильника', () => {
  it('конструктор объявляет параметры классами PgService и GlobalLlmProviderService', () => {
    expect(Reflect.getMetadata('design:paramtypes', ClaudeCliService)).toEqual([PgService, GlobalLlmProviderService]);
  });

  it('без globalProvider — предупреждение при старте', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    svc().onModuleInit();
    expect(warn.mock.calls.map((c) => String(c[0]))).toContain('рубильник модели не внедрён — вызовы без provider идут на Claude');
  });

  it('с globalProvider — предупреждения при старте нет', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    svc(undefined, sw('claude')).onModuleInit();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('ClaudeCliService — гонка с сервисом рубильника', () => {
  it('A ждёт ответ рубильника (claude); параллельный B (provider claude) валит Claude и открывает окно; план A строится ПОСЛЕ ответа — Qwen первым, не Claude (устаревший план запустил бы Claude)', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    let resolveSwitch: ((p: 'claude') => void) | undefined;
    const global = { get: jest.fn(() => new Promise<'claude'>((res) => { resolveSwitch = res; })) };
    spawnMock
      .mockImplementationOnce(() => fakeProc(streamAuthFail, 1)) // B: Claude падает → окно
      .mockImplementationOnce(() => fakeProc(OK('qA')));          // A: план [qwen, kimi] — Qwen первый
    const s = svc(undefined, global);
    const pA = s.text('A');
    expect(spawnMock).toHaveBeenCalledTimes(0); // A висит на get() рубильника, ничего не спавнило
    // onTextDelta у B — чтобы после первого сбоя Claude не пробовал Qwen/Kimi
    // сам (mayRetry запрещает повтор) и не забрал мок, предназначенный A.
    await expect(s.text('B', { provider: 'claude', onTextDelta: () => {} })).rejects.toThrow(/Failed to authenticate/);
    expect(s.fallbackStats().breakerOpenUntil).toBeGreaterThan(0); // B открыл окно Claude
    resolveSwitch!('claude');
    expect(await pA).toBe('qA');
    // Рубильник ответил 'claude' — без выбора план целиком строится через
    // normal(), которая смотрит на claudeWindowOpen() В МОМЕНТ построения, а
    // не до await: план, собранный по состоянию ДО открытия окна B, начался
    // бы с Claude (без env) — tokenOf(1) было бы undefined.
    expect(tokenOf(1)).toBe('sk-sp-test');
  });
});

/**
 * Суточный счёт без двойного учёта (ревью 01.11, R2): отказ CLI обычным
 * текстом («You've hit your … limit», «Not logged in») runRaw считает сбоем и
 * уходит к следующей модели. Событие такого запуска — ok: false, иначе один
 * вызов попадал бы в напоминании и в «ответила», и в «ответил другой».
 * Стоимость отказа в событии остаётся: суммы расхода ok не фильтруют.
 */
describe('ClaudeCliService — отказ текстом в событии claude_cli_call', () => {
  const LIMIT = "You've hit your session limit · resets 3am";

  it('json: рубильник Qwen, Qwen отказал текстом, ответил Claude — у Qwen ok:false (со стоимостью), у Claude ok:true', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const pg = pgMock();
    spawnMock
      .mockImplementationOnce(() => fakeProc(OK(LIMIT, 0.002)))
      .mockImplementationOnce(() => fakeProc(OK('c')));
    expect(await svc(pg, sw('qwen')).text('x')).toBe('c');
    expect(pg.query).toHaveBeenCalledTimes(2);
    expect(event(pg, 0)).toMatchObject({ provider: 'qwen', ok: false, cost_usd: 0.002, selected: 'qwen', choice: 'global' });
    expect(event(pg, 1)).toMatchObject({ provider: 'claude', ok: true, selected: 'qwen', choice: 'global' });
  });

  it('stream-json: то же — у Qwen ok:false, у Claude ok:true', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const pg = pgMock();
    spawnMock
      .mockImplementationOnce(() => fakeProc(streamOk(LIMIT, 0.002)))
      .mockImplementationOnce(() => fakeProc(streamOk('готово')));
    const r = await svc(pg, sw('qwen')).textWithCost('x', { onProgress: () => {} });
    expect(r.text).toBe('готово');
    expect(pg.query).toHaveBeenCalledTimes(2);
    expect(event(pg, 0)).toMatchObject({ provider: 'qwen', ok: false, cost_usd: 0.002, selected: 'qwen', choice: 'global' });
    expect(event(pg, 1)).toMatchObject({ provider: 'claude', ok: true, selected: 'qwen', choice: 'global' });
  });

  it('одна попытка (проба мониторинга) — отказ уходит вызывающему как есть, в событии ok:false', async () => {
    const pg = pgMock();
    spawnMock.mockImplementationOnce(() => fakeProc(OK(LIMIT, 0)));
    expect(await svc(pg, sw('claude')).text('probe', { noFallback: true })).toBe(LIMIT);
    expect(event(pg)).toMatchObject({ provider: 'claude', ok: false });
  });

  it('обычный ответ — ok:true', async () => {
    const pg = pgMock();
    spawnMock.mockImplementationOnce(() => fakeProc(OK('Здравствуйте')));
    expect(await svc(pg, sw('qwen')).text('x')).toBe('Здравствуйте');
    expect(event(pg)).toMatchObject({ provider: 'qwen', ok: true });
  });
});
