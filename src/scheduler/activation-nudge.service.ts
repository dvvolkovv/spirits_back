import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PgService } from '../common/services/pg.service';
import { PushService } from '../push/push.service';

/**
 * Активационный нудж (backlog 56c5a3a7 / VPM 6c48925f).
 *
 * Проблема: activation_rate ~33% — 2 из 3 зарегистрировавшихся не доходят до
 * первого чата. median_time_to_first_chat = 1 мин у тех, кто дошёл → барьер не
 * в UI, а в мотивации/триггере. Шлём ОДИН web-push через ~25 мин после
 * регистрации тем, кто ещё не написал ни одного сообщения.
 *
 * Идемпотентность: колонка activation_nudged_at (ставится после отправки) +
 * узкое окно «зарегистрирован 20–120 мин назад» — чтобы первый прогон после
 * деплоя НЕ разослал нудж всему историческому хвосту не-начавших чат.
 */
@Injectable()
export class ActivationNudgeService implements OnModuleInit {
  private readonly logger = new Logger(ActivationNudgeService.name);

  // Тест-номера — синхронно с остальной аналитикой (не нудим служебные).
  private readonly TEST_USERS = ['70000000000', '79030169187', '79169403771', '79656445804'];
  private readonly TEST_PATTERN = '^790300[0-9]{5}$';

  constructor(
    @Optional() private readonly pg?: PgService,
    @Optional() private readonly push?: PushService,
  ) {}

  async onModuleInit() {
    if (!this.pg) return;
    try {
      await this.pg.query(
        `ALTER TABLE ai_profiles_consolidated ADD COLUMN IF NOT EXISTS activation_nudged_at timestamptz`,
      );
    } catch (e: any) {
      this.logger.error(`activation_nudged_at migration failed: ${e?.message}`);
    }
  }

  @Cron('*/5 * * * *') // каждые 5 минут
  async sendActivationNudges() {
    if (!this.pg || !this.push) return;
    try {
      // Кандидаты: зарегистрированы 20–120 мин назад, ещё не нудились, НЕ писали
      // ни одного сообщения, есть активная push-подписка, не тест-номер.
      const rows = await this.pg.query(
        `SELECT p.user_id
           FROM ai_profiles_consolidated p
          WHERE p.activation_nudged_at IS NULL
            AND p.created_at BETWEEN now() - interval '120 minutes' AND now() - interval '20 minutes'
            AND p.user_id <> ALL($1::text[])
            AND p.user_id !~ $2
            AND EXISTS (SELECT 1 FROM push_subscriptions s WHERE s.user_id = p.user_id)
            AND NOT EXISTS (
              SELECT 1 FROM custom_chat_history ch
               WHERE split_part(ch.session_id,'_',1) = p.user_id
                 AND ch.sender_type = 'human'
            )
          LIMIT 200`,
        [this.TEST_USERS, this.TEST_PATTERN],
      );
      if (!rows.rows.length) return;

      let sent = 0;
      for (const r of rows.rows) {
        const userId = String(r.user_id);
        try {
          const delivered = await this.push.sendPush(userId, {
            title: 'Linkeon',
            body: 'С чего начать? Задай Роману любой вопрос — первые сообщения бесплатны.',
            url: '/chat',
            tag: 'activation-nudge',
          });
          // Ставим метку в любом случае (даже delivered=0): не долбим повторно
          // того, у кого подписка протухла между выборкой и отправкой.
          await this.pg.query(
            `UPDATE ai_profiles_consolidated SET activation_nudged_at = now() WHERE user_id = $1`,
            [userId],
          );
          if (delivered > 0) sent++;
        } catch (e: any) {
          this.logger.warn(`activation nudge failed for ${userId}: ${e?.message}`);
        }
      }
      if (sent > 0) this.logger.log(`activation nudge: delivered to ${sent}/${rows.rows.length} users`);
    } catch (e: any) {
      this.logger.error(`sendActivationNudges failed: ${e?.message}`);
    }
  }
}
