import { LogsService } from './logs.service';
import { MonitoringService } from './monitoring.service';

type PendingFetch = {
  signal: AbortSignal;
  reject: (error: Error) => void;
};

describe('HTTP monitoring cancellation', () => {
  let pending: PendingFetch[];
  let fetchMock: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    pending = [];
    fetchMock = jest.fn((_url: string, init: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      const item: PendingFetch = { signal: init.signal, reject };
      pending.push(item);
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    }));
    jest.spyOn(global, 'fetch').mockImplementation(fetchMock as any);
  });

  afterEach(() => {
    for (const item of pending) item.reject(new Error('spec cleanup'));
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  async function flush() {
    await Promise.resolve();
    await Promise.resolve();
  }

  it('внешний abort раньше собственного timeout отменяет fetch и снимает listener/timer', async () => {
    const service = new MonitoringService();
    const controller = new AbortController();
    const remove = jest.spyOn(controller.signal, 'removeEventListener');
    const result = (service.query as any)('up', controller.signal) as Promise<unknown>;
    const rejection = expect(result).rejects.toThrow('external stop');
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    controller.abort(new Error('external stop'));
    await rejection;

    expect(pending[0].signal.aborted).toBe(true);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(jest.getTimerCount()).toBe(0);
  });

  it('собственный timeout раньше внешнего abort отменяет fetch и затем очищает listener', async () => {
    const service = new MonitoringService();
    const controller = new AbortController();
    const remove = jest.spyOn(controller.signal, 'removeEventListener');
    const result = (service.query as any)('up', controller.signal) as Promise<unknown>;
    const rejection = expect(result).rejects.toThrow(/timeout/i);
    await flush();

    await jest.advanceTimersByTimeAsync(5000);
    await rejection;
    expect(pending[0].signal.aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0);

    controller.abort(new Error('late external stop'));
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  function stallJsonBody() {
    fetchMock.mockImplementationOnce((_url: string, init: { signal: AbortSignal }) => Promise.resolve({
      ok: true,
      json: () => new Promise((_resolve, reject) => {
        pending.push({ signal: init.signal, reject });
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      }),
      text: async () => '',
    }));
  }

  it('внешний abort после headers отменяет stalled body и очищает timer/listener', async () => {
    stallJsonBody();
    const service = new MonitoringService();
    const controller = new AbortController();
    const remove = jest.spyOn(controller.signal, 'removeEventListener');
    const result = (service.query as any)('up', controller.signal) as Promise<unknown>;
    void result.catch(() => {});
    await flush();
    await flush();
    expect(pending).toHaveLength(1);

    controller.abort(new Error('body stop'));
    await flush();
    expect(pending[0].signal.aborted).toBe(true);
    await expect(result).rejects.toThrow('body stop');
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(jest.getTimerCount()).toBe(0);
  });

  it('собственный timeout после headers отменяет stalled body', async () => {
    stallJsonBody();
    const service = new MonitoringService();
    const result = (service.query as any)('up') as Promise<unknown>;
    void result.catch(() => {});
    await flush();
    await flush();
    expect(pending).toHaveLength(1);

    await jest.advanceTimersByTimeAsync(5000);
    expect(pending[0].signal.aborted).toBe(true);
    await expect(result).rejects.toThrow(/timeout/i);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('LogsService сохраняет собственный timeout 8000ms при внешнем signal', async () => {
    const service = new LogsService();
    const controller = new AbortController();
    const opts = { query: '{job="linkeon-api"}', from: '1', to: '2', limit: 10 };
    const result = (service.query as any)(opts, controller.signal) as Promise<unknown>;
    const rejection = expect(result).rejects.toThrow(/timeout/i);
    await flush();

    await jest.advanceTimersByTimeAsync(7999);
    expect(pending[0].signal.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await rejection;
    expect(pending[0].signal.aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });
});
