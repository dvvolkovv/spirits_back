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
 * Запасной путь на Qwen (spec 2026-10-29-qwen-fallback-design.md): когда вызов
 * Claude падает по входу/лимиту/перегрузке и модель ещё ничего не сделала
 * инструментами, тот же вызов повторяется тем же бинарём с моделью Qwen и
 * окружением Alibaba. Проверки живости (noFallback) — только Claude.
 */

const spawnMock = spawn as unknown as jest.Mock;

/** Фейковый процесс: на следующем тике отдаёт stdout и закрывается с кодом code. */
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

/** Процесс, который не отвечает никогда (для таймаута). */
function hangingProc() {
  return {
    stdout: { on: () => {} },
    stderr: { on: () => {} },
    on: () => {},
    kill: () => {},
  } as any;
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
// Так CLI 2.1.280 отвечает при протухшем OAuth: код 1, JSON с is_error в stdout.
const AUTH_FAIL = JSON.stringify({ is_error: true, result: 'Failed to authenticate: OAuth session expired and could not be refreshed' });
const LIMIT_FAIL = JSON.stringify({ is_error: true, result: "You've hit your weekly limit · resets Nov 3" });
const QWEN_401 = JSON.stringify({ is_error: true, result: 'Failed to authenticate. API Error: 401 Invalid API-key provided.' });
const lines = (...evs: object[]) => evs.map((e) => JSON.stringify(e)).join('\n') + '\n';

/** env и --model i-го вызова spawn. */
const spawnEnv = (i: number) => spawnMock.mock.calls[i][2]?.env as NodeJS.ProcessEnv | undefined;
/** Получил ли i-й вызов spawn своё окружение. Булево — чтобы при провале jest
 *  не печатал в лог CI всю копию process.env. */
const hasEnv = (i: number) => spawnMock.mock.calls[i][2]?.env !== undefined;
const spawnModel = (i: number) => {
  const a: string[] = spawnMock.mock.calls[i][1];
  return a[a.indexOf('--model') + 1];
};
const withoutModel = (a: string[]) => {
  const c = [...a];
  c.splice(c.indexOf('--model'), 2);
  return c;
};
/** Путь конфига MCP в argv (или undefined). */
const mcpConfigPath = (a: string[]) => {
  const i = a.indexOf('--mcp-config');
  return i >= 0 ? a[i + 1] : undefined;
};
const MCP = { products: { type: 'http' as const, url: 'http://127.0.0.1:1/mcp' } };

/**
 * Сервис со своим корнем временных каталогов: настоящий
 * <tmpdir>/linkeon-claude-empty может быть занят живым сервисом на той же
 * машине (см. claude-cli.argv.spec.ts). Корни снимаются в afterEach.
 */
let roots: string[] = [];
function svcIn(pg?: any): { svc: ClaudeCliService; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fallback-spec-root-'));
  roots.push(root);
  const svc = new ClaudeCliService(pg);
  (svc as any).tmpRoot = () => root;
  return { svc, root };
}

const VARS = [
  'QWEN_FALLBACK_API_KEY', 'QWEN_FALLBACK_BASE_URL', 'QWEN_FALLBACK_BREAKER_MS',
  'QWEN_FALLBACK_MODEL_OPUS', 'QWEN_FALLBACK_MODEL_SONNET', 'QWEN_FALLBACK_MODEL_HAIKU',
];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  spawnMock.mockReset();
  saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
  for (const k of VARS) delete process.env[k];
  process.env.QWEN_FALLBACK_API_KEY = 'sk-sp-test';
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

describe('ClaudeCliService — запасной путь на Qwen', () => {
  it('сбой входа Claude → тот же вызов на Qwen: модель и окружение Alibaba, ответ и цена — от Qwen', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeProc(AUTH_FAIL, 1))
      .mockImplementationOnce(() => fakeProc(OK('ок от qwen', 0.02)));
    const svc = new ClaudeCliService();

    const r = await svc.textWithCost('привет', { model: 'claude-opus-5-5' });

    expect(r).toEqual({ text: 'ок от qwen', costUsd: 0.02 });
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnModel(0)).toBe('claude-opus-5-5');
    expect(hasEnv(0)).toBe(false);
    expect(spawnModel(1)).toBe('qwen3.8-max');
    expect(spawnEnv(1)?.ANTHROPIC_AUTH_TOKEN).toBe('sk-sp-test');
    expect(spawnEnv(1)?.CLAUDE_CODE_MAX_RETRIES).toBe('1');
    // Кроме модели — те же argv: промпт, --tools, --allowedTools, формат вывода.
    expect(withoutModel(spawnMock.mock.calls[1][1])).toEqual(withoutModel(spawnMock.mock.calls[0][1]));
  });

  it('недельный лимит (is_error при коде 0) — тоже переключает', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeProc(LIMIT_FAIL, 0))
      .mockImplementationOnce(() => fakeProc(OK('q')));
    await expect(new ClaudeCliService().text('x')).resolves.toBe('q');
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('модель по умолчанию (haiku) → qwen3.6-flash; переопределение из env', async () => {
    process.env.QWEN_FALLBACK_MODEL_HAIKU = 'my-flash';
    spawnMock
      .mockImplementationOnce(() => fakeProc(AUTH_FAIL, 1))
      .mockImplementationOnce(() => fakeProc(OK('q')));
    await new ClaudeCliService().text('x');
    expect(spawnModel(1)).toBe('my-flash');
  });

  it('без ключа — запасного пути нет, ошибка исходная', async () => {
    delete process.env.QWEN_FALLBACK_API_KEY;
    spawnMock.mockImplementationOnce(() => fakeProc(AUTH_FAIL, 1));
    await expect(new ClaudeCliService().text('x')).rejects.toThrow('Failed to authenticate: OAuth');
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['rate_limit', 'API Error: 429 Too Many Requests'],
    ['overloaded', 'API Error: 529 Overloaded'],
  ])('%s у Claude — тоже переключает', async (_kind, result) => {
    spawnMock
      .mockImplementationOnce(() => fakeProc(JSON.stringify({ is_error: true, result }), 1))
      .mockImplementationOnce(() => fakeProc(OK('q')));
    await expect(new ClaudeCliService().text('x')).resolves.toBe('q');
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnEnv(1)?.ANTHROPIC_AUTH_TOKEN).toBe('sk-sp-test');
  });

  it('таймаут Claude — не переключает и окна не открывает', async () => {
    spawnMock.mockImplementationOnce(() => hangingProc());
    const svc = new ClaudeCliService();
    await expect(svc.text('x', { timeoutMs: 5 })).rejects.toThrow('timeout');
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(svc.fallbackStats().breakerOpenUntil).toBe(0);
  });

  it('прочая ошибка (кривой JSON) — не переключает и окна не открывает', async () => {
    spawnMock.mockImplementationOnce(() => fakeProc('not json', 0));
    const svc = new ClaudeCliService();
    await expect(svc.text('x')).rejects.toThrow('invalid JSON');
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(svc.fallbackStats().breakerOpenUntil).toBe(0);
  });

  it('переключение — в warn, с моделью Qwen и видом сбоя', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    spawnMock
      .mockImplementationOnce(() => fakeProc(AUTH_FAIL, 1))
      .mockImplementationOnce(() => fakeProc(OK('q')));
    await new ClaudeCliService().text('x', { model: 'claude-sonnet-4-6' });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(
      /^claude CLI → запасной Qwen qwen3\.8-flash \(auth\): claude CLI exited with code 1: Failed to authenticate/,
    ));
  });

  it('запасной вызов получает остаток бюджета timeoutMs, а не полный', async () => {
    let now = 2_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const timers = jest.spyOn(global, 'setTimeout');
    spawnMock
      .mockImplementationOnce(() => { now += 30_000; return fakeProc(AUTH_FAIL, 1); }) // попытка Claude «длилась» 30 с
      .mockImplementationOnce(() => fakeProc(OK('q')));
    await expect(new ClaudeCliService().text('x', { timeoutMs: 100_000 })).resolves.toBe('q');
    const delays = timers.mock.calls.map((c) => c[1]);
    expect(delays).toContain(100_000); // Claude — весь бюджет
    expect(delays).toContain(70_000);  // Qwen — остаток
    expect(delays.filter((d) => d === 100_000)).toHaveLength(1);
  });

  it('noFallback — только Claude; его сбой предохранитель не открывает', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeProc(AUTH_FAIL, 1))
      .mockImplementationOnce(() => fakeProc(OK('claude')));
    const svc = new ClaudeCliService();
    await expect(svc.text('probe', { noFallback: true })).rejects.toThrow('Failed to authenticate');
    expect(spawnMock).toHaveBeenCalledTimes(1);
    // следующий обычный вызов пробует Claude, а не идёт сразу на Qwen
    await expect(svc.text('y')).resolves.toBe('claude');
    expect(hasEnv(1)).toBe(false);
  });

  it('модель успела вызвать инструмент до сбоя — не переключает (инструмент сработал бы дважды)', async () => {
    spawnMock.mockImplementationOnce(() => fakeProc(lines(
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__products__manage_product', input: {} }] } },
      { type: 'result', is_error: true, result: 'API Error: 529 Overloaded' },
    ), 1));
    await expect(new ClaudeCliService().textWithCost('x', { onProgress: () => {} })).rejects.toThrow('529');
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('stream-json: до сбоя был только WebSearch (без последствий) — переключает; onProgress видит его', async () => {
    const seen: string[] = [];
    spawnMock
      .mockImplementationOnce(() => fakeProc(lines(
        { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'WebSearch', input: {} }] } },
        { type: 'result', is_error: true, result: 'API Error: 429 Too Many Requests' },
      ), 1))
      .mockImplementationOnce(() => fakeProc(lines(
        { type: 'result', is_error: false, result: 'q', total_cost_usd: 0.01, duration_ms: 2 },
      )));
    await expect(new ClaudeCliService().text('x', { tools: 'WebSearch', onProgress: (e) => seen.push(e.name) }))
      .resolves.toBe('q');
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnEnv(1)?.ANTHROPIC_AUTH_TOKEN).toBe('sk-sp-test');
    expect(seen).toEqual(['WebSearch']);
  });

  it('вызов с MCP без stream-json — не переключает (вызов инструмента не виден)', async () => {
    spawnMock.mockImplementationOnce(() => fakeProc(AUTH_FAIL, 1));
    await expect(svcIn().svc.text('x', { mcpServers: MCP })).rejects.toThrow('Failed to authenticate');
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it.each(['Read,Bash', 'default', 'Bash(git:*)'])(
    'json-режим с tools %p (не только Read/WebSearch/WebFetch) — не переключает (вызов тула не виден)',
    async (tools) => {
      spawnMock.mockImplementationOnce(() => fakeProc(AUTH_FAIL, 1));
      await expect(new ClaudeCliService().text('x', { tools })).rejects.toThrow('Failed to authenticate');
      expect(spawnMock).toHaveBeenCalledTimes(1);
    },
  );

  it('json-режим с Read/WebSearch/WebFetch — переключает (последствий у них нет)', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeProc(AUTH_FAIL, 1))
      .mockImplementationOnce(() => fakeProc(OK('q')));
    await expect(new ClaudeCliService().text('x', { tools: 'Read,WebSearch,WebFetch' })).resolves.toBe('q');
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('как у Маши (MCP + stream-json): у запасного запуска свой конфиг MCP, конфиг упавшей попытки уже снят', async () => {
    const { svc, root } = svcIn();
    const seen: { p1?: string; p2?: string; p2Exists?: boolean; dir1Exists?: boolean } = {};
    spawnMock
      .mockImplementationOnce((_b: string, a: string[]) => {
        seen.p1 = mcpConfigPath(a);
        return fakeProc(lines({ type: 'result', is_error: true, result: 'Failed to authenticate: OAuth session expired' }), 1);
      })
      .mockImplementationOnce((_b: string, a: string[]) => {
        seen.p2 = mcpConfigPath(a);
        seen.p2Exists = !!seen.p2 && fs.existsSync(seen.p2);
        seen.dir1Exists = !!seen.p1 && fs.existsSync(path.dirname(seen.p1));
        return fakeProc(lines({ type: 'result', is_error: false, result: 'готово', total_cost_usd: 0.01, duration_ms: 3 }));
      });

    const r = await svc.textWithCost('x', {
      mcpServers: MCP,
      allowedTools: 'mcp__products__manage_product',
      onProgress: () => {},
    });

    expect(r.text).toBe('готово');
    expect(spawnEnv(1)?.ANTHROPIC_AUTH_TOKEN).toBe('sk-sp-test');
    expect(seen.p1).toBeTruthy();
    expect(seen.p2).toBeTruthy();
    expect(seen.p2).not.toBe(seen.p1);
    expect(seen.p2Exists).toBe(true);   // конфиг запасного запуска на месте
    expect(seen.dir1Exists).toBe(false); // каталог упавшей попытки к этому моменту снят
    // После вызова — ни одного каталога с токенами, только постоянный пустой cwd.
    expect(fs.readdirSync(root)).toEqual(['linkeon-claude-empty']);
  });

  it('stream-json: сбой входа до инструментов → Qwen, onProgress видит его инструменты', async () => {
    const seen: string[] = [];
    spawnMock
      .mockImplementationOnce(() => fakeProc(lines({ type: 'result', is_error: true, result: 'Failed to authenticate: OAuth session expired' }), 1))
      .mockImplementationOnce(() => fakeProc(lines(
        { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: {} }] } },
        { type: 'result', is_error: false, result: 'готово', total_cost_usd: 0.03, duration_ms: 7 },
      )));
    const r = await new ClaudeCliService().textWithCost('x', { onProgress: (e) => seen.push(e.name) });
    expect(r).toEqual({ text: 'готово', costUsd: 0.03 });
    expect(seen).toEqual(['Read']);
    expect(spawnEnv(1)?.ANTHROPIC_AUTH_TOKEN).toBe('sk-sp-test');
  });

  it('упали оба — в ошибке обе причины, Claude первой', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeProc(AUTH_FAIL, 1))
      .mockImplementationOnce(() => fakeProc(QWEN_401, 1));
    const err = await new ClaudeCliService().text('x').catch((e) => e);
    expect(err.message).toMatch(
      /^claude CLI exited with code 1: Failed to authenticate: OAuth.* \| qwen fallback: claude CLI exited with code 1: Failed to authenticate\. API Error: 401/,
    );
  });

  it('упали оба — окно закрыто: следующий вызов снова пробует Claude', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeProc(AUTH_FAIL, 1))
      .mockImplementationOnce(() => fakeProc(QWEN_401, 1))
      .mockImplementationOnce(() => fakeProc(OK('c')));
    const svc = new ClaudeCliService();
    await expect(svc.text('1')).rejects.toThrow('qwen fallback');
    expect(await svc.text('2')).toBe('c');
    expect(hasEnv(2)).toBe(false);
  });

  it('событие claude_cli_call помечено provider и fallback', async () => {
    const pg = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    spawnMock
      .mockImplementationOnce(() => fakeProc(AUTH_FAIL, 1))
      .mockImplementationOnce(() => fakeProc(OK('q')))
      .mockImplementationOnce(() => fakeProc(OK('c')));
    const svc = new ClaudeCliService(pg as any);
    await svc.text('x', { model: 'claude-opus-5-5' });
    expect(JSON.parse(pg.query.mock.calls[0][1][0])).toMatchObject({
      model: 'qwen3.8-max', provider: 'qwen', fallback: true, ok: true,
    });
    await svc.text('probe', { noFallback: true }); // успех Claude
    expect(JSON.parse(pg.query.mock.calls[1][1][0])).toMatchObject({
      model: 'claude-haiku-4-5', provider: 'claude', fallback: false,
    });
  });
});

