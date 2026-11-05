import { Pool, PoolClient, Query, QueryResult } from 'pg';
import { throwIfAborted } from '../abort';

type RuntimeCancellableClient = PoolClient & {
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
    // node-postgres не публикует cancel в типах PoolClient, хотя runtime Client его имеет.
    (client as RuntimeCancellableClient).cancel(client, query);
  };
  try {
    const pending = client.query(query) as Promise<QueryResult>;
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    return await pending;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    client.release();
  }
}
