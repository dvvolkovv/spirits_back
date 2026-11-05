import { Pool, PoolClient, Query, QueryResult } from 'pg';
import { throwIfAborted } from '../abort';

type RuntimeCancellableClient = PoolClient & {
  query(query: Query, callback: (error: Error | null, result?: QueryResult) => void): unknown;
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
  let canceled = false;
  const onAbort = () => {
    canceled = true;
    // node-postgres не публикует cancel в типах PoolClient, хотя runtime Client его имеет.
    (client as RuntimeCancellableClient).cancel(client, query);
  };
  try {
    // Для Query node-postgres возвращает сам Query, а не Promise. Callback — его
    // настоящий completion API; thenable-ветка нужна для PoolClient-совместимых обёрток.
    const pending = new Promise<QueryResult>((resolve, reject) => {
      const returned = (client as RuntimeCancellableClient).query(query, (error, result) => {
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
    client.release(canceled);
  }
}