/**
 * Отказ CLI, пришедший обычным ответом (без is_error): «You've hit your session
 * limit» бывал и так (см. FATAL_RE релея, looksCliFailure чата). С ключом это
 * такой же сбой доступа, как ошибка; без ключа — вызывающий получает тот же
 * текст, что и раньше.
 */
describe('ClaudeCliService — отказ CLI, пришедший обычным ответом', () => {
  const SESSION_LIMIT = "You've hit your session limit · resets 3am";
  const streamOk = (result: string, cost = 0) =>
    lines({ type: 'result', is_error: false, result, total_cost_usd: cost, duration_ms: 1 });

  it('json: is_error:false с текстом лимита → Qwen', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeProc(OK(SESSION_LIMIT, 0)))
      .mockImplementationOnce(() => fakeProc(OK('q')));
    await expect(new ClaudeCliService().text('x')).resolves.toBe('q');
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnEnv(1)?.ANTHROPIC_AUTH_TOKEN).toBe('sk-sp-test');
  });

  it('stream-json без инструментов: «успех» с текстом лимита → Qwen', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeProc(streamOk(SESSION_LIMIT)))
      .mockImplementationOnce(() => fakeProc(streamOk('готово', 0.02)));
    const r = await new ClaudeCliService().textWithCost('x', { onProgress: () => {} });
    expect(r).toEqual({ text: 'готово', costUsd: 0.02 });
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnEnv(1)?.ANTHROPIC_AUTH_TOKEN).toBe('sk-sp-test');
  });

  it('stream-json: был инструмент с последствиями — не повторяем, текст как раньше, окно открыто', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeProc(lines(
        { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__products__manage_product', input: {} }] } },
        { type: 'result', is_error: false, result: SESSION_LIMIT, total_cost_usd: 0, duration_ms: 1 },
      )))
      .mockImplementationOnce(() => fakeProc(OK('q')));
    const svc = new ClaudeCliService();
    const r = await svc.textWithCost('x', { onProgress: () => {} });
    expect(r.text).toBe(SESSION_LIMIT);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(svc.fallbackStats().breakerOpenUntil).toBeGreaterThan(0);
    // Окно открыто — следующий обычный вызов сразу на Qwen.
    expect(await svc.text('y')).toBe('q');
    expect(spawnEnv(1)?.ANTHROPIC_AUTH_TOKEN).toBe('sk-sp-test');
  });

  it.each([
    'Claude AI usage limit reached|1730000000',
    "You've hit your session limit · resets 3am (UTC)",
    'You’ve hit your session limit · resets 3am',
  ])('отказ с начала текста → Qwen: %p', async (refusal) => {
    spawnMock
      .mockImplementationOnce(() => fakeProc(OK(refusal, 0)))
      .mockImplementationOnce(() => fakeProc(OK('q')));
    await expect(new ClaudeCliService().text('x')).resolves.toBe('q');
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnEnv(1)?.ANTHROPIC_AUTH_TOKEN).toBe('sk-sp-test');
  });

  it('короткий нормальный ответ, где фраза отказа не в начале, — обычный успех, окно закрыто', async () => {
    const answer = 'Это значит, что ключ неверный: сервис ответил Invalid API key. Проверьте ключ в карточке продукта.';
    expect(answer.length).toBeLessThanOrEqual(300);
    spawnMock.mockImplementationOnce(() => fakeProc(OK(answer)));
    const svc = new ClaudeCliService();
    await expect(svc.text('x')).resolves.toBe(answer);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(svc.fallbackStats().breakerOpenUntil).toBe(0);
  });

  it('без ключа — вызывающий получает тот же текст, один spawn', async () => {
    delete process.env.QWEN_FALLBACK_API_KEY;
    spawnMock.mockImplementationOnce(() => fakeProc(OK(SESSION_LIMIT, 0)));
    await expect(new ClaudeCliService().text('x')).resolves.toBe(SESSION_LIMIT);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('длинный ответ (>300 символов), где фраза лишь упомянута, — обычный успех', async () => {
    const long = 'Если CLI пишет «You have hit your usage limit», подождите сброса лимита. ' + 'Подробнее ниже. '.repeat(25);
    expect(long.length).toBeGreaterThan(300);
    spawnMock.mockImplementationOnce(() => fakeProc(OK(long)));
    await expect(new ClaudeCliService().text('x')).resolves.toBe(long);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('такой «успех» окно не закрывает (проба живости получила отказ текстом)', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeProc(AUTH_FAIL, 1))        // вызов 1: Claude падает → окно
      .mockImplementationOnce(() => fakeProc(OK('q1')))            // вызов 1: Qwen
      .mockImplementationOnce(() => fakeProc(OK(SESSION_LIMIT, 0))) // проба: отказ текстом
      .mockImplementationOnce(() => fakeProc(OK('q2')));           // вызов 2: окно всё ещё открыто
    const svc = new ClaudeCliService();
    await svc.text('1');
    expect(await svc.text('probe', { noFallback: true })).toBe(SESSION_LIMIT);
    expect(hasEnv(2)).toBe(false); // проба — на Claude
    expect(await svc.text('2')).toBe('q2');
    expect(spawnEnv(3)?.ANTHROPIC_AUTH_TOKEN).toBe('sk-sp-test');
  });
});

