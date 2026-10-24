import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InsightsService, MAX_POSTPONES } from './insights.service';
import { InsightsStore } from './insights-store.service';
import { previousWeekMsk } from './insights-week';

/**
 * Сервис с кроном — только в InsightsModule: провайдер с @Cron в нескольких
 * модулях срабатывает по разу на каждый (так вышло с PersonasService).
 */
@Injectable()
export class InsightsCron {
  private readonly log = new Logger('InsightsCron');

  constructor(
    private readonly store: InsightsStore,
    private readonly insights: InsightsService,
  ) {}

  /** Понедельник 04:07 UTC = 07:07 по Москве: трафик чатов минимален, подписка общая. */
  @Cron('0 7 4 * * 1')
  async weekly(): Promise<void> {
    try {
      await this.store.reapStale();
      if (!(await this.store.isEnabled())) return;
      await this.insights.runScheduled(previousWeekMsk(new Date()));
    } catch (e: any) {
      this.log.error(`еженедельный прогон: ${e?.message}`);
    }
  }

  /** Отложенные из-за лимита подписки — повтор, когда подошёл срок. */
  @Cron('0 */30 * * * *')
  async retryPostponed(): Promise<void> {
    try {
      await this.store.reapStale();
      for (const run of await this.store.duePostponed(MAX_POSTPONES)) await this.insights.retry(run);
    } catch (e: any) {
      this.log.error(`повтор отложенного прогона: ${e?.message}`);
    }
  }
}
