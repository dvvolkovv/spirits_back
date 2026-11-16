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
  id: number;
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
    try {
      client = await this.pg.getClient();
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
        try { await client.query('ROLLBACK'); } catch { /* соединение уже мёртвое */ }
      }
      this.logger.error(`meeting migration failed (${MIGRATION_FILE}): ${e?.message}`);
    } finally {
      client?.release();
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
}
