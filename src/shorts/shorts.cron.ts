import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PgService } from '../common/services/pg.service';
import { autoTopicsEnabled, shortsEnabled } from './short-env';
import { ApiStage, claimStage, stageFailed, withStageDeadline } from './short-jobs';
import { ShortsApprovalService } from './shorts-approval.service';
import { ShortsDirectorService } from './shorts-director.service';
import { ShortsPublisherService } from './shorts-publisher.service';
import { ShortsTopicService } from './shorts-topic.service';
import { ShortsWriterService } from './shorts-writer.service';
import { ShortVideo } from './shorts.types';

/**
 * Тики конвейера роликов. ScheduleModule подключён глобально (app.module.ts),
 * @Cron заводится сам, как у BlogCron. Тики одного процесса могут
 * перекрываться, процессов API может быть несколько — от дублей защищают
 * захваты с арендой в самих шагах, а не очерёдность тиков.
 */
@Injectable()
export class ShortsCron {
  private readonly logger = new Logger(ShortsCron.name);

  constructor(
    private readonly pg: PgService,
    private readonly topics: ShortsTopicService,
    private readonly director: ShortsDirectorService,
    private readonly writer: ShortsWriterService,
    private readonly approval: ShortsApprovalService,
    private readonly publisher: ShortsPublisherService,
  ) {}

  /** Воскресенье 10:00 МСК — через час после наполнения блога. */
  @Cron('0 7 * * 0')
  async refillTopics(): Promise<void> {
    if (!shortsEnabled() || !autoTopicsEnabled()) return;
    await this.step('наполнение недели', () => this.topics.refillWeek());
  }

  @Cron('*/10 * * * *')
  async prepare(): Promise<void> {
    if (!shortsEnabled() || !autoTopicsEnabled()) return;
    await this.step('запуск к слоту', async () => {
      const v = await this.topics.start({ force: false });
      if (v) this.logger.log(`ролик ${v.id} запущен под слот ${v.slotAt?.toISOString()} (подача ${v.angle})`);
    });
  }

  @Cron('* * * * *')
  async work(): Promise<void> {
    if (!shortsEnabled()) return;
    await this.step('режиссёр', () => this.runStage('directing', 'режиссёр', (v) => this.director.direct(v)));
    await this.step('сценарист', () => this.runStage('writing', 'сценарист', (v) => this.writer.write(v)));
    await this.step('отправка владельцу', () => this.approval.sendPendingReviews());
    await this.step('сообщения о сбоях', () => this.approval.notifyFailures());
  }

  @Cron('*/5 * * * *')
  async publishDue(): Promise<void> {
    if (!shortsEnabled()) return;
    await this.step('сторож публикаций', () => this.publisher.rearmStuck());
    await this.step('публикация', () => this.publisher.publishDue());
  }

  /** Один ролик этапа: захват с арендой, работа, при сбое — повтор с паузой или failed. */
  async runStage(status: ApiStage, label: string, run: (v: ShortVideo) => Promise<void>): Promise<void> {
    const v = await claimStage(this.pg, status);
    if (!v) return;
    try {
      // Срок этапа короче аренды: таймаут axios не действует после заголовков
      // ответа, и зависший релей иначе держал бы этап, пока его не заберёт второй процесс.
      await withStageDeadline(() => run(v));
    } catch (e: any) {
      const outcome = await stageFailed(this.pg, v, label, e);
      const what = outcome === 'retry' ? `повтор, попытка ${v.attempts}` : outcome === 'gone' ? 'ролик уже не на этапе' : 'failed';
      this.logger.warn(`ролик ${v.id}: ${label} — ${e?.message ?? e} (${what})`);
    }
  }

  private async step(name: string, run: () => Promise<unknown>): Promise<void> {
    try {
      await run();
    } catch (e: any) {
      this.logger.error(`тик роликов, ${name}: ${e?.message ?? e}`);
    }
  }
}
