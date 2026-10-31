import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from '@nestjs/common';

// Мокаем spawn ДО импорта сервиса: сервис берёт spawn из 'child_process' на
// уровне модуля.
jest.mock('child_process', () => ({ spawn: jest.fn() }));
import { spawn } from 'child_process';
import { ClaudeCliService } from './claude-cli.service';

/**
 * Цепочка запасных и выбор пользователя (spec 2026-10-31-kimi-provider-design.md):
 * Claude → Qwen → Kimi по сбою доступа; выбранный — первым, при его сбое —
 * обычный путь без него. Вызовы с MCP — в stream-json.
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
  setImmediate(() => {
    outH.forEach((cb) => cb(Buffer.from(stdout)));
    on['close']?.(code);
  });
  return proc;
}

function hangingProc() {
  return { stdout: { on: () => {} }, stderr: { on: () => {} }, on: () => {}, kill: () => {} } as any;
}

/** Процесс, который отвечает по команде finish() — для гонки двух вызовов. */
function deferredProc() {
  const outH: Array<(b: Buffer) => void> = [];
  const on: Record<string, (...a: any[]) => void> = {};
  const proc: any = {
    stdout: { on: (e: string, cb: any) => { if (e === 'data') outH.push(cb); } },
    stderr: { on: () => {} },
    on: (e: string, cb: any) => { on[e] = cb; },
    kill: () => {},
  };
  const finish = (stdout: string, code = 0) => {
    outH.forEach((cb) => cb(Buffer.from(stdout)));
    on['close']?.(code);
  };
  return { proc, finish };
}

const OK = (result: string, cost = 0.01) =>
  JSON.stringify({ is_error: false, result, total_cost_usd: cost, duration_ms: 5 });
const AUTH_FAIL = JSON.stringify({ is_error: true, result: 'Failed to authenticate: OAuth session expired and could not be refreshed' });
const QWEN_401 = JSON.stringify({ is_error: true, result: 'Failed to authenticate. API Error: 401 Invalid API-key provided.' });
const KIMI_401 = JSON.stringify({ is_error: true, result: 'Failed to authenticate. API Error: 401 Invalid Authentication' });
const lines = (...evs: object[]) => evs.map((e) => JSON.stringify(e)).join('\n') + '\n';
const streamOk = (result: string) => lines({ type: 'result', is_error: false, result, total_cost_usd: 0.01, duration_ms: 1 });

/** Ключ i-го запуска; undefined — запуск Claude (своего окружения нет). */
const tokenOf = (i: number) => spawnMock.mock.calls[i][2]?.env?.ANTHROPIC_AUTH_TOKEN as string | undefined;
const modelOf = (i: number) => {
  const a: string[] = spawnMock.mock.calls[i][1];
  return a[a.indexOf('--model') + 1];
};
const MCP = { products: { type: 'http' as const, url: 'http://127.0.0.1:1/mcp' } };

/** Сервис со своим корнем временных каталогов (см. claude-cli.argv.spec.ts). */
let roots: string[] = [];
function svcIn(pg?: any): ClaudeCliService {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-spec-root-'));
  roots.push(root);
  const svc = new ClaudeCliService(pg);
  (svc as any).tmpRoot = () => root;
  return svc;
}

const VARS = [
  'QWEN_FALLBACK_API_KEY', 'QWEN_FALLBACK_BASE_URL', 'QWEN_FALLBACK_BREAKER_MS',
  'QWEN_FALLBACK_MODEL_OPUS', 'QWEN_FALLBACK_MODEL_SONNET', 'QWEN_FALLBACK_MODEL_HAIKU',
  'KIMI_FALLBACK_API_KEY', 'KIMI_FALLBACK_BASE_URL',
  'KIMI_FALLBACK_MODEL_OPUS', 'KIMI_FALLBACK_MODEL_SONNET', 'KIMI_FALLBACK_MODEL_HAIKU',
  'LLM_FALLBACK_BREAKER_MS',
];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  spawnMock.mockReset();
  saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
  for (const k of VARS) delete process.env[k];
  process.env.QWEN_FALLBACK_API_KEY = 'sk-sp-test';
  process.env.KIMI_FALLBACK_API_KEY = 'sk-kimi-test';
});

