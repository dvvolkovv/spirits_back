import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { TasksService } from '../tasks/tasks.service';

/**
 * Daily cron — переводит активные tasks без событий >60 дней в архив.
 * Сами задачи никогда не удаляются (вечный лог) — recall_task tool
 * вытащит их semantic-search'ем когда юзер вспомнит.
 */
@Injectable()
export class TaskArchiverService {
  private readonly logger = new Logger(TaskArchiverService.name);

  constructor(@Optional() private readonly tasks?: TasksService) {}

  @Cron('30 4 * * *') // 04:30 UTC — после profile compaction (04:00)
  async archiveStaleTasks() {
    if (!this.tasks) return;
    try {
      const n = await this.tasks.archiveStale();
      if (n > 0) this.logger.log(`archived ${n} stale tasks`);
    } catch (e: any) {
      this.logger.error(`archiveStaleTasks failed: ${e?.message}`);
    }
  }
}
