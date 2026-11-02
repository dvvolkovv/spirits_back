import { Logger } from '@nestjs/common';

// Настоящий ClaudeCliService с подменённым spawn: сырой вывод CLI доходит до
// пробы тем же путём, что на проде.
jest.mock('child_process', () => ({ spawn: jest.fn() }));
jest.mock('../common/telegram-alert', () => ({
  ...jest.requireActual('../common/telegram-alert'),
  sendTelegramPayload: jest.fn(async () => undefined),
}));
import { spawn } from 'child_process';
import { sendTelegramPayload } from '../common/telegram-alert';
import { ClaudeCliCallError, ClaudeCliService } from '../common/services/claude-cli.service';
import { ClaudeHealthService } from './claude-health.service';

/**
 * Причина сбоя пробы живости — в админке (llmError) и в алерте «Причина: …» —
 * без сырого текста CLI (spec 2026-11-02-safe-cli-errors): вид — признак
 * ошибки CLI, причина — фиксированная фраза вида, для other — с безопасным
 * текстом ошибки. Раньше для other туда шёл сырой текст (classifyLlmError).
 */

const spawnMock = spawn as unknown as jest.Mock;
const SECRET = 'СЕКРЕТ-ИЗ-ОТВЕТА';
const LEAK = /СЕКРЕТ/;

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

const ENV = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'QWEN_FALLBACK_API_KEY', 'KIMI_FALLBACK_API_KEY'];
let saved: Record<string, string | undefined>;
let logSpies: jest.SpyInstance[] = [];
const logged = () => logSpies.flatMap((s) => s.mock.calls.map((c) => c.map(String).join(' '))).join('\n');

beforeEach(() => {
  spawnMock.mockReset();
  (sendTelegramPayload as jest.Mock).mockClear();
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  process.env.TELEGRAM_BOT_TOKEN = 'tg-test';
  process.env.TELEGRAM_CHAT_ID = 'chat-test';
  logSpies = (['log', 'error', 'warn', 'debug', 'verbose'] as const)
    .map((l) => jest.spyOn(Logger.prototype as any, l).mockImplementation(() => undefined));
});

afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  jest.restoreAllMocks();
});

const pg = () => ({ query: jest.fn(async (sql: string) => (/SELECT alerted/.test(sql) ? { rows: [{ alerted: false }] } : { rows: [] })) });
/** Общий рубильник модели — на Claude. */
const claudeSwitch = () => ({ get: jest.fn(async () => 'claude') });

/** Одна проба живости с этим CLI (настоящим ClaudeCliService или подменой). */
async function probe(claudeCli: any): Promise<any> {
  const svc: any = new ClaudeHealthService(pg() as any, claudeCli, claudeSwitch() as any);
  await svc.probeLiveness();
  return svc;
}
const sent = (): string[] => (sendTelegramPayload as jest.Mock).mock.calls.map((c) => c[0].text);

describe('ClaudeHealthService — причина сбоя пробы без сырого текста', () => {
  it('other: фраза вида и безопасный текст ошибки; в llmError, журнале и алерте маркера нет', async () => {
    spawnMock.mockImplementationOnce(() => fakeProc(JSON.stringify({ is_error: true, result: `API Error: 500 ${SECRET}` }), 1, `Error: ${SECRET}`));
    const svc = await probe(new ClaudeCliService());
    expect(svc.cache.llmStatus).toBe('down');
    expect(svc.cache.llmOutageKind).toBe('other');
    expect(svc.cache.llmError).toBe('неизвестный сбой CLI: claude CLI код выхода 1: other');
    svc.cliConsecutiveDown = 99;
    await svc.maybeAlertOutage();
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toContain('Причина: <b>неизвестный сбой CLI: claude CLI код выхода 1: other</b> (other)');
    expect(sent()[0]).not.toMatch(LEAK);
    expect(logged()).not.toMatch(LEAK);
  });

  it('auth: вид из признака ошибки CLI, причина — фраза вида без текста ошибки', async () => {
    spawnMock.mockImplementationOnce(() => fakeProc(JSON.stringify({
      is_error: true, api_error_status: 401, result: `Failed to authenticate. API Error: 401 ${SECRET}`,
    }), 1));
    const svc = await probe(new ClaudeCliService());
    expect(svc.cache.llmOutageKind).toBe('auth');
    expect(svc.cache.llmError).toBe('Сбой авторизации Claude (OAuth/API-ключ)');
    expect(logged()).not.toMatch(LEAK);
  });

  it('вид — признак kind, а не текст: в безопасном тексте нет слова «limit», вид всё равно weekly_limit', async () => {
    const claudeCli = {
      text: jest.fn().mockRejectedValue(new ClaudeCliCallError('claude CLI код выхода 1', false, { kind: 'weekly_limit', access: true })),
      fallbackStats: jest.fn(),
    };
    const svc = await probe(claudeCli);
    expect(svc.cache.llmOutageKind).toBe('weekly_limit');
    expect(svc.cache.llmError).toBe('Исчерпан лимит Claude-подписки (недельный/использования)');
  });

  it('ошибка без признака (не от CLI) — вид по тексту, как раньше', async () => {
    const claudeCli = { text: jest.fn().mockRejectedValue(new Error('claude CLI timeout after 30000ms')), fallbackStats: jest.fn() };
    const svc = await probe(claudeCli);
    expect(svc.cache.llmOutageKind).toBe('timeout');
    expect(svc.cache.llmError).toBe('Таймаут вызова Claude');
  });

  it('отказ CLI текстом пробы вида other — фраза вида и безопасный текст отказа', async () => {
    const claudeCli = { text: jest.fn().mockResolvedValue('Credit balance is too low'), fallbackStats: jest.fn() };
    const svc = await probe(claudeCli);
    expect(svc.cache.llmStatus).toBe('down');
    expect(svc.cache.llmOutageKind).toBe('other');
    expect(svc.cache.llmError).toBe('неизвестный сбой CLI: claude CLI отказ: other, Credit balance is too low');
  });
});
