import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PgService } from '../common/services/pg.service';
import { LiveKitClient } from './livekit.client';
import { JOB_TIMEOUT_MS } from './voice-call.types';

/**
 * Подбирает звонки и job'ы, за которых некому отчитаться.
 *
 * Воркер шлёт `complete`/`failed` сам, но если он умер — OOM при
 * `max_memory_restart`, деплой, падение хоста — не пришлёт уже никогда, и
 * строка останется `dialing`/`active` навсегда. Два следствия, оба неприятные:
 *
 *   1. процедура из infra/livekit/README.md «перед рестартом SFU проверь,
 *      что нет активных звонков» со временем начнёт всегда возвращать
 *      ненулевое число и перестанет работать как светофор;
 *   2. лимит «один активный звонок на пользователя» намертво заблокирует
 *      человеку возможность позвонить снова.
 *
 * Порог намеренно щедрый: час — наш собственный потолок длительности звонка,
 * плюс запас. Живой разговор под реапер не попадёт.
 */
const STALE_CALL_MS = 70 * 60 * 1000;

@Injectable()
export class VoiceCallReaperService {
  private readonly logger = new Logger(VoiceCallReaperService.name);

  constructor(
    private readonly pg: PgService,
    private readonly livekit: LiveKitClient,
  ) {}

  @Cron('0 */5 * * * *') // каждые 5 минут
  async reap(): Promise<void> {
    try {
      const stale = await this.pg.query(
        `UPDATE voice_calls
            SET status = 'interrupted', ended_at = now()
          WHERE status IN ('dialing', 'active')
            AND started_at < now() - ($1 || ' milliseconds')::interval
          RETURNING id, room_name`,
        [String(STALE_CALL_MS)],
      );

      for (const row of stale.rows) {
        this.logger.warn(`[reap] звонок ${row.id} висел дольше порога — закрываю комнату`);
        await this.livekit.closeRoom(row.room_name);
      }

      // Job'ы переживших звонков: воркер про них уже не спросит.
      const jobs = await this.pg.query(
        `UPDATE voice_call_jobs
            SET status = 'failed', finished_at = now()
          WHERE status IN ('queued', 'running')
            AND created_at < now() - ($1 || ' milliseconds')::interval
          RETURNING id`,
        [String(JOB_TIMEOUT_MS * 2)],
      );

      if (jobs.rowCount) this.logger.warn(`[reap] ${jobs.rowCount} зависших job закрыто`);
    } catch (e: any) {
      // Реапер не должен ронять планировщик — он вспомогательный.
      this.logger.error(`[reap] failed: ${e?.message}`);
    }
  }
}
