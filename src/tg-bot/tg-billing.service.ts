import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { TgGrammyClient } from './tg-grammy.client';
import { SEAT_TOKENS_PER_USD } from '../common/billing-rates';
import * as telegramAlert from '../common/telegram-alert';

@Injectable()
export class TgBillingService {
  private readonly logger = new Logger(TgBillingService.name);

  /**
   * Порог алерта на дорогой ход бота, в СПИСАННЫХ токенах. Тот же смысл и тот
   * же дефолт, что у EXPENSIVE_TURN_ALERT_TOKENS в вебе.
   *
   * Был в долларах себестоимости — и будил на ходах, которые для агентного бота
   * норма (договор, финмодель, подборка тендеров — это $4–7). Токенный порог
   * поедет при смене курса, зато он про то же число, которое владелец видит в
   * своём балансе. Прежние TG_ALERT_USD / SDK_ALERT_USD больше не читаются.
   */
  private readonly EXPENSIVE_TURN_ALERT_TOKENS = Number(
    process.env.TG_ALERT_TOKENS || process.env.SDK_ALERT_TOKENS || 30_000,
  );

  constructor(
    private readonly pg: PgService,
    private readonly grammy: TgGrammyClient,
  ) {}

  /**
   * USD-стоимость → Linkeon-токены. Курс общий со всеми путями, которые едят
   * ёмкость подписки Claude (SDK-путь, Маша) — см. common/billing-rates.ts.
   * Раньше здесь было 100_000 против 1_200 в SDK-пути: один и тот же доллар
   * расхода списывался в 83 раза по-разному в зависимости от ассистента.
   */
  tokensFromUsd(usd: number): number {
    return Math.ceil(usd * SEAT_TOKENS_PER_USD);
  }

  /**
   * Списание после уже отправленного ответа. Возвращает новый баланс.
   *
   * Раньше здесь стоял безусловный `tokens = tokens - $1` с комментарием
   * «атомарное списание» — атомарным он не был: читал и писал без блокировки
   * строки и без пола, поэтому уводил баланс в минус. consume_user_tokens
   * берёт строку под FOR UPDATE, списывает не больше остатка и пишет запись
   * в token_transactions.
   */
  async deduct(ownerUserId: string, tokens: number): Promise<number> {
    if (tokens <= 0) return await this.getBalance(ownerUserId);
    try {
      await this.pg.query(`SELECT consume_user_tokens($1, $2, $3)`, [ownerUserId, tokens, 'tg-bot']);
    } catch (e: any) {
      this.logger.warn(`consume_user_tokens недоступна (${e.message}) — списываю с полом`);
      await this.pg.query(
        `UPDATE ai_profiles_consolidated SET tokens = GREATEST(0, tokens - $1), updated_at = now()
          WHERE user_id = $2`,
        [tokens, ownerUserId],
      );
    }
    return await this.getBalance(ownerUserId);
  }

  async getBalance(ownerUserId: string): Promise<number> {
    const r = await this.pg.query(
      `SELECT tokens FROM ai_profiles_consolidated WHERE user_id = $1 LIMIT 1`,
      [ownerUserId],
    );
    return Number(r.rows[0]?.tokens ?? 0);
  }

  /**
   * Алерт нам (не владельцу) на аномально дорогой ход. Владелец про списание
   * узнаёт из баланса, а вот мы про ход за 65k токенов раньше не узнавали
   * вообще: в вебе такой порог есть, в телеге его не было.
   *
   * fire-and-forget по смыслу — ответ уже отправлен и токены уже списаны,
   * поэтому упавший телеграм не должен превращаться в исключение выше по стеку.
   */
  async alertIfExpensiveTurn(
    cfg: { id: string; display_name: string; owner_user_id: string },
    costUsd: number,
    tokensCharged: number,
    balanceLeft: number,
  ): Promise<void> {
    if (!(tokensCharged >= this.EXPENSIVE_TURN_ALERT_TOKENS)) return;
    try {
      await telegramAlert.sendTelegramAlert(
        `💸 <b>Дорогой ход TG-бота</b>\n` +
        `Бот: <b>${cfg.display_name}</b> (<code>${cfg.id}</code>)\n` +
        `Владелец: <code>${cfg.owner_user_id}</code>\n` +
        `Стоимость: <b>$${costUsd.toFixed(2)}</b> → списано ${tokensCharged.toLocaleString('ru')} токенов\n` +
        `Остаток: ${balanceLeft.toLocaleString('ru')}`,
      );
    } catch (e: any) {
      this.logger.warn(`expensive-turn alert failed: ${e.message}`);
    }
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
