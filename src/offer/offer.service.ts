import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { EventsService } from '../events/events.service';
import { OFFER_MSG_THRESHOLD, OFFER_BONUS_PCT } from './offer-bonus';
import * as fs from 'fs';
import * as path from 'path';

const COOLDOWN_MS = 7 * 864e5; // 7 дней

@Injectable()
export class OfferService implements OnModuleInit {
  private readonly logger = new Logger(OfferService.name);

  constructor(
    private readonly pg: PgService,
    @Optional() private readonly events?: EventsService,
  ) {}

  // Миграция через onModuleInit (deploy.sh не гоняет миграции; паттерн ProfileService/BacklogService).
  async onModuleInit() {
    for (const file of ['001_offer.sql']) {
      const candidates = [
        path.join(__dirname, 'migrations', file),
        path.join(__dirname, '..', '..', 'src', 'offer', 'migrations', file),
      ];
      for (const p of candidates) {
        try {
          if (fs.existsSync(p)) {
            await this.pg.query(fs.readFileSync(p, 'utf8'));
            this.logger.log(`offer migration ${file} applied from ${p}`);
            break;
          }
        } catch (e: any) {
          this.logger.error(`offer migration ${file} failed (${p}): ${e.message}`);
        }
      }
    }
  }

  async messageCount(userId: string): Promise<number> {
    const r = await this.pg.query(
      `SELECT count(*)::int AS n FROM custom_chat_history
       WHERE sender_type = 'human' AND (session_id = $1 OR session_id LIKE $1 || '\\_%')`,
      [userId],
    );
    return r.rows[0]?.n ?? 0;
  }

  async hasPaid(userId: string): Promise<boolean> {
    const r = await this.pg.query(
      `SELECT 1 FROM payments WHERE user_id = $1 AND status = 'succeeded' LIMIT 1`,
      [userId],
    );
    return r.rows.length > 0;
  }

  // Время первого сообщения пользователя (для триггера «после first_chat»).
  async firstChatAt(userId: string): Promise<Date | null> {
    const r = await this.pg.query(
      `SELECT min(created_at) AS t FROM custom_chat_history
        WHERE sender_type = 'human' AND (session_id = $1 OR session_id LIKE $1 || '\\_%')`,
      [userId],
    );
    return r.rows[0]?.t ? new Date(r.rows[0].t) : null;
  }

  async status(userId: string) {
    const [n, paid, prof, firstChat] = await Promise.all([
      this.messageCount(userId),
      this.hasPaid(userId),
      this.pg.query(`SELECT offer_dismissed_at FROM ai_profiles_consolidated WHERE user_id = $1`, [userId]),
      this.firstChatAt(userId),
    ]);
    const dismissedAt = prof.rows[0]?.offer_dismissed_at;
    const inCooldown = dismissedAt ? Date.now() - new Date(dismissedAt).getTime() < COOLDOWN_MS : false;
    // +50%-оффер: вовлечённому неплатящему (>= порога сообщений).
    const eligible = n >= OFFER_MSG_THRESHOLD && !paid && !inCooldown;
    // Триггер «после first_chat» (c732734f): лёгкий in-app нудж к первой оплате
    // для тех, кто пообщался ≥3ч назад, но не дотянул до +50%-оффера и не платил.
    // Без обещания бонуса — финансовые условия не меняем.
    const FIRST_CHAT_DELAY_MS = 3 * 3600e3;
    const firstChatNudge =
      !paid && !inCooldown && !eligible && n >= 1 &&
      !!firstChat && Date.now() - firstChat.getTime() >= FIRST_CHAT_DELAY_MS;
    return { eligible, first_chat_nudge: firstChatNudge, bonus_pct: OFFER_BONUS_PCT, message_count: n };
  }

  async dismiss(userId: string) {
    await this.pg.query(
      `UPDATE ai_profiles_consolidated SET offer_dismissed_at = now() WHERE user_id = $1`,
      [userId],
    );
    this.events?.track('offer_dismissed', { userId, props: {} });
    return { ok: true };
  }
}
