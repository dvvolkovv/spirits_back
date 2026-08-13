import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { Pool, PoolClient, QueryResult } from 'pg';

/**
 * Захваченный advisory-лок. Держит СВОЁ соединение до release().
 *
 * Существует потому, что pg_advisory_lock живёт в сессии, а не в транзакции:
 * снять его можно только на том соединении, где он взят. Через пул это не
 * работает — см. комментарий к tryAdvisoryLock.
 */
export class AdvisoryLock {
  private released = false;

  constructor(
    private readonly client: PoolClient,
    readonly key: number,
    private readonly logger: Logger,
  ) {}

  /**
   * Снять лок и вернуть соединение в пул. Идемпотентно.
   *
   * Если Postgres ответил, что лока на этой сессии не было (released=false),
   * соединение уничтожается, а не возвращается в пул: раз наши представления о
   * состоянии сессии разошлись с реальностью, единственная гарантия снятия —
   * закрыть сессию. Закрытие освобождает все её advisory-локи.
   */
  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    try {
      const r = await this.client.query('SELECT pg_advisory_unlock($1) AS released', [this.key]);
      if (r.rows[0]?.released === false) {
        this.logger.error(
          `advisory lock ${this.key}: pg_advisory_unlock вернул false — закрываю соединение, чтобы лок не завис`,
        );
        this.client.release(true);
        return;
      }
      this.client.release();
    } catch (e: any) {
      this.logger.error(`advisory lock ${this.key}: снятие упало (${e.message}) — закрываю соединение`);
      this.client.release(true);
    }
  }
}

@Injectable()
export class PgService implements OnModuleInit, OnModuleDestroy {
  private pool: Pool;
  private lockPool: Pool;
  private readonly logger = new Logger(PgService.name);

  onModuleInit() {
    this.pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
    this.pool.on('error', (err) => {
      this.logger.error('PostgreSQL pool error:', err.message);
    });

    // Отдельный пул под долгоживущие advisory-локи. Соединение под локом занято
    // весь ход бота (генерация Claude идёт без таймаута и может длиться минуты),
    // поэтому брать его из основного пула нельзя: 20 соединений там делят веб-чат,
    // админка и SMM, и десяток параллельных чатов выжрал бы их все. Здесь же
    // исчерпание пула деградирует только сам захват лока — вызывающий получит
    // «занято» и попросит юзера повторить.
    this.lockPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.PG_LOCK_POOL_MAX || 10),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
    this.lockPool.on('error', (err) => {
      this.logger.error('PostgreSQL lock-pool error:', err.message);
    });

    this.logger.log('PostgreSQL pools created (main + advisory locks)');
  }

  async onModuleDestroy() {
    await Promise.all([this.pool.end(), this.lockPool.end()]);
  }

  async query(text: string, params?: any[]): Promise<QueryResult> {
    return this.pool.query(text, params);
  }

  async getClient(): Promise<PoolClient> {
    return this.pool.connect();
  }

  /**
   * Взять advisory-лок на выделенном соединении. null = лок уже держит кто-то другой.
   *
   * ⚠️ НЕ заменять на this.query() — оно ходит через пул, а pg_advisory_lock
   * привязан к сессии. Инцидент 2026-08-13: lock и unlock уезжали на разные
   * соединения, unlock возвращал false (результат не проверялся), лок оставался
   * висеть на чужом соединении до его закрытия по idleTimeoutMillis. Всё это
   * время чат отвечал «⏳ Минутку» на каждое сообщение — без ошибок и без единой
   * строки в логе. Воспроизведено на проде: got=true на pid=1468279,
   * released=false на pid=1468274, лок остался в pg_locks.
   */
  async tryAdvisoryLock(key: number): Promise<AdvisoryLock | null> {
    const client = await this.lockPool.connect();
    try {
      const r = await client.query('SELECT pg_try_advisory_lock($1) AS got', [key]);
      if (!r.rows[0]?.got) {
        client.release();
        return null;
      }
      return new AdvisoryLock(client, key, this.logger);
    } catch (e) {
      // Неизвестно, успел ли лок взяться — рвём соединение, чтобы Postgres
      // снял всё, что на нём висит.
      client.release(true);
      throw e;
    }
  }
}
