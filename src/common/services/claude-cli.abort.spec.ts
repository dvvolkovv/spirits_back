jest.mock('child_process', () => ({ spawn: jest.fn() }));

import { spawn } from 'child_process';
import { ClaudeCliService } from './claude-cli.service';

const spawnMock = spawn as unknown as jest.Mock;

function manualProc() {
  const handlers: Record<string, Array<(...args: any[]) => void>> = {};
  const stdoutHandlers: Array<(chunk: Buffer) => void> = [];
  const proc: any = {
    stdout: {
      on: (event: string, callback: (chunk: Buffer) => void) => {
        if (event === 'data') stdoutHandlers.push(callback);
      },
    },
    stderr: { on: () => {} },
    on: (event: string, callback: (...args: any[]) => void) => {
      (handlers[event] ||= []).push(callback);
    },
    kill: jest.fn(),
  };
  return {
    proc,
    emitStdout(value: string) {
      for (const callback of stdoutHandlers) callback(Buffer.from(value));
    },
    emitClose(code: number | null, signal: NodeJS.Signals | null = null) {
      for (const callback of handlers.close || []) callback(code, signal);
    },
  };
}

const ENV_KEYS = ['QWEN_FALLBACK_API_KEY', 'KIMI_FALLBACK_API_KEY'] as const;
const savedEnv = ENV_KEYS.map((key) => [key, process.env[key]] as const);

beforeEach(() => {
  spawnMock.mockReset();
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('ClaudeCliService: AbortSignal', () => {
  it('abort убивает текущий CLI, завершает вызов без fallback и игнорирует поздний close', async () => {
    const controller = new AbortController();
    const { proc, emitClose } = manualProc();
    spawnMock.mockReturnValue(proc);

    const promise = new ClaudeCliService().textWithCost('fix', {
      signal: controller.signal,
      mcpServers: {},
    });
    controller.abort();

    await expect(promise).rejects.toMatchObject({
      name: 'ClaudeCliCallError',
      message: 'claude CLI aborted',
      kind: 'other',
      access: false,
      toolUsed: false,
    });
    expect(proc.kill).toHaveBeenCalledTimes(1);
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(spawnMock).toHaveBeenCalledTimes(1);

    emitClose(null, 'SIGTERM');
    expect(proc.kill).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('уже aborted signal не запускает процесс', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(new ClaudeCliService().textWithCost('fix', { signal: controller.signal }))
      .rejects.toMatchObject({ message: 'claude CLI aborted', kind: 'other', access: false });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('abort снимает listener и timer; повторные abort и close не дают побочных эффектов', async () => {
    jest.useFakeTimers();
    const controller = new AbortController();
    const removeListener = jest.spyOn(controller.signal, 'removeEventListener');
    const { proc, emitClose } = manualProc();
    spawnMock.mockReturnValue(proc);

    const promise = new ClaudeCliService().textWithCost('fix', {
      signal: controller.signal,
      timeoutMs: 60_000,
    });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ message: 'claude CLI aborted' });
    controller.abort();
    emitClose(null, 'SIGTERM');

    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(jest.getTimerCount()).toBe(0);
    expect(proc.kill).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('обычный close снимает listener и timer, поэтому поздний abort не убивает завершённый процесс', async () => {
    jest.useFakeTimers();
    const controller = new AbortController();
    const removeListener = jest.spyOn(controller.signal, 'removeEventListener');
    const { proc, emitStdout, emitClose } = manualProc();
    spawnMock.mockReturnValue(proc);

    const promise = new ClaudeCliService().textWithCost('fix', {
      signal: controller.signal,
      timeoutMs: 60_000,
    });
    emitStdout(JSON.stringify({ is_error: false, result: 'ok', total_cost_usd: 0, duration_ms: 1 }));
    emitClose(0);
    await expect(promise).resolves.toEqual({ text: 'ok', costUsd: 0 });
    controller.abort();

    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(jest.getTimerCount()).toBe(0);
    expect(proc.kill).not.toHaveBeenCalled();
  });
});
