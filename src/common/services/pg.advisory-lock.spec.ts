/**
 * Advisory-локи должны браться и сниматься на ОДНОМ соединении.
 *
 * Инцидент 2026-08-13: и захват, и снятие шли через this.pg.query(), то есть
 * через пул, который выдаёт произвольное соединение под каждый запрос.
 * pg_advisory_lock живёт в сессии, поэтому снятие на чужом соединении —
 * no-op, возвращающий false. Результат не проверялся, лок оставался висеть до
 * закрытия соединения по idleTimeoutMillis, и всё это время чат отвечал
 * «⏳ Минутку» на каждое сообщение: ни ошибки, ни строки в логе.
 *
 * Воспроизведено на проде: got=true на pid=1468279, released=false на
 * pid=1468274, лок остался в pg_locks.
 */

jest.mock('pg', () => {
  const pools: any[] = [];
  class Pool {
    config: any;
    clients: any[] = [];
    constructor(config: any) {
      this.config = config;
      pools.push(this);
    }
    on() { /* noop */ }
    async end() { /* noop */ }
    async query() { return { rows: [] }; }
    async connect() {
      const client = {
        id: this.clients.length + 1,
        queries: [] as Array<{ sql: string; params: any[] }>,
        released: null as null | { destroy: boolean },
        nextUnlockResult: true,
        nextLockResult: true,
        async query(sql: string, params: any[] = []) {
          this.queries.push({ sql, params });
          if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ got: this.nextLockResult }] };
          if (/pg_advisory_unlock/.test(sql)) return { rows: [{ released: this.nextUnlockResult }] };
          return { rows: [] };
        },
        release(destroy?: boolean) { this.released = { destroy: !!destroy }; },
      };
      this.clients.push(client);
      return client;
    }
  }
  return { Pool, __pools: pools };
});

import { PgService } from './pg.service';

const pg = require('pg');
const mainPool = () => pg.__pools[0];
const lockPool = () => pg.__pools[1];

function makeService() {
  pg.__pools.length = 0;
  const svc = new PgService();
  svc.onModuleInit();
  return svc;
}

describe('PgService.tryAdvisoryLock', () => {
  it('берёт и снимает лок на одном и том же соединении', async () => {
    const svc = makeService();

    const lock = await svc.tryAdvisoryLock(42);
    expect(lock).not.toBeNull();

    const clients = lockPool().clients;
    expect(clients).toHaveLength(1); // взяли ровно одно соединение и держим его
    expect(clients[0].queries[0].sql).toMatch(/pg_try_advisory_lock/);
    expect(clients[0].released).toBeNull(); // пока лок держим — соединение занято

    await lock!.release();

    // Снятие ушло на ТО ЖЕ соединение, а не в пул за новым.
    expect(lockPool().clients).toHaveLength(1);
    expect(clients[0].queries[1].sql).toMatch(/pg_advisory_unlock/);
    expect(clients[0].queries[1].params).toEqual([42]);
    expect(clients[0].released).toEqual({ destroy: false });
  });

  it('не ходит в основной пул: соединение под локом берётся из отдельного', async () => {
    const svc = makeService();

    const lock = await svc.tryAdvisoryLock(42);
    await lock!.release();

    // Основной пул делят веб-чат, админка и SMM; ход бота идёт минутами, и
    // держать там соединение нельзя — десяток чатов выжрал бы max: 20.
    expect(mainPool().clients).toHaveLength(0);
    expect(mainPool().config.max).toBe(20);
    expect(lockPool().config.max).toBe(10);
  });

  it('лок занят — соединение сразу возвращается в пул, а не течёт', async () => {
    const svc = makeService();
    const pool = lockPool();
    // Следующее соединение ответит «лок уже держат».
    const origConnect = pool.connect.bind(pool);
    pool.connect = async () => {
      const c = await origConnect();
      c.nextLockResult = false;
      return c;
    };

    const lock = await svc.tryAdvisoryLock(42);

    expect(lock).toBeNull();
    expect(pool.clients[0].released).toEqual({ destroy: false });
  });

  it('unlock вернул false — соединение уничтожается, чтобы лок не завис', async () => {
    const svc = makeService();
    const lock = await svc.tryAdvisoryLock(42);
    lockPool().clients[0].nextUnlockResult = false;

    await lock!.release();

    // Закрытие сессии — единственная оставшаяся гарантия снятия лока.
    expect(lockPool().clients[0].released).toEqual({ destroy: true });
  });

  it('release идемпотентен: второй вызов не шлёт unlock повторно', async () => {
    const svc = makeService();
    const lock = await svc.tryAdvisoryLock(42);

    await lock!.release();
    await lock!.release();

    const unlocks = lockPool().clients[0].queries.filter((q: any) => /pg_advisory_unlock/.test(q.sql));
    expect(unlocks).toHaveLength(1);
  });

  it('падение запроса при захвате — соединение уничтожается, а не возвращается', async () => {
    const svc = makeService();
    const pool = lockPool();
    const origConnect = pool.connect.bind(pool);
    pool.connect = async () => {
      const c = await origConnect();
      c.query = async () => { throw new Error('connection reset'); };
      return c;
    };

    await expect(svc.tryAdvisoryLock(42)).rejects.toThrow('connection reset');
    // Неизвестно, успел ли лок взяться — рвём сессию.
    expect(pool.clients[0].released).toEqual({ destroy: true });
  });
});
