import { EventEmitter } from 'events';
import { Client, PoolClient, Query } from 'pg';
import { PgService } from './pg.service';

describe('PgService.query cancellation', () => {
  function fixture() {
    let rejectActive!: (error: Error) => void;
    let resolveActive!: (value: any) => void;
    let activeQuery: Query | undefined;
    const client = new EventEmitter() as PoolClient & {
      query: jest.Mock;
      release: jest.Mock;
      cancel: jest.Mock;
    };
    client.query = jest.fn((query: Query) => {
      activeQuery = query;
      return new Promise((resolve, reject) => { resolveActive = resolve; rejectActive = reject; });
    });
    client.release = jest.fn();
    const cancel = jest.spyOn(Client.prototype as any, 'cancel').mockImplementation(
      (target: PoolClient, query: Query) => {
        expect(target).toBe(client);
        expect(query).toBe(activeQuery);
        rejectActive(new Error('cancel requested'));
      },
    );
    const pool = {
      connect: jest.fn(async () => client),
      // Старый путь оставлен в fixture, чтобы RED был поведенческим, а не TypeError.
      query: jest.fn((_text: string, _params?: any[]) => new Promise((resolve, reject) => {
        resolveActive = resolve;
        rejectActive = reject;
      })),
    };
    const service = new PgService();
    (service as any).pool = pool;
    return { service, client, pool, cancel, getQuery: () => activeQuery, rejectActive: (e: Error) => rejectActive(e), resolveActive: (v: any) => resolveActive(v) };
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function flush() {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }

  it('abort вызывает runtime client.cancel для активного pg.Query, снимает listener и release', async () => {
    const { service, client, cancel, getQuery, rejectActive } = fixture();
    const controller = new AbortController();
    const remove = jest.spyOn(controller.signal, 'removeEventListener');
    const result = (service.query as any)('SELECT pg_sleep(10)', [], controller.signal) as Promise<unknown>;
    const rejection = expect(result).rejects.toThrow('cancel requested');
    await flush();

    controller.abort();
    await flush();
    const cancelCalls = cancel.mock.calls.length;
    const releaseCalls = client.release.mock.calls.length;
    rejectActive(new Error('cancel requested'));
    await rejection;

    expect(getQuery()).toBeInstanceOf(Query);
    expect(cancelCalls).toBe(1);
    expect(cancel).toHaveBeenCalledWith(client, getQuery());
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(releaseCalls).toBe(1);
  });

  it('не отдаёт reused client второму query до завершения CancelRequest', async () => {
    const { service, client, pool, resolveActive } = fixture();
    let finishCancel!: () => void;
    const end = jest.spyOn(Client.prototype, 'end').mockImplementation(
      () => new Promise<void>((resolve) => { finishCancel = resolve; }),
    );
    const controller = new AbortController();
    let releaseSecondConnect!: () => void;
    let connects = 0;
    client.release.mockImplementation(() => { releaseSecondConnect?.(); });
    pool.connect.mockImplementation(() => {
      connects += 1;
      if (connects === 1) return Promise.resolve(client);
      return new Promise<PoolClient>((resolve) => {
        releaseSecondConnect = () => resolve(client);
      });
    });
    const first = (service.query as any)('SELECT pg_sleep(10)', [], controller.signal) as Promise<unknown>;
    const rejection = expect(first).rejects.toThrow('cancel requested');
    await flush();
    controller.abort();
    await flush();

    expect(end).toHaveBeenCalledTimes(1);
    const second = (service.query as any)('SELECT 1 AS ok') as Promise<unknown>;
    await flush();
    const queriesBeforeCancelEnd = client.query.mock.calls.length;
    const releasesBeforeCancelEnd = client.release.mock.calls.length;
    finishCancel();
    await rejection;
    await flush();
    resolveActive({ rows: [{ ok: 1 }] });
    await expect(second).resolves.toEqual({ rows: [{ ok: 1 }] });

    expect(queriesBeforeCancelEnd).toBe(1);
    expect(releasesBeforeCancelEnd).toBe(0);
    expect(client.query).toHaveBeenCalledTimes(2);
    expect(pool.connect).toHaveBeenCalledTimes(2);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('hanging CancelRequest end разрушает cancel connection и original client за bounded время', async () => {
    const { service, client } = fixture();
    let closingClient!: Client;
    jest.spyOn(Client.prototype, 'end').mockImplementation(function (this: Client) {
      closingClient = this;
      return new Promise<void>(() => undefined);
    });
    const controller = new AbortController();
    const startedAt = Date.now();
    const result = (service.query as any)('SELECT pg_sleep(10)', [], controller.signal) as Promise<unknown>;
    const observed = result.then(
      () => ({ status: 'resolved' as const }),
      (error: Error) => ({ status: 'rejected' as const, error }),
    );
    await flush();
    controller.abort();
    await flush();
    const destroy = jest.spyOn((closingClient as any).connection, 'destroy').mockImplementation(() => undefined);
    let timer: NodeJS.Timeout;
    const outcome = await Promise.race([
      observed,
      new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), 1_800); }),
    ]);
    clearTimeout(timer!);

    expect(outcome).toMatchObject({ status: 'rejected' });
    expect(Date.now() - startedAt).toBeLessThan(1_800);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledWith(true);
  });

  it('abort во время pending pool.connect завершает вызов, а поздний client release без query', async () => {
    let resolveConnect!: (client: PoolClient) => void;
    const client = new EventEmitter() as PoolClient & { query: jest.Mock; release: jest.Mock };
    client.query = jest.fn((query: Query, callback: (error: Error | null, result?: any) => void) => {
      callback(null, { rows: [{ ok: 1 }] });
      return query;
    });
    client.release = jest.fn();
    const pool = { connect: jest.fn(() => new Promise<PoolClient>((resolve) => { resolveConnect = resolve; })) };
    const service = new PgService();
    (service as any).pool = pool;
    const controller = new AbortController();

    const result = (service.query as any)('SELECT 1', [], controller.signal) as Promise<unknown>;
    const settled = result.then(
      () => ({ status: 'resolved' }),
      (error: Error) => ({ status: 'rejected', error }),
    );
    await flush();
    controller.abort(new Error('connect stop'));
    await flush();
    resolveConnect(client);
    const outcome = await settled;

    expect(outcome.status).toBe('rejected');
    expect((outcome as any).error.message).toBe('connect stop');
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.query).not.toHaveBeenCalled();
  });

  it('обычный запрос тоже идёт через выделенного клиента и реальный Query, release в finally', async () => {
    const { service, client, pool, getQuery, resolveActive } = fixture();
    const result = (service.query as any)('SELECT $1::int AS n', [7]) as Promise<any>;
    await flush();
    resolveActive({ rows: [{ n: 7 }] });

    await expect(result).resolves.toEqual({ rows: [{ n: 7 }] });
    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(pool.query).not.toHaveBeenCalled();
    expect(getQuery()).toBeInstanceOf(Query);
    expect(getQuery()?.text).toBe('SELECT $1::int AS n');
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
