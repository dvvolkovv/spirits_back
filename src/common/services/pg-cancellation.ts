import { Client, Pool, PoolClient, Query, QueryResult } from 'pg';
import { abortReason, throwIfAborted } from '../abort';

type RuntimePoolClient = PoolClient & {
  connectionParameters: ConstructorParameters<typeof Client>[0];
  query(query: Query, callback: (error: Error | null, result?: QueryResult) => void): unknown;
};
type RuntimeCancelClient = {
  cancel(client: PoolClient, query: Query): void;
  connection: {
    once(event: 'error', listener: (error: Error) => void): unknown;
    removeListener(event: 'error', listener: (error: Error) => void): unknown;
  };
};

/** Отдельный client нужен, чтобы cancel адресовал именно активный Query этого вызова. */
export async function queryWithCancellation(
  pool: Pool,
  text: string,
  params?: any[],
  signal?: AbortSignal,
  onClient?: (client: PoolClient) => void,
): Promise<QueryResult> {
  throwIfAborted(signal);

  let onConnectAbort: (() => void) | undefined;
  let client: PoolClient;
  try {
    const connecting = pool.connect();
    client = await new Promise<PoolClient>((resolve, reject) => {
      onConnectAbort = () => reject(abortReason(signal!));
      signal?.addEventListener('abort', onConnectAbort, { once: true });
      void connecting.then(
        (lateClient) => {
          if (signal?.aborted) {
            lateClient.release();
            reject(abortReason(signal));
          } else {
            resolve(lateClient);
          }
        },
        reject,
      );
    });
  } finally {
    if (onConnectAbort) signal?.removeEventListener('abort', onConnectAbort);
  }

  const query = new Query(text, params);
  let cancelClient: Client | undefined;
  let destroyError: Error | undefined;
  let rejectPending: (error: Error) => void = () => {};

  const onClientError = (error: Error) => {
    destroyError = error;
    rejectPending(error);
  };
  const onCancelError = (error: Error) => {
    // Без CancelRequest активный query мог бы висеть до конца. Рвём основной
    // client, чтобы PostgreSQL завершил работу, а вызывающий получил rejection.
    destroyError = error;
    rejectPending(error);
  };
  const onAbort = () => {
    // CancelRequest требует отдельного подключения: cancel на активном Client
    // пытается переиспользовать занятый socket и завершается EISCONN.
    cancelClient = new Client((client as RuntimePoolClient).connectionParameters);
    // У cancel-client нет Pool, поэтому без собственного error listener ENOENT
    // становится необработанным событием и завершает весь Node-процесс.
    cancelClient.once('error', onCancelError);
    const runtimeCancel = cancelClient as unknown as RuntimeCancelClient;
    // Client.cancel() соединяет Connection напрямую, минуя Client._attachListeners:
    // поэтому ENOENT приходит именно на Connection, а не на Client.
    runtimeCancel.connection.once('error', onCancelError);
    try {
      runtimeCancel.cancel(client, query);
    } catch (error) {
      onCancelError(error as Error);
    }
  };

  try {
    throwIfAborted(signal);
    onClient?.(client);
    // Pool не обрабатывает error у выданного наружу client. Listener должен быть
    // установлен до Query: обрыв backend иначе может завершить процесс событием error.
    client.on('error', onClientError);
    // Для Query node-postgres возвращает сам Query, а не Promise. Callback — его
    // настоящий completion API; thenable-ветка нужна для PoolClient-совместимых обёрток.
    const pending = new Promise<QueryResult>((resolve, reject) => {
      rejectPending = reject;
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
    if (cancelClient) {
      const closingClient = cancelClient;
      void closingClient.end()
        .catch(() => {})
        .finally(() => {
          closingClient.removeListener('error', onCancelError);
          (closingClient as unknown as RuntimeCancelClient).connection
            .removeListener('error', onCancelError);
        });
    }
    if (destroyError) {
      // Оставляем onClientError на уничтожаемом client: поздний error из socket
      // не должен стать unhandled после settle основного Promise.
      client.release(destroyError);
    } else {
      client.removeListener('error', onClientError);
      client.release();
    }
  }
}
