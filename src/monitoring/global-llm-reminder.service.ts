import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { GlobalLlmProviderService } from '../common/services/global-llm-provider.service';
import { FallbackProvider, readFallbackConfigs } from '../common/services/llm-fallback';
import { PgService } from '../common/services/pg.service';
import { sendTelegramAlert, telegramConfigured } from '../common/telegram-alert';
import { GlobalLlmDayCounts, reminderText, standPrefix } from '../common/global-llm-messages';
import { ClaudeHealthOverview, ClaudeHealthService } from './claude-health.service';

/**
 * Раз в сутки в 10:01 МСК (не 10:00 — совпадало бы с тиком пробы живости
 * Claude, ClaudeHealthService.livenessTick: '0 */15 * * * *'), пока общий
 * рубильник не на Claude, — напоминание в группу алертов (spec
 * 2026-10-31-global-llm-switch, раздел 8): возврат только вручную, и про
 * него легко забыть после аварии. Состояние Claude — по последней пробе
 * живости (раз в 15 минут). Счёт за сутки — по событиям: релей ходы «по
 * выбору» в /health.fallback не считает, и сбои модели рубильника иначе не
 * видны.
 */
@Injectable()
export class GlobalLlmReminderService {
  private readonly logger = new Logger(GlobalLlmReminderService.name);

  constructor(
    private readonly global: GlobalLlmProviderService,
    private readonly health: ClaudeHealthService,
    private readonly pg: PgService,
  ) {}

  @Cron('0 1 10 * * *', { name: 'global-llm-reminder', timeZone: 'Europe/Moscow' })
  async daily(): Promise<void> {
    await this.remind();
  }

  /** true — напоминание сформировано (отправлено в Telegram или, при
   *  отсутствии настроенного Telegram, записано в лог). */
  async remind(now: Date = new Date()): Promise<boolean> {
    const s = await this.global.status().catch((e: any) => {
      this.logger.warn(`рубильник: статус не прочитан: ${e?.message}`);
      return null;
    });
    if (!s || s.provider === 'claude') return false;
    const provider = s.provider;
    const overview = await this.health.getOverview().catch((): ClaudeHealthOverview | null => null);
    const day = await this.dayCounts(provider).catch((e: any) => {
      this.logger.warn(`рубильник: счёт за сутки не прочитан: ${e?.message}`);
      return null;
    });
    const text = reminderText({
      provider,
      since: s.since,
      now,
      claudeStatus: overview?.usage?.llmStatus ?? null,
      claudeCheckedAt: overview?.usage?.llmCheckedAt ?? null,
      keyMissing: readFallbackConfigs()[provider] === null,
      day,
    });
    // Без настроенного Telegram — в лог (как send() у RelayQwenMonitorService):
    // иначе сбой отправки означал бы, что напоминание не оставило никакого
    // следа вовсе.
    if (!telegramConfigured()) {
      this.logger.warn(`рубильник: напоминание (нет Telegram): ${text.replace(/<[^>]+>/g, '')}`);
      return true;
    }
    await sendTelegramAlert(standPrefix() + text).catch((e: any) => this.logger.warn(`напоминание о рубильнике не отправлено: ${e?.message}`));
    return true;
  }

  /**
   * Суточный счёт по вызовам рубильника (choice='global', selected=эта
   * модель): answered — она ответила (chat_quality/claude_cli_call,
   * provider = эта модель, ok не false); byOther — ответил другой (provider
   * — другой, не NULL, ok не false); failed — ВСЕГО без ответа: неудачные
   * ходы веб-чата (chat_quality: ok='false' или без provider) ПЛЮС отдельным
   * подзапросом ошибки гостей о модели (guest_trial_error, provider = эта
   * модель, reason breaker/model/internal) за те же сутки — гости своих
   * ходов в chat_quality/claude_cli_call не пишут при стене до вызова CLI;
   * guests — только гостевая часть failed (для строки «из них гостям»).
   */
  private async dayCounts(provider: FallbackProvider): Promise<GlobalLlmDayCounts> {
    const r = await this.pg.query(
      `SELECT
         count(*) FILTER (
           WHERE props->>'provider' = $1 AND coalesce(props->>'ok', 'true') = 'true'
         )::int AS answered,
         count(*) FILTER (
           WHERE props->>'provider' IS NOT NULL AND props->>'provider' <> $1
             AND coalesce(props->>'ok', 'true') <> 'false'
         )::int AS by_other,
         count(*) FILTER (
           WHERE name = 'chat_quality' AND (props->>'ok' = 'false' OR props->>'provider' IS NULL)
         )::int AS failed,
         (SELECT count(*) FROM events
            WHERE ts > now() - interval '1 day'
              AND name = 'guest_trial_error'
              AND props->>'provider' = $1
              AND props->>'reason' IN ('breaker', 'model', 'internal'))::int AS guests
       FROM events
      WHERE ts > now() - interval '1 day'
        AND name IN ('chat_quality', 'claude_cli_call')
        AND props->>'choice' = 'global'
        AND props->>'selected' = $1`,
      [provider],
    );
    const row = r.rows[0] ?? {};
    const guests = Number(row.guests ?? 0);
    return {
      answered: Number(row.answered ?? 0),
      byOther: Number(row.by_other ?? 0),
      failed: Number(row.failed ?? 0) + guests,
      guests,
    };
  }
}
