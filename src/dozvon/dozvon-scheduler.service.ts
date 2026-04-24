import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PgService } from '../common/services/pg.service';
import { DozvonService } from './dozvon.service';

@Injectable()
export class DozvonSchedulerService {
  private readonly logger = new Logger(DozvonSchedulerService.name);
  private isRunning = false;

  constructor(
    private readonly pg: PgService,
    private readonly dozvon: DozvonService,
  ) {}

  @Cron('* * * * *')
  async checkScheduled() {
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      const res = await this.pg.query(
        `SELECT id, user_id FROM dozvon_campaigns
         WHERE status = 'scheduled' AND scheduled_at <= now()
         ORDER BY scheduled_at ASC LIMIT 5`,
      );
      for (const row of res.rows) {
        this.logger.log(`Executing scheduled campaign ${row.id}`);
        setImmediate(() =>
          this.dozvon.executeCampaign(row.user_id, row.id).catch(err =>
            this.logger.error(`Scheduled campaign ${row.id} error: ${err.message}`),
          ),
        );
      }
    } catch (err: any) {
      this.logger.error(`Scheduler error: ${err.message}`);
    } finally {
      this.isRunning = false;
    }
  }

  @Cron('*/2 * * * *')
  async cleanupStaleCalls() {
    await this.pg.query(
      `UPDATE dozvon_calls SET status = 'failed', summary = 'Timeout (stale)'
       WHERE status IN ('dialing','in_call') AND created_at < now() - interval '15 minutes'`,
    );
  }
}