afterEach(() => {
  for (const k of VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
  roots = [];
  jest.restoreAllMocks();
});

describe('ClaudeCliService — аварийная цепочка Claude → Qwen → Kimi', () => {
  it('Claude и Qwen упали по доступу — отвечает Kimi: его модель, адрес и ключ', async () => {
    const pg = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    spawnMock
      .mockImplementationOnce(() => fakeProc(AUTH_FAIL, 1))
      .mockImplementationOnce(() => fakeProc(QWEN_401, 1))
      .mockImplementationOnce(() => fakeProc(OK('ок от kimi', 0.02)));
    const svc = new ClaudeCliService(pg as any);
    const r = await svc.textWithCost('привет', { model: 'claude-opus-5-5' });
    expect(r).toEqual({ text: 'ок от kimi', costUsd: 0.02 });
    expect(spawnMock).toHaveBeenCalledTimes(3);
    expect(tokenOf(0)).toBeUndefined();
    expect(tokenOf(1)).toBe('sk-sp-test');
    expect(tokenOf(2)).toBe('sk-kimi-test');
    expect(modelOf(2)).toBe('k3.1-pro');
    expect(spawnMock.mock.calls[2][2].env.ANTHROPIC_BASE_URL).toBe('https://api.kimi.ai/coding');
    expect(svc.fallbackStats().providers).toMatchObject({ qwen: { ok: 0, failed: 1 }, kimi: { ok: 1, failed: 0 } });
    // Авария без выбора пользователя — событие не содержит selected вовсе
    // (не undefined: JSON.stringify роняет такие ключи сам, но лучше проверить явно).
    const event = JSON.parse(pg.query.mock.calls[0][1][0]);
    expect(event).toMatchObject({ provider: 'kimi', fallback: true });
    expect(event).not.toHaveProperty('selected');
  });

  it('без ключа Qwen — сразу Kimi', async () => {
    delete process.env.QWEN_FALLBACK_API_KEY;
    spawnMock
      .mockImplementationOnce(() => fakeProc(AUTH_FAIL, 1))
      .mockImplementationOnce(() => fakeProc(OK('k')));
    await expect(new ClaudeCliService().text('x')).resolves.toBe('k');
    expect(tokenOf(1)).toBe('sk-kimi-test');
  });

  it('Qwen упал не по доступу (таймаут) — Kimi не пробуется, окно Claude закрыто, Qwen не «не отвечает»', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeProc(AUTH_FAIL, 1))
      .mockImplementationOnce(() => hangingProc())
      .mockImplementationOnce(() => fakeProc(OK('c')));
    const svc = new ClaudeCliService();
    // 200 мс: подставной ответ Claude приходит на следующем тике, задолго до
    // таймаута; висящий Qwen получает весь бюджет (он меньше минуты) и упирается в него.
    const err = await svc.text('x', { timeoutMs: 200 }).catch((e) => e);
    expect(err.message).toMatch(/^claude CLI exited with code 1: Failed to authenticate.* \| qwen fallback: claude CLI timeout/);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(svc.fallbackStats().breakerOpenUntil).toBe(0);
    expect(svc.fallbackStats().providers.qwen.downUntil).toBe(0);
    await expect(svc.text('y')).resolves.toBe('c');
    expect(tokenOf(2)).toBeUndefined();
  });

  it('упали все — причины по порядку; окно Claude закрыто; Qwen и Kimi «не отвечают»', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeProc(AUTH_FAIL, 1))
      .mockImplementationOnce(() => fakeProc(QWEN_401, 1))
      .mockImplementationOnce(() => fakeProc(KIMI_401, 1))
      .mockImplementationOnce(() => fakeProc(OK('c')));
    const svc = new ClaudeCliService();
    const err = await svc.text('x').catch((e) => e);
    expect(err.message).toMatch(/^claude CLI exited with code 1: Failed to authenticate.* \| qwen fallback: .*401.* \| kimi fallback: .*401/);
    const st = svc.fallbackStats();
    expect(st).toMatchObject({ ok: 0, failed: 2, breakerOpenUntil: 0 });
    expect(st.providers.qwen.downUntil).toBeGreaterThan(0);
    expect(st.providers.kimi.downUntil).toBeGreaterThan(0);
    // Следующий вызов: оба запасных «не отвечают» — только Claude.
    await expect(svc.text('y')).resolves.toBe('c');
    expect(tokenOf(3)).toBeUndefined();
  });

  it('окно Claude открыто: Qwen упал — Kimi в том же вызове; окно остаётся открытым', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeProc(AUTH_FAIL, 1)) // вызов 1: Claude падает → окно
      .mockImplementationOnce(() => fakeProc(OK('q1')))     // вызов 1: Qwen
      .mockImplementationOnce(() => fakeProc(QWEN_401, 1)) // вызов 2: окно — Qwen падает
      .mockImplementationOnce(() => fakeProc(OK('k2')))     // вызов 2: Kimi
      .mockImplementationOnce(() => fakeProc(OK('k3')));    // вызов 3: Qwen «не отвечает» — сразу Kimi
    const svc = new ClaudeCliService();
    expect(await svc.text('1')).toBe('q1');
    expect(await svc.text('2')).toBe('k2');
    expect(await svc.text('3')).toBe('k3');
    expect(tokenOf(4)).toBe('sk-kimi-test');
    expect(svc.fallbackStats().breakerOpenUntil).toBeGreaterThan(0);
  });

  it('отказ текстом от запасного (Qwen) — отвечает Kimi; Qwen «не отвечает», failed растёт', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeProc(AUTH_FAIL, 1))                                        // вызов 1: Claude падает → окно
      .mockImplementationOnce(() => fakeProc(OK('q1')))                                             // вызов 1: Qwen
      .mockImplementationOnce(() => fakeProc(OK("You've hit your session limit · resets 3am", 0)))  // вызов 2: Qwen — отказ текстом
      .mockImplementationOnce(() => fakeProc(OK('k')));                                             // вызов 2: Kimi
    const svc = new ClaudeCliService();
    await svc.text('1');
    expect(await svc.text('2')).toBe('k');
    const st = svc.fallbackStats();
    expect(st.providers.qwen.downUntil).toBeGreaterThan(0);
    expect(st.providers.qwen.failed).toBe(1);
  });

  it('параллельный вызов уронил Qwen — следующая попытка A идёт в Kimi, а не в Qwen', async () => {
    const a = deferredProc();
    spawnMock
      .mockImplementationOnce(() => a.proc)                 // вызов A: Claude висит
      .mockImplementationOnce(() => fakeProc(QWEN_401, 1))   // вызов B (provider: qwen): падает
      .mockImplementationOnce(() => fakeProc(OK('cB')))      // вызов B: Claude
      .mockImplementationOnce(() => fakeProc(OK('kA')));     // вызов A (после AUTH_FAIL): план знал только про Claude/Qwen/Kimi — но Qwen к этому моменту «не отвечает» (уронил B), поэтому Kimi
    const svc = new ClaudeCliService();
    const pA = svc.text('A');
    expect(spawnMock).toHaveBeenCalledTimes(1); // A висит на Claude
    expect(await svc.text('B', { provider: 'qwen' })).toBe('cB');
    expect(svc.fallbackStats().providers.qwen.downUntil).toBeGreaterThan(0); // B уронил Qwen
    a.finish(AUTH_FAIL, 1);
    expect(await pA).toBe('kA');
    expect(tokenOf(3)).toBe('sk-kimi-test');
  });
});

