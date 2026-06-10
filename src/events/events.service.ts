import { Injectable, Logger, OnModuleInit, OnModuleDestroy, Optional } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { PgService } from '../common/services/pg.service';

const FLUSH_INTERVAL_MS = 1_000;
const MAX_BUFFER = 500;

interface BufferedEvent {
  ts: Date;
  userId: string | null;
  sessionId: string | null;
  name: string;
  props: Record<string, unknown>;
  source: string | null;
}

@Injectable()
export class EventsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(EventsService.name);
  private buffer: BufferedEvent[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(@Optional() private readonly pg?: PgService) {}

  async onModuleInit() {
    if (!this.pg) {
      this.log.warn('PgService unavailable — events are no-op');
      return;
    }

    const candidates = [
      path.join(__dirname, 'migrations', '001_events.sql'),
      path.join(__dirname, '..', '..', 'src', 'events', 'migrations', '001_events.sql'),
    ];
    const found = candidates.find((p) => fs.existsSync(p));
    if (!found) {
      this.log.warn('events migration sql not found, skipping');
    } else {
      const sql = fs.readFileSync(found, 'utf8');
      // Retry to ride out the case where PgService's pool isn't ready on
      // the first tick — same pattern as IdentityService.
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          await this.pg.query(sql);
          this.log.log(`events migration 001 applied from ${found}`);
          break;
        } catch (e: any) {
          if (attempt === 5) {
            this.log.error(`events migration failed after 5 attempts: ${e.message}`);
          } else {
            this.log.warn(`events migration attempt ${attempt} failed: ${e.message} — retrying in 1s`);
            await new Promise((r) => setTimeout(r, 1000));
          }
        }
      }
    }

    // Колонка для надёжной атрибуции источника привлечения (signup_source).
    // session_id между анонимным лендингом и регистрацией не доживает — поэтому
    // фронт явно передаёт source после авторизации (events/attribute).
    try {
      await this.pg.query(
        `ALTER TABLE ai_profiles_consolidated ADD COLUMN IF NOT EXISTS signup_source text`,
      );
      // signup_campaign = utm_campaign/utm_content — для A/B-разреза по креативу
      // (source хранит только канал utm:vk/cpc).
      await this.pg.query(
        `ALTER TABLE ai_profiles_consolidated ADD COLUMN IF NOT EXISTS signup_campaign text`,
      );
    } catch (e: any) {
      this.log.error(`signup_source/campaign column migration failed: ${e.message}`);
    }

    this.timer = setInterval(() => this.flush().catch(() => {}), FLUSH_INTERVAL_MS);
    this.timer.unref?.();
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.flush().catch(() => {});
  }

  // Записать источник привлечения юзера ОДИН раз (first-touch): только если
  // signup_source ещё пуст. Игнорируем внутренние/служебные метки — пишем лишь
  // реальные источники (utm:/referral:/ref-site:/direct/organic).
  async setSignupSourceIfEmpty(userId: string, source: string, campaign?: string): Promise<void> {
    if (!this.pg) return;
    const ok = /^(utm:|referral:|ref-site:|direct$|organic$)/.test(source);
    if (!ok) return;
    const camp = (campaign || '').trim().slice(0, 120) || null;
    try {
      await this.pg.query(
        `UPDATE ai_profiles_consolidated
            SET signup_source = $2,
                signup_campaign = COALESCE(NULLIF($3,''), signup_campaign)
          WHERE user_id = $1 AND (signup_source IS NULL OR signup_source = '')`,
        [userId, source, camp],
      );
    } catch (e: any) {
      this.log.warn(`setSignupSourceIfEmpty failed: ${e.message}`);
    }
  }

  // Fire-and-forget tracking. Never throws — failure is logged only.
  // Same signature used by server-side code and the /track endpoint.
  track(
    name: string,
    opts: {
      userId?: string | null;
      sessionId?: string | null;
      props?: Record<string, unknown>;
      source?: string | null;
      ts?: Date;
    } = {},
  ): void {
    if (!name || typeof name !== 'string') return;
    this.buffer.push({
      ts: opts.ts || new Date(),
      userId: opts.userId || null,
      sessionId: opts.sessionId || null,
      name,
      props: opts.props || {},
      source: opts.source || null,
    });
    if (this.buffer.length >= MAX_BUFFER) {
      // Don't await — keep the call non-blocking.
      this.flush().catch(() => {});
    }
  }

  private async flush(): Promise<void> {
    if (!this.pg || this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];

    try {
      // Multi-row INSERT — one round-trip for the whole batch.
      const values: unknown[] = [];
      const placeholders: string[] = [];
      let i = 1;
      for (const e of batch) {
        placeholders.push(`($${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++})`);
        values.push(e.ts, e.userId, e.sessionId, e.name, JSON.stringify(e.props), e.source);
      }
      await this.pg.query(
        `INSERT INTO events (ts, user_id, session_id, name, props, source)
         VALUES ${placeholders.join(', ')}`,
        values,
      );
    } catch (e: any) {
      this.log.error(`events flush failed (${batch.length} dropped): ${e.message}`);
    }
  }
}
