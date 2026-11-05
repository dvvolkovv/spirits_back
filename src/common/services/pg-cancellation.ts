import { Client, Pool, PoolClient, Query, QueryResult } from 'pg';
import { throwIfAborted } from '../abort';

type RuntimePoolClient = PoolClient & {
  connectionParameters: ConstructorParameters<typeof Client>[0];
  query(query: Query, callback: (error: Error | null, result?: QueryResult) => void): unknown;
};
type RuntimeCancelClient = {
  cancel(client: PoolClient, query: Query): void;
};

/** Отдельный client нужен, чтобы cancel адресовал именно активный Query этого вызова. */
export async function queryWithCancellation(
  pool: Pool,
  text: string,
  params?: any[],
  signal?: AbortSignal,
): Promise<QueryResult> {
  throwIfAborted(signal);
  const client = await pool.connect();
  const query = new Query(text, params);
  const onAbort = () => {
    // CancelRequest требует отдельного подключения: cancel на активном Client
    // пытается переиспользовать занятый socket и завершается EISCONN.
    const cancelClient = new Client((client as RuntimePoolClient).connectionParameters);
    (cancelClient as unknown as RuntimeCancelClient).cancel(client, query);
  };
  try {
    // Для Query node-postgres возвращает сам Query, а не Promise. Callback — его
    // настоящий completion API; thenable-ветка нужна для PoolClient-совместимых обёрток.
    const pending = new Promise<QueryResult>((resolve, reject) => {
      const returned = (client as RuntimePoolClient).query(query, (error, result) => {
        if (error) reject(error);
        else resolve(result!);
      });
      if (returned && typeof (returned as PromiseLike<QueryResult>).then === 'function') {
        void (returned as PromiseLike<QueryResult>).then(resolve, reject);
      }
    });
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    return await pending;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    client.release();
  }
}