describe('ClaudeCliService — выбор пользователя Kimi', () => {
  const pgMock = () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) });
  const event = (pg: any, i = 0) => JSON.parse(pg.query.mock.calls[i][1][0]);

  it('сразу Kimi: один запуск; событие provider kimi, selected kimi, fallback false', async () => {
    const pg = pgMock();
    spawnMock.mockImplementationOnce(() => fakeProc(OK('ответ kimi', 0.03)));
    const r = await new ClaudeCliService(pg as any).textWithCost('x', { model: 'claude-opus-5-5', provider: 'kimi' });
    expect(r).toEqual({ text: 'ответ kimi', costUsd: 0.03 });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(tokenOf(0)).toBe('sk-kimi-test');
    expect(event(pg)).toMatchObject({ provider: 'kimi', fallback: false, selected: 'kimi', model: 'k3.1-pro' });
  });

  it('выбранный упал (401) — ответ через Claude; окно Claude не открыто, аварийные счётчики не растут, Kimi «не отвечает»', async () => {
    const pg = pgMock();
    spawnMock
      .mockImplementationOnce(() => fakeProc(KIMI_401, 1))
      .mockImplementationOnce(() => fakeProc(OK('c')));
    const svc = new ClaudeCliService(pg as any);
    expect(await svc.text('x', { provider: 'kimi' })).toBe('c');
    expect(tokenOf(1)).toBeUndefined();
    const st = svc.fallbackStats();
    expect(st).toMatchObject({ ok: 0, failed: 0, breakerOpenUntil: 0 });
    expect(st.providers.kimi.downUntil).toBeGreaterThan(0);
    expect(event(pg)).toMatchObject({ provider: 'claude', fallback: false, selected: 'kimi' });
  });

  it('выбранный упал не по доступу (кривой JSON) — тоже Claude', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeProc('not json', 0))
      .mockImplementationOnce(() => fakeProc(OK('c')));
    const svc = new ClaudeCliService();
    expect(await svc.text('x', { provider: 'kimi' })).toBe('c');
    expect(svc.fallbackStats().providers.kimi.downUntil).toBe(0);
  });

  it('отказ текстом от выбранного (Kimi) — отвечает Claude; аварийные счётчики не растут', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeProc(OK("You've hit your session limit · resets 3am", 0)))
      .mockImplementationOnce(() => fakeProc(OK('c')));
    const svc = new ClaudeCliService();
    expect(await svc.text('x', { provider: 'kimi' })).toBe('c');
    expect(svc.fallbackStats()).toMatchObject({ ok: 0, failed: 0, breakerOpenUntil: 0 });
  });

  it('выбранный и Claude упали — Qwen (аварийно): событие fallback true, selected kimi', async () => {
    const pg = pgMock();
    spawnMock
      .mockImplementationOnce(() => fakeProc(KIMI_401, 1))
      .mockImplementationOnce(() => fakeProc(AUTH_FAIL, 1))
      .mockImplementationOnce(() => fakeProc(OK('q')));
    const svc = new ClaudeCliService(pg as any);
    expect(await svc.text('x', { provider: 'kimi' })).toBe('q');
    expect(tokenOf(2)).toBe('sk-sp-test');
    expect(event(pg)).toMatchObject({ provider: 'qwen', fallback: true, selected: 'kimi' });
    expect(svc.fallbackStats().breakerOpenUntil).toBeGreaterThan(0);
  });

  it('упали все — ошибка начинается с выбранного', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeProc(KIMI_401, 1))
      .mockImplementationOnce(() => fakeProc(AUTH_FAIL, 1))
      .mockImplementationOnce(() => fakeProc(QWEN_401, 1));
    const svc = new ClaudeCliService();
    const err = await svc.text('x', { provider: 'kimi' }).catch((e) => e);
    expect(err.message).toMatch(/^kimi \(выбран\): .*401.* \| claude fallback: .*Failed to authenticate.* \| qwen fallback: .*401/);
    const st = svc.fallbackStats();
    expect(st.breakerOpenUntil).toBe(0);
    expect(st.providers.kimi.downUntil).toBeGreaterThan(0);
    expect(st.providers.qwen.downUntil).toBeGreaterThan(0);
  });

  it('выбранный при открытом окне Claude: его сбой — сразу Qwen, без попытки Claude', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeProc(AUTH_FAIL, 1)) // вызов 1 (без выбора): Claude падает → окно
      .mockImplementationOnce(() => fakeProc(OK('q1')))     // вызов 1: Qwen
      .mockImplementationOnce(() => fakeProc(KIMI_401, 1)) // вызов 2 (выбран Kimi): падает
      .mockImplementationOnce(() => fakeProc(OK('q2')));    // вызов 2: Qwen
    const svc = new ClaudeCliService();
    await svc.text('1');
    expect(await svc.text('2', { provider: 'kimi' })).toBe('q2');
    expect(spawnMock).toHaveBeenCalledTimes(4);
    expect(tokenOf(3)).toBe('sk-sp-test');
  });

  it('выбранный «не отвечает» — всё равно первый; его успех снимает «не отвечает»', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeProc(KIMI_401, 1))
      .mockImplementationOnce(() => fakeProc(OK('c1')))
      .mockImplementationOnce(() => fakeProc(OK('k2')));
    const svc = new ClaudeCliService();
    await svc.text('1', { provider: 'kimi' });
    expect(await svc.text('2', { provider: 'kimi' })).toBe('k2');
    expect(tokenOf(2)).toBe('sk-kimi-test');
    expect(svc.fallbackStats().providers.kimi.downUntil).toBe(0);
  });

  it('без ключа Kimi — предупреждение и обычный путь', async () => {
    delete process.env.KIMI_FALLBACK_API_KEY;
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    spawnMock.mockImplementationOnce(() => fakeProc(OK('c')));
    expect(await new ClaudeCliService().text('x', { provider: 'kimi' })).toBe('c');
    expect(tokenOf(0)).toBeUndefined();
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/Kimi выбран.*KIMI_FALLBACK_API_KEY/);
  });

  it('выбранный успел вызвать инструмент с последствиями — не повторяем', async () => {
    spawnMock.mockImplementationOnce(() => fakeProc(lines(
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__products__manage_product', input: {} }] } },
      { type: 'result', is_error: true, result: 'API Error: 500 Internal' },
    ), 1));
    const err = await new ClaudeCliService().textWithCost('x', { provider: 'kimi', onProgress: () => {} }).catch((e) => e);
    expect(err.message).toMatch(/^kimi \(выбран\): /);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});

