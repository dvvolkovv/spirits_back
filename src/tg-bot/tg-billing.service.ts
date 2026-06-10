import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { TgGrammyClient } from './tg-grammy.client';

@Injectable()
export class TgBillingService {
  private readonly logger = new Logger(TgBillingService.name);

  constructor(
    private readonly pg: PgService,
    private readonly grammy: TgGrammyClient,
  ) {}

  /**
   * USD-стоимость → Linkeon-токены. Та же формула что в chat/claude-agent.service.ts.
   */
  tokensFromUsd(usd: number): number {
    return Math.ceil(usd * 100_000);
  }

  /**
   * Атомарное списание. Возвращает новый баланс.
   */
  async deduct(ownerUserId: string, tokens: number): Promise<number> {
    if (tokens <= 0) return await this.getBalance(ownerUserId);
    const r = await this.pg.query(
      `UPDATE ai_profiles_consolidated SET tokens = tokens - $1
        WHERE user_id = $2
        RETURNING tokens`,
      [tokens, ownerUserId],
    );
    return Number(r.rows[0]?.tokens ?? 0);
  }

  async getBalance(ownerUserId: string): Promise<number> {
    const r = await this.pg.query(
      `SELECT tokens FROM ai_profiles_consolidated WHERE user_id = $1 LIMIT 1`,
      [ownerUserId],
    );
    return Number(r.rows[0]?.tokens ?? 0);
  }

  /**
   * Алерт владельцу при низком балансе. Кулдаун 24ч (last_low_balance_dm_at).
   */
  async checkBalanceAlerts(configId: string, ownerUserId: string, ownerTgUserId: number | null): Promise<void> {
    if (!ownerTgUserId) return;
    const threshold = Number(process.env.TG_BOT_LOW_BALANCE_THRESHOLD ?? '1000');
    const balance = await this.getBalance(ownerUserId);
    if (balance < threshold && balance > 0) {
      const r = await this.pg.query(
        `SELECT last_low_balance_dm_at FROM tg_bot_configs WHERE id = $1`,
        [configId],
      );
      const last = r.rows[0]?.last_low_balance_dm_at;
      const dayMs = 24 * 60 * 60 * 1000;
      if (!last || Date.now() - new Date(last).getTime() > dayMs) {
        try {
          await this.grammy.sendMessage(
            ownerTgUserId,
            `⚠️ На твоём боте осталось меньше ${threshold} токенов (баланс: ${balance}). Пополни: https://my.linkeon.io/tokens`,
          );
          await this.pg.query(
            `UPDATE tg_bot_configs SET last_low_balance_dm_at = now() WHERE id = $1`,
            [configId],
          );
        } catch (e: any) {
          this.logger.warn(`low-balance DM failed: ${e.message}`);
        }
      }
    }
  }

  /**
   * Уже ли мы уведомляли владельца о нулевом балансе в последние cooldownMs.
   * Раньше при первом срабатывании ставился флаг навсегда — после чего бот
   * молча игнорил ВСЕ следующие сообщения, выглядело как «бот завис».
   */
  async recentlyNotifiedZeroBalance(configId: string, cooldownMs: number): Promise<boolean> {
    const r = await this.pg.query(
      `SELECT last_zero_balance_msg_at FROM tg_bot_configs WHERE id = $1`,
      [configId],
    );
    const last = r.rows[0]?.last_zero_balance_msg_at;
    if (!last) return false;
    return Date.now() - new Date(last).getTime() < cooldownMs;
  }

  async markZeroBalanceNotified(configId: string): Promise<void> {
    await this.pg.query(
      `UPDATE tg_bot_configs SET last_zero_balance_msg_at = now() WHERE id = $1`,
      [configId],
    );
  }

  async clearZeroBalanceFlag(configId: string): Promise<void> {
    await this.pg.query(
      `UPDATE tg_bot_configs SET last_zero_balance_msg_at = NULL WHERE id = $1`,
      [configId],
    );
  }
}
