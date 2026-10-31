import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { GlobalLlmProviderService } from '../common/services/global-llm-provider.service';
import { FallbackProvider, readFallbackConfigs } from '../common/services/llm-fallback';
import { PgService } from '../common/services/pg.service';
import { sendTelegramAlert } from '../common/telegram-alert';
import { reminderText } from '../common/global-llm-messages';
import { ClaudeHealthService } from './claude-health.service';

/**
 * Раз в сутки, пока общий рубильник не на Claude, — напоминание в группу
 * алертов (spec 2026-10-31-global-llm-switch, раздел 8): возврат только
 * вручную, и про него легко забыть после аварии. Состояние Claude — по
 * последней пробе живости (ClaudeHealthService, раз в 15 минут). Счёт за
 * сутки — по событиям: релей ходы «по выбору» в /health.fallback не считает,
 * и сбои модели рубильника иначе не видны.
 */
@Injectable()
export class GlobalLlmReminderService {
  private readonly logger = new Logger(GlobalLlmReminderService.name);

  constructor(
    private readonly global: GlobalLlmProviderService,
    private readonly health: ClaudeHealthService,
    private readonly pg: PgService,
  ) {}

  @Cron('0 0 10 * * *', { name: 'global-llm-reminder', timeZone: 'Europe/Moscow' })
  async daily(): Promise<void> {
    await this.remind();
  }

  /** true — напоминание отправлено. */
  async remind(now: Date = new Date()): Promise<boolean> {
    const s = await this.global.status().catch((e: any) => {
      this.logger.warn(`рубильник: статус не прочитан: ${e?.message}`);
      return null;
    });
    if (!s || s.provider === 'claude') return false;
    const provider = s.provider as FallbackProvider;
    const overview: any = await this.health.getOverview().catch(() => null);
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
    await sendTelegramAlert(text).catch((e: any) => this.logger.warn(`напоминание о рубильнике не отправлено: ${e?.message}`));
    return true;
  }

  /** Ответы за сутки по выбору рубильника: ok — ответила его модель, other —
   *  ответил другой (она не ответила; у chat_quality — и неудачные ходы). */
  private async dayCounts(provider: FallbackProvider): Promise<{ ok: number; other: number }> {
    const r = await this.pg.query(
      `SELECT count(*) FILTER (WHERE props->>'provider' = $1)::int AS ok,
              count(*) FILTER (WHERE props->>'provider' IS DISTINCT FROM $1)::int AS other
         FROM events
        WHERE ts > now() - interval '1 day'
          AND name IN ('chat_quality', 'claude_cli_call')
          AND props->>'choice' = 'global'
          AND props->>'selected' = $1`,
      [provider],
    );
    return { ok: Number(r.rows[0]?.ok ?? 0), other: Number(r.rows[0]?.other ?? 0) };
  }
}
