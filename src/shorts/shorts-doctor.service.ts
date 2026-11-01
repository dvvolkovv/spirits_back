import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { newSceneNote, prescribe, recoveryEntry } from './short-doctor';
import { autoHealEnabled } from './short-env';
import { ShortVideo, appendOwnerNote, retryTarget } from './shorts.types';

/** took — самопочинка записана; gave_up — не взялся (сообщение владельцу); gone — ролик ушёл из failed: владелец успел сам. */
export type TreatOutcome = 'took' | 'gave_up' | 'gone';

/**
 * Доктор упавших роликов (спека самовосстановления, «Доктор»). Разбор упавших
 * (ShortsApprovalService.notifyFailures) спрашивает его до сообщения владельцу.
 * Решение — prescribe (short-doctor.ts), здесь — запись.
 *
 * Каждая запись — по захваченному сбою (status = 'failed', failed_from,
 * failure_notified): владелец мог нажать кнопку, пока решали, — тогда доктор
 * ничего не пишет, а разбор молчит. Выход из failed — как у «Повторить»
 * (shorts.controller.ts, retry): попытки, ошибка, этап и код сбоя обнуляются,
 * failure_notified = false — следующий сбой снова дойдёт до разбора. Причина и
 * код остаются в истории (recoveries). Публикацию доктор не трогает, поэтому
 * общего кода с retry нет: у него свои три записи.
 */
@Injectable()
export class ShortsDoctorService {
  private readonly logger = new Logger(ShortsDoctorService.name);

  constructor(private readonly pg: PgService) {}

  async treat(v: ShortVideo, now: Date = new Date()): Promise<TreatOutcome> {
    if (!autoHealEnabled() || v.status !== 'failed') return 'gave_up';
    const p = prescribe(v);
    if (p.action === 'never') return 'gave_up';
    const entry = JSON.stringify([recoveryEntry(v, p, now)]);
    const done = `attempts = 0, last_error = NULL, failed_from = NULL, failed_code = NULL, failure_notified = false,
            auto_recoveries = auto_recoveries + 1, recoveries = recoveries || $3::jsonb, updated_at = now()`;
    const where = `WHERE id = $1 AND status = 'failed' AND failed_from = $2 AND failure_notified`;
    let r: { rowCount?: number | null };
    if (p.action === 'later') {
      // Тот же этап в его очередь; пауза — аренда: claimStage и студия не берут ролик до её конца.
      r = await this.pg.query(
        `UPDATE short_video SET status = $4, lease_until = now() + make_interval(mins => $5), ${done} ${where}`,
        [v.id, v.failedFrom, entry, retryTarget(v), p.delayMin],
      );
    } else if (p.action === 'new_scene') {
      // Формат прежний: собранный без сценок ролик сам к сценкам не вернётся (кнопка владельца берёт формат из настроек).
      r = await this.pg.query(
        `UPDATE short_video SET status = 'directing', lease_until = NULL, writer_rounds = 0, owner_note = $4,
                writer_feedback = NULL, skit_feedback = NULL, ${done} ${where}`,
        [v.id, v.failedFrom, entry, appendOwnerNote(v.ownerNote, newSceneNote(v))],
      );
    } else {
      // Оживление (animation, счёт секунд Omni) не трогается: деньги ролика считаются за всё время.
      r = await this.pg.query(
        `UPDATE short_video SET status = 'writing', format = 'chat', lease_until = NULL, writer_rounds = 0,
                writer_feedback = NULL, skit_feedback = NULL, ${done} ${where}`,
        [v.id, v.failedFrom, entry],
      );
    }
    if (!r.rowCount) {
      // Владелец успел нажать кнопку (или сбой забрал другой экземпляр) — разбор промолчит; след — здесь.
      this.logger.log(`ролик ${v.id}: доктор опоздал — ролик уже не в захваченном сбое`);
      return 'gone';
    }
    const pause = p.action === 'later' ? ` через ${p.delayMin} мин` : '';
    this.logger.log(`ролик ${v.id}: сам — ${p.action}${pause} (${v.failedFrom}, ${v.failedCode ?? 'без кода'})`);
    return 'took';
  }
}
