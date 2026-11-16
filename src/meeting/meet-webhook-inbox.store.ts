import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { PgService } from '../common/services/pg.service';

export interface NewInboxEvent {
  callId: string;
  idempotencyKey: string | null;
  trigger: string;
  message: Record<string, unknown>;
}

export interface ClaimedInboxEvent {
  id: string; // BIGSERIAL приходит из pg строкой
  callId: string;
  trigger: string;
  message: Record<string, unknown>;
  attempts: number;
  recovered?: boolean;
}

const MIGRATION_FILE = '006_meeting_webhook_events.sql';
const MIGRATION_NAME = `meeting/${MIGRATION_FILE}`;
const MIGRATION_LOCK_KEY = 8675309;

/** Durable inbox входящих Attendee webhook'ов (PostgreSQL). */
@Injectable()
export class MeetingWebhookInboxStore implements OnModuleInit {
  private readonly logger = new Logger(MeetingWebhookInboxStore.name);

  constructor(private readonly pg: PgService) {}

  /**
   * Миграция применяется при старте API: общий раннер деплоем не вызывается.
   * Учёт — в общей schema_migrations под именем `meeting/<файл>`. Сериализация
   * параллельных стартов — транзакционный advisory-лок. Ошибка логируется и
   * старт не роняет.
   */
  async onModuleInit(): Promise<void> {
    const file = [
      path.join(__dirname, 'migrations', MIGRATION_FILE),
      path.join(__dirname, '..', '..', 'src', 'meeting', 'migrations', MIGRATION_FILE),
    ].find((p) => fs.existsSync(p));
    if (!file) {
      this.logger.warn(`meeting inbox migration not found: ${MIGRATION_FILE}`);
      return;
    }
    let client: any = null;
    let broken = false;
    const onClientError = (e: Error) => {
      broken = true;
      this.logger.error(`meeting migration client error: ${e?.message}`);
    };
    try {
      client = await this.pg.getClient();
      client.on('error', onClientError);
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '3s'");
      await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
      await client.query(
        `CREATE TABLE IF NOT EXISTS schema_migrations (
           filename text PRIMARY KEY,
           applied_at timestamptz NOT NULL DEFAULT now()
         )`,
      );
      const done = await client.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [MIGRATION_NAME]);
      if (done.rows.length > 0) {
        await client.query('COMMIT');
        return;
      }
      await client.query(fs.readFileSync(file, 'utf8'));
      await client.query(
        'INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING',
        [MIGRATION_NAME],
      );
      await client.query('COMMIT');
      this.logger.log(`meeting migration applied: ${MIGRATION_FILE}`);
    } catch (e: any) {
      if (client) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // состояние транзакции неизвестно — соединение нельзя возвращать в пул
          broken = true;
        }
      }
      this.logger.error(`meeting migration failed (${MIGRATION_FILE}): ${e?.message}`);
    } finally {
      if (client) {
        client.removeListener('error', onClientError);
        client.release(broken ? true : undefined);
      }
    }
  }

  async enqueue(input: NewInboxEvent): Promise<'inserted' | 'duplicate'> {
    const r = await this.pg.query(
      `INSERT INTO meeting_webhook_events (call_id, idempotency_key, trigger, message)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (call_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING id`,
      [input.callId, input.idempotencyKey, input.trigger, JSON.stringify(input.message)],
    );
    const result = r.rows.length > 0 ? 'inserted' : 'duplicate';
    this.logger.debug(`meet webhook inbox ${result}: callId=${input.callId} trigger=${input.trigger}`);
    return result;
  }

  async claimBatch(limit = 20): Promise<ClaimedInboxEvent[]> {
    // Протухший lease на последней попытке — dead, а не 11-я попытка.
    const expired = await this.pg.query(
      `UPDATE meeting_webhook_events
          SET status = 'dead', last_error = 'lease expired after final attempt', updated_at = now()
        WHERE status = 'processing' AND attempts >= 10
          AND updated_at < now() - interval '60 seconds'
        RETURNING id`,
    );
    if ((expired.rows?.length ?? 0) > 0) {
      this.logger.warn(
        `meet webhook inbox: lease expired after final attempt, dead ids=${expired.rows.map((x: any) => x.id).join(',')}`,
      );
    }
    const r = await this.pg.query(
      `WITH candidates AS (
         SELECT id, (status = 'processing') AS recovered
           FROM meeting_webhook_events
          WHERE (status = 'pending' AND next_retry_at <= now())
             OR (status = 'processing' AND attempts < 10
                 AND updated_at < now() - interval '60 seconds')
          ORDER BY next_retry_at, created_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT $1
       )
       UPDATE meeting_webhook_events AS e
          SET status = 'processing', attempts = e.attempts + 1, updated_at = now()
         FROM candidates
        WHERE e.id = candidates.id
        RETURNING e.id, e.call_id AS "callId", e.trigger, e.message, e.attempts,
                  candidates.recovered`,
      [limit],
    );
    return r.rows;
  }

  /** Завершать можно только свою генерацию claim'а: processing и attempts = claimAttempts. */
  async markDelivered(id: string, claimAttempts: number): Promise<boolean> {
    const r = await this.pg.query(
      `UPDATE meeting_webhook_events
          SET status = 'delivered', delivered_at = now(), updated_at = now(), last_error = NULL
        WHERE id = $1 AND status = 'processing' AND attempts = $2
        RETURNING id`,
      [id, claimAttempts],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async markDiscarded(id: string, claimAttempts: number, reason: string): Promise<boolean> {
    const r = await this.pg.query(
      `UPDATE meeting_webhook_events
          SET status = 'discarded', last_error = left($3, 500), updated_at = now()
        WHERE id = $1 AND status = 'processing' AND attempts = $2
        RETURNING id`,
      [id, claimAttempts, reason],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async markFailed(
    id: string,
    claimAttempts: number,
    error: string,
    nextRetryAt: Date,
  ): Promise<'pending' | 'dead' | null> {
    const status = claimAttempts >= 10 ? 'dead' : 'pending';
    const r = await this.pg.query(
      `UPDATE meeting_webhook_events
          SET status = $3, last_error = left($4, 500), next_retry_at = $5::timestamptz, updated_at = now()
        WHERE id = $1 AND status = 'processing' AND attempts = $2
        RETURNING status`,
      [id, claimAttempts, status, error, nextRetryAt.toISOString()],
    );
    return r.rows.length > 0 ? r.rows[0].status : null;
  }

  async cleanup(): Promise<{ completed: number; dead: number }> {
    const completed = await this.pg.query(
      `DELETE FROM meeting_webhook_events
        WHERE status IN ('delivered', 'discarded')
          AND updated_at < now() - interval '24 hours'`,
    );
    const dead = await this.pg.query(
      `DELETE FROM meeting_webhook_events
        WHERE status = 'dead' AND updated_at < now() - interval '7 days'`,
    );
    return { completed: completed.rowCount ?? 0, dead: dead.rowCount ?? 0 };
  }
}
