// src/common/services/claude-cli.text-delta.spec.ts
// Мокаем spawn ДО импорта сервиса: сервис берёт spawn из 'child_process' на уровне модуля.
jest.mock('child_process', () => ({ spawn: jest.fn() }));
import { spawn } from 'child_process';
import { ClaudeCliService } from './claude-cli.service';

/**
 * Текст по мере генерации (проба без входа, spec 2026-10-30-guest-trial).
 * Формат строк — stream-json CLI с --include-partial-messages: куски текста
 * приходят событиями stream_event → content_block_delta → text_delta.
 */

const spawnMock = spawn as unknown as jest.Mock;

const LINES = [
  { type: 'system', subtype: 'init', session_id: 's1', tools: [] },
  { type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } } },
  { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } },
  { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'думаю' } } },
  { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } },
  { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Привет' } } },
  { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: ', как дела?' } } },
  { type: 'stream_event', event: { type: 'content_block_stop', index: 1 } },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'Привет, как дела?' }] } },
  { type: 'result', subtype: 'success', is_error: false, result: 'Привет, как дела?', total_cost_usd: 0.012, duration_ms: 900 },
];

/** Процесс, который отдаёт строки stream-json кусками, разрезанными посреди строки. */
function streamProc(lines: object[]) {
  const outH: Array<(b: Buffer) => void> = [];
  const on: Record<string, (...a: any[]) => void> = {};
  const proc: any = {
    stdout: { on: (e: string, cb: any) => { if (e === 'data') outH.push(cb); } },
    stderr: { on: () => {} },
    on: (e: string, cb: any) => { on[e] = cb; },
    kill: () => {},
  };
  setImmediate(() => {
    const raw = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
    const cut = Math.floor(raw.length / 2);
    outH.forEach((cb) => cb(Buffer.from(raw.slice(0, cut))));
    outH.forEach((cb) => cb(Buffer.from(raw.slice(cut))));
    on['close']?.(0);
  });
  return proc;
}

/** Не-потоковый вызов: процесс отдаёт один JSON и закрывается. */
function jsonProc(json: string) {
  const outH: Array<(b: Buffer) => void> = [];
  const on: Record<string, (...a: any[]) => void> = {};
  const proc: any = {
    stdout: { on: (e: string, cb: any) => { if (e === 'data') outH.push(cb); } },
    stderr: { on: () => {} },
    on: (e: string, cb: any) => { on[e] = cb; },
    kill: () => {},
  };
  setImmediate(() => {
    outH.forEach((cb) => cb(Buffer.from(json)));
    on['close']?.(0);
  });
  return proc;
}

const lastArgs = (): string[] => spawnMock.mock.calls[spawnMock.mock.calls.length - 1][1];

let savedQwenKey: string | undefined;
beforeEach(() => {
  spawnMock.mockReset();
  savedQwenKey = process.env.QWEN_FALLBACK_API_KEY;
  delete process.env.QWEN_FALLBACK_API_KEY;
});
afterEach(() => {
  if (savedQwenKey === undefined) delete process.env.QWEN_FALLBACK_API_KEY;
  else process.env.QWEN_FALLBACK_API_KEY = savedQwenKey;
});

describe('ClaudeCliService: текст по мере генерации', () => {
  it('куски текста — в колбэк по порядку, итог — из result', async () => {
    spawnMock.mockImplementation(() => streamProc(LINES));
    const deltas: string[] = [];
    const r = await new ClaudeCliService().textWithCost('привет', { onTextDelta: (t) => deltas.push(t) });
    expect(deltas).toEqual(['Привет', ', как дела?']);
    expect(r.text).toBe('Привет, как дела?');
    expect(r.costUsd).toBe(0.012);
  });

  it('с колбэком — stream-json, --verbose и --include-partial-messages; без — ни одного из них', async () => {
    spawnMock.mockImplementation(() => streamProc(LINES));
    await new ClaudeCliService().textWithCost('привет', { onTextDelta: () => {} });
    const a = lastArgs();
    expect(a[a.indexOf('--output-format') + 1]).toBe('stream-json');
    expect(a).toContain('--verbose');
    expect(a).toContain('--include-partial-messages');
    // Инструментов по-прежнему нет: --tools со значением ''.
    expect(a[a.indexOf('--tools') + 1]).toBe('');

    spawnMock.mockImplementation(() => jsonProc(JSON.stringify({ is_error: false, result: 'ок', total_cost_usd: 0, duration_ms: 1 })));
    await new ClaudeCliService().text('привет');
    expect(lastArgs()).not.toContain('--include-partial-messages');
    expect(lastArgs()).not.toContain('--verbose');
  });

  it('исключение в колбэке не роняет вызов', async () => {
    spawnMock.mockImplementation(() => streamProc(LINES));
    const r = await new ClaudeCliService().textWithCost('привет', { onTextDelta: () => { throw new Error('клиент ушёл'); } });
    expect(r.text).toBe('Привет, как дела?');
  });
});