describe('ClaudeCliService — предохранитель', () => {
  it('после переключения — сразу Qwen; по истечении окна — снова Claude', async () => {
    let now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    process.env.QWEN_FALLBACK_BREAKER_MS = '60000';
    spawnMock
      .mockImplementationOnce(() => fakeProc(AUTH_FAIL, 1)) // вызов 1: Claude падает
      .mockImplementationOnce(() => fakeProc(OK('q1')))     // вызов 1: Qwen
      .mockImplementationOnce(() => fakeProc(OK('q2')))     // вызов 2: окно открыто — сразу Qwen
      .mockImplementationOnce(() => fakeProc(OK('c3')));    // вызов 3: окно истекло — Claude
    const svc = new ClaudeCliService();

    expect(await svc.text('1')).toBe('q1');
    now += 30_000;
    expect(await svc.text('2')).toBe('q2');
    expect(spawnMock).toHaveBeenCalledTimes(3);
    expect(spawnEnv(2)?.ANTHROPIC_AUTH_TOKEN).toBe('sk-sp-test');
    now += 31_000;
    expect(await svc.text('3')).toBe('c3');
    expect(hasEnv(3)).toBe(false);
  });

  it('успешная проба живости (noFallback) окно закрывает', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeProc(AUTH_FAIL, 1))
      .mockImplementationOnce(() => fakeProc(OK('q1')))
      .mockImplementationOnce(() => fakeProc(OK('probe ok')))
      .mockImplementationOnce(() => fakeProc(OK('c')));
    const svc = new ClaudeCliService();

    await svc.text('1');
    expect(await svc.text('probe', { noFallback: true })).toBe('probe ok');
    expect(hasEnv(2)).toBe(false); // проба — на Claude, несмотря на окно
    expect(await svc.text('2')).toBe('c');
    expect(hasEnv(3)).toBe(false); // окно закрыто — снова Claude
  });

  it('ошибка при открытом окне — сообщение с пометкой про окно и причиной Qwen; сбой Qwen окно закрывает', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeProc(AUTH_FAIL, 1))
      .mockImplementationOnce(() => fakeProc(OK('q1')))
      .mockImplementationOnce(() => fakeProc(QWEN_401, 1))
      .mockImplementationOnce(() => fakeProc(OK('c3')));
    const svc = new ClaudeCliService();
    await svc.text('1');
    const err = await svc.text('2').catch((e) => e);
    expect(err.message).toMatch(/^claude CLI пропущен \(окно запасного пути\) \| qwen fallback: .*401/);
    // Qwen сам лежит — молчать до конца окна незачем: Claude мог уже ожить.
    expect(await svc.text('3')).toBe('c3');
    expect(hasEnv(3)).toBe(false);
  });

  it('успех Claude, начатый до открытия окна, окно не закрывает', async () => {
    let now = 3_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const a = deferredProc();
    spawnMock
      .mockImplementationOnce(() => a.proc)                 // вызов A: Claude, долгий
      .mockImplementationOnce(() => fakeProc(AUTH_FAIL, 1)) // вызов B: Claude падает → окно
      .mockImplementationOnce(() => fakeProc(OK('qB')))     // вызов B: Qwen
      .mockImplementationOnce(() => fakeProc(OK('qC')));    // вызов C: окно открыто — сразу Qwen
    const svc = new ClaudeCliService();

    const pA = svc.text('A'); // стартовал в t
    expect(spawnMock).toHaveBeenCalledTimes(1);
    now += 1_000;
    expect(await svc.text('B')).toBe('qB'); // в t+1 с открыл окно
    a.finish(OK('cA'));                     // A кончился успехом уже при открытом окне
    expect(await pA).toBe('cA');

    expect(await svc.text('C')).toBe('qC');
    expect(spawnMock).toHaveBeenCalledTimes(4);
    expect(spawnEnv(3)?.ANTHROPIC_AUTH_TOKEN).toBe('sk-sp-test');
  });

  it('сбой подходящего вида открывает окно, даже если сам вызов не повторяется (был tool_use)', async () => {
    spawnMock
      .mockImplementationOnce(() => fakeProc(lines(
        { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__products__manage_product', input: {} }] } },
        { type: 'result', is_error: true, result: 'API Error: 529 Overloaded' },
      ), 1))
      .mockImplementationOnce(() => fakeProc(OK('q')));
    const svc = new ClaudeCliService();
    await expect(svc.textWithCost('x', { onProgress: () => {} })).rejects.toThrow('529');
    expect(spawnMock).toHaveBeenCalledTimes(1);
    // Claude сейчас недоступен — следующий обычный вызов идёт сразу на Qwen.
    expect(await svc.text('y')).toBe('q');
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnEnv(1)?.ANTHROPIC_AUTH_TOKEN).toBe('sk-sp-test');
  });

  it('через открытое окно вызов с MCP в json-режиме идёт на Qwen (попытки Claude нет — двойного срабатывания нет)', async () => {
    const { svc } = svcIn();
    spawnMock
      .mockImplementationOnce(() => fakeProc(AUTH_FAIL, 1))
      .mockImplementationOnce(() => fakeProc(OK('q1')))
      .mockImplementationOnce(() => fakeProc(OK('q2')));
    await svc.text('1');
    await expect(svc.text('2', { mcpServers: MCP })).resolves.toBe('q2');
    expect(spawnMock).toHaveBeenCalledTimes(3);
    expect(spawnEnv(2)?.ANTHROPIC_AUTH_TOKEN).toBe('sk-sp-test');
  });
});

