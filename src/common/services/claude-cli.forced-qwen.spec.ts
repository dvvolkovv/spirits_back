jest.mock('child_process', () => ({ spawn: jest.fn() }));
import { spawn } from 'child_process';
import { Logger } from '@nestjs/common';
import { ClaudeCliService } from './claude-cli.service';

/**
 * Выбор пользователя «Qwen» (админка, spec 2026-10-30-llm-provider-switch и
 * 2026-10-31-kimi-provider-design): вызов сразу на Qwen, при его сбое — обычный
 * путь (Claude, затем запасные без него). Это не авария — окно Claude и
 * аварийные счётчики не трогаются, событие помечено fallback: false, selected.
 */

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
const hasEnv = (i: number) => spawnMock.mock.calls[i][2]?.env !== undefined;
const envOf = (i: number) => spawnMock.mock.calls[i][2]?.env as NodeJS.ProcessEnv | undefined;
const modelOf = (i: number) => { const a: string[] = spawnMock.mock.calls[i][1]; return a[a.indexOf('--model') + 1]; };

const OLD = process.env.QWEN_FALLBACK_API_KEY;
const OLD_KIMI = process.env.KIMI_FALLBACK_API_KEY;
beforeEach(() => {
  spawnMock.mockReset();
  process.env.QWEN_FALLBACK_API_KEY = 'sk-sp-test';
  delete process.env.KIMI_FALLBACK_API_KEY; // цепочка с Kimi — claude-cli.chain.spec.ts
});
afterEach(() => {
  if (OLD === undefined) delete process.env.QWEN_FALLBACK_API_KEY; else process.env.QWEN_FALLBACK_API_KEY = OLD;
  if (OLD_KIMI === undefined) delete process.env.KIMI_FALLBACK_API_KEY; else process.env.KIMI_FALLBACK_API_KEY = OLD_KIMI;
  jest.restoreAllMocks();
});

describe('ClaudeCliService — provider: qwen', () => {
  it('сразу Qwen: один spawn, модель и окружение Alibaba', async () => {
    spawnMock.mockImplementationOnce(() => fakeProc(OK('ответ qwen', 0.03)));
    const r = await new ClaudeCliService().textWithCost('x', { model: 'claude-opus-5-5', provider: 'qwen' });
    expect(r).toEqual({ text: 'ответ qwen', costUsd: 0.03 });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(modelOf(0)).toBe('qwen3.8-max');
    expect(envOf(0)?.ANTHROPIC_AUTH_TOKEN).toBe('sk-sp-test');
  });

  it('без ключа — Claude и предупреждение', async () => {
    delete process.env.QWEN_FALLBACK_API_KEY;
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    spawnMock.mockImplementationOnce(() => fakeProc(OK('claude')));
    expect(await new ClaudeCliService().text('x', { provider: 'qwen' })).toBe('claude');
    expect(hasEnv(0)).toBe(false);
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/Qwen выбран.*ключ/);
  });

  it('noFallback побеждает: проба — только Claude', async () => {
    spawnMock.mockImplementationOnce(() => fakeProc(OK('claude')));
    await new ClaudeCliService().text('x', { provider: 'qwen', noFallback: true });
    expect(hasEnv(0)).toBe(false);
  });

  it('окно предохранителя и fallbackStats не трогаются', async () => {
    spawnMock.mockImplementationOnce(() => fakeProc(OK('q'))).mockImplementationOnce(() => fakeProc(OK('c')));
    const svc = new ClaudeCliService();
    await svc.text('x', { provider: 'qwen' });
    expect(svc.fallbackStats()).toMatchObject({ ok: 0, failed: 0, breakerOpenUntil: 0 });
    await svc.text('y'); // обычный вызов — на Claude
    expect(hasEnv(1)).toBe(false);
  });

  it('сбой выбранного Qwen — ответ через Claude; окно Claude не открыто, аварийные счётчики не растут', async () => {
    spawnMock.mockImplementationOnce(() => fakeProc(QWEN_401, 1)).mockImplementationOnce(() => fakeProc(OK('c')));
    const svc = new ClaudeCliService();
    expect(await svc.text('x', { provider: 'qwen' })).toBe('c');
    expect(hasEnv(1)).toBe(false);
    expect(svc.fallbackStats()).toMatchObject({ ok: 0, failed: 0, breakerOpenUntil: 0 });
  });

  it('событие: provider qwen, fallback false', async () => {
    const pg = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    spawnMock.mockImplementationOnce(() => fakeProc(OK('q')));
    await new ClaudeCliService(pg as any).text('x', { model: 'claude-opus-5-5', provider: 'qwen' });
    expect(JSON.parse(pg.query.mock.calls[0][1][0])).toMatchObject({ provider: 'qwen', fallback: false, selected: 'qwen', model: 'qwen3.8-max' });
  });
});
