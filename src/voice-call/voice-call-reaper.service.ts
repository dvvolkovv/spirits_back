import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PgService } from '../common/services/pg.service';
import { AttendeeClient } from '../meeting/attendee.client';
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

/**
 * Встреча: потолок два часа плюс запас.
 *
 * Отдельный порог обязателен. С общим часовым реапер подбирал бы живые встречи
 * на втором часу и обрывал их как зависшие — то есть предохранитель убивал бы
 * ровно то, ради чего потолок и подняли.
 */
const STALE_MEETING_MS = 130 * 60 * 1000;

@Injectable()
export class VoiceCallReaperService {
  private readonly logger = new Logger(VoiceCallReaperService.name);

  constructor(
    private readonly pg: PgService,
    private readonly livekit: LiveKitClient,
    // Опционально: без Attendee реапер обязан продолжать работать — он
    // подбирает и обычные звонки, которым до Meet дела нет.
    @Optional() private readonly attendee?: AttendeeClient,
  ) {}

  @Cron('0 */5 * * * *') // каждые 5 минут
  async reap(): Promise<void> {
    try {
      const stale = await this.pg.query(
        `UPDATE voice_calls
            SET status = 'interrupted', ended_at = now()
          WHERE status IN ('dialing', 'active')
            AND provider = 'linkeon'
            AND started_at < now() - ($1 || ' milliseconds')::interval
          RETURNING id, room_name`,
        [String(STALE_CALL_MS)],
      );

      for (const row of stale.rows) {
        this.logger.warn(`[reap] звонок ${row.id} висел дольше порога — закрываю комнату`);
        // Комната создана ради этого звонка и вместе с ним и уходит.
        await this.livekit.closeRoom(row.room_name);
      }

      const staleMeetings = await this.pg.query(
        `UPDATE voice_calls
            SET status = 'interrupted', ended_at = now()
          WHERE status IN ('dialing', 'active')
            AND provider <> 'linkeon'
            AND started_at < now() - ($1 || ' milliseconds')::interval
          RETURNING id, room_name, external_bot_id`,
        [String(STALE_MEETING_MS)],
      );

      for (const row of staleMeetings.rows) {
        this.logger.warn(`[reap] встреча ${row.id} висела дольше порога — выгоняю ассистента`);
        // Комнату НЕ закрываем: в ней могут быть живые люди, и закрытие
        // выкинуло бы их всех из-за того, что зависла наша половина.
        await this.livekit.removeAgents(row.room_name);
        if (row.external_bot_id) await this.sweepBot(row.id, row.external_bot_id);
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

      await this.sweepForgottenBots();
    } catch (e: any) {
      // Реапер не должен ронять планировщик — он вспомогательный.
      this.logger.error(`[reap] failed: ${e?.message}`);
    }
  }

  /**
   * Повторные попытки вывести забытых ботов.
   *
   * Первая попытка (при leave или в ветке встреч выше) могла не дозвониться:
   * контейнер Attendee перезапускается, и это ожидаемое событие. Строка к
   * тому моменту уже в терминальном статусе, и прежним запросом её больше не
   * выбрать — значит нужен отдельный проход по непустому external_bot_id.
   *
   * Без этого забытый Chrome остаётся сидеть в чужих переговорах клиента до
   * конца встречи.
   */
  private async sweepForgottenBots(): Promise<void> {
    const rows = await this.pg.query(
      `SELECT id, external_bot_id FROM voice_calls
        WHERE external_bot_id IS NOT NULL
          AND status NOT IN ('dialing', 'active')
        LIMIT 50`,
    );
    for (const row of rows.rows) await this.sweepBot(row.id, row.external_bot_id);
  }

  /**
   * Убрать одного бота и решить, помечать ли запись убранной.
   *
   * Три исхода removeBot различаются не для красоты: `null` означает, что
   * состояние бота НЕИЗВЕСТНО. Обнулить колонку в этом случае значит навсегда
   * забыть про бота, который, возможно, всё ещё сидит в встрече.
   */
  private async sweepBot(callId: string, botId: string): Promise<void> {
    if (!this.attendee) return;
    const res = await this.attendee.removeBot(botId).catch(() => null);
    if (res === null) {
      this.logger.warn(`[reaper] бот ${botId} call=${callId}: состояние неизвестно, повторим`);
      return;
    }
    await this.pg.query(`UPDATE voice_calls SET external_bot_id = NULL WHERE id = $1`, [callId]);
  }
}
