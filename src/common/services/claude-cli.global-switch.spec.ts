import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from '@nestjs/common';

jest.mock('child_process', () => ({ spawn: jest.fn() }));
import { spawn } from 'child_process';
import { ClaudeCliService } from './claude-cli.service';

/** Общий рубильник модели (spec 2026-10-31-global-llm-switch, разделы 1 и 3). */

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

const OK = (result: string, cost = 0.01) => JSON.stringify({ is_error: false, result, total_cost_usd: cost, duration_ms: 5 });
const QWEN_401 = JSON.stringify({ is_error: true, result: 'Failed to authenticate. API Error: 401 Invalid API-key provided.' });
/** Ключ i-го запуска; undefined — запуск Claude. */
const tokenOf = (i: number) => spawnMock.mock.calls[i][2]?.env?.ANTHROPIC_AUTH_TOKEN as string | undefined;
const pgMock = () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) });
const event = (pg: any) => JSON.parse(pg.query.mock.calls[0][1][0]);
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

  it('явный provider kimi при рубильнике Qwen — Kimi; choice user', async () => {
    const pg = pgMock();
    spawnMock.mockImplementationOnce(() => fakeProc(OK('k')));
    expect(await svc(pg, sw('qwen')).text('x', { provider: 'kimi' })).toBe('k');
    expect(tokenOf(0)).toBe('sk-kimi-test');
    expect(event(pg)).toMatchObject({ provider: 'kimi', selected: 'kimi', choice: 'user' });
  });

  it('noFallback без provider (проба мониторинга) — Claude, рубильник не читается', async () => {
    const global = sw('qwen');
    spawnMock.mockImplementationOnce(() => fakeProc(OK('c')));
    expect(await svc(undefined, global).text('x', { noFallback: true })).toBe('c');
    expect(tokenOf(0)).toBeUndefined();
    expect(global.get).not.toHaveBeenCalled();
  });

  it('noFallback с provider qwen (ход гостя) — только Qwen: его сбой — ошибка, Claude не пробуется', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    spawnMock.mockImplementationOnce(() => fakeProc(QWEN_401, 1));
    const s = svc(undefined, sw('claude'));
    await expect(s.text('x', { provider: 'qwen', noFallback: true })).rejects.toThrow(/401/);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(tokenOf(0)).toBe('sk-sp-test');
    // Сбой доступа выбранного — его окно «не отвечает»; окно Claude не трогается.
    expect(s.fallbackStats().providers.qwen.downUntil).toBeGreaterThan(0);
    expect(s.fallbackStats().breakerOpenUntil).toBe(0);
  });

  it('noFallback с provider kimi без ключа — Claude, один запуск', async () => {
    delete process.env.KIMI_FALLBACK_API_KEY;
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    spawnMock.mockImplementationOnce(() => fakeProc(OK('c')));
    expect(await svc().text('x', { provider: 'kimi', noFallback: true })).toBe('c');
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(tokenOf(0)).toBeUndefined();
  });

  it('рубильник Qwen, Qwen упал по доступу — ответ Claude (обычный путь), Qwen «не отвечает»', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    spawnMock
      .mockImplementationOnce(() => fakeProc(QWEN_401, 1))
      .mockImplementationOnce(() => fakeProc(OK('c')));
    const s = svc(undefined, sw('qwen'));
    expect(await s.text('x')).toBe('c');
    expect(tokenOf(0)).toBe('sk-sp-test');
    expect(tokenOf(1)).toBeUndefined();
    expect(s.fallbackStats().providers.qwen.downUntil).toBeGreaterThan(0);
  });

  it('рубильник Kimi без ключа — предупреждение «для всех» и обычный путь', async () => {
    delete process.env.KIMI_FALLBACK_API_KEY;
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    spawnMock.mockImplementationOnce(() => fakeProc(OK('c')));
    expect(await svc(undefined, sw('kimi')).text('x')).toBe('c');
    expect(tokenOf(0)).toBeUndefined();
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/Kimi выбран для всех \(рубильник\).*KIMI_FALLBACK_API_KEY/);
  });

  it('сервис рубильника бросает — Claude', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    spawnMock.mockImplementationOnce(() => fakeProc(OK('c')));
    const broken = { get: jest.fn(async () => { throw new Error('boom'); }) };
    expect(await svc(undefined, broken).text('x')).toBe('c');
    expect(tokenOf(0)).toBeUndefined();
  });

  it('без сервиса рубильника — как раньше: Claude', async () => {
    spawnMock.mockImplementationOnce(() => fakeProc(OK('c')));
    expect(await svc().text('x')).toBe('c');
    expect(tokenOf(0)).toBeUndefined();
  });
});