describe('ClaudeCliService.fallbackStats', () => {
  it('ключа нет — enabled: false', () => {
    delete process.env.QWEN_FALLBACK_API_KEY;
    expect(new ClaudeCliService().fallbackStats()).toMatchObject({ enabled: false, ok: 0, failed: 0, windowMs: 15 * 60_000 });
  });

  it('считает исходы за 15 минут', async () => {
    let now = 5_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    process.env.QWEN_FALLBACK_BREAKER_MS = '0'; // без окна: каждый вызов сначала Claude
    spawnMock
      .mockImplementationOnce(() => fakeProc(AUTH_FAIL, 1))
      .mockImplementationOnce(() => fakeProc(OK('q')))
      .mockImplementationOnce(() => fakeProc(AUTH_FAIL, 1))
      .mockImplementationOnce(() => fakeProc(QWEN_401, 1));
    const svc = new ClaudeCliService();
    await svc.text('1');
    await svc.text('2').catch(() => {});
    expect(svc.fallbackStats()).toMatchObject({ enabled: true, ok: 1, failed: 1 });
    now += 16 * 60_000;
    expect(svc.fallbackStats()).toMatchObject({ ok: 0, failed: 0 });
  });

  it('breakerOpenUntil — момент закрытия, пока окно открыто; 0 — когда истекло', async () => {
    let now = 7_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    process.env.QWEN_FALLBACK_BREAKER_MS = '60000';
    spawnMock
      .mockImplementationOnce(() => fakeProc(AUTH_FAIL, 1))
      .mockImplementationOnce(() => fakeProc(OK('q')));
    const svc = new ClaudeCliService();
    await svc.text('1');
    expect(svc.fallbackStats().breakerOpenUntil).toBe(7_060_000);
    now += 61_000;
    expect(svc.fallbackStats().breakerOpenUntil).toBe(0);
  });
});