describe('ClaudeCliService — вызовы с MCP идут в stream-json', () => {
  it('без onProgress — stream-json и --verbose, ответ из result', async () => {
    spawnMock.mockImplementationOnce(() => fakeProc(streamOk('ок')));
    expect(await svcIn().text('x', { mcpServers: MCP })).toBe('ок');
    const a: string[] = spawnMock.mock.calls[0][1];
    expect(a[a.indexOf('--output-format') + 1]).toBe('stream-json');
    expect(a).toContain('--verbose');
    expect(a).not.toContain('--include-partial-messages');
  });

  it('как у Маши: сбой входа до инструментов — Qwen', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeProc(lines({ type: 'result', is_error: true, result: 'Failed to authenticate: OAuth session expired' }), 1))
      .mockImplementationOnce(() => fakeProc(streamOk('q')));
    expect(await svcIn().text('x', { mcpServers: MCP })).toBe('q');
    expect(tokenOf(1)).toBe('sk-sp-test');
  });

  it('как у Маши: выбран Kimi, упал до инструментов — Claude', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeProc(lines({ type: 'result', is_error: true, result: 'Failed to authenticate. API Error: 401' }), 1))
      .mockImplementationOnce(() => fakeProc(streamOk('c')));
    expect(await svcIn().text('x', { mcpServers: MCP, provider: 'kimi' })).toBe('c');
    expect(tokenOf(0)).toBe('sk-kimi-test');
    expect(tokenOf(1)).toBeUndefined();
  });

  it('инструмент MCP с последствиями до сбоя — не повторяем', async () => {
    spawnMock.mockImplementationOnce(() => fakeProc(lines(
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__products__manage_product', input: {} }] } },
      { type: 'result', is_error: true, result: 'API Error: 529 Overloaded' },
    ), 1));
    await expect(svcIn().text('x', { mcpServers: MCP })).rejects.toThrow('529');
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});

describe('ClaudeCliService.fallbackStats — по провайдерам', () => {
  it('enabled у каждого по своему ключу; общий enabled — хоть один', () => {
    delete process.env.QWEN_FALLBACK_API_KEY;
    const st = new ClaudeCliService().fallbackStats();
    expect(st).toMatchObject({ enabled: true, ok: 0, failed: 0, breakerOpenUntil: 0, windowMs: 15 * 60_000 });
    expect(st.providers).toEqual({
      qwen: { enabled: false, ok: 0, failed: 0, downUntil: 0 },
      kimi: { enabled: true, ok: 0, failed: 0, downUntil: 0 },
    });
    delete process.env.KIMI_FALLBACK_API_KEY;
    expect(new ClaudeCliService().fallbackStats().enabled).toBe(false);
  });
});
