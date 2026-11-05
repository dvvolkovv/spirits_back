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
