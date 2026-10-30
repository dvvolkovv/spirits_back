import { Injectable } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { GUEST_CLAIMED_ROW_TTL_DAYS, GUEST_TRIAL_TTL_DAYS, GuestHistoryMessage } from './guest-trial.types';

export interface GuestSessionRow {
  id: string;
  assistant_id: number;
  lang: string;
  answers: number;
  claimed_by_hash: string | null;
  claimed_at: Date | null;
  last_message_at: Date;
}

const ROW = `id::text AS id, assistant_id, lang, answers, claimed_by_hash, claimed_at, last_message_at`;

@Injectable()
export class GuestSessionsService {
  constructor(private readonly pg: PgService) {}

  async create(p: { tokenHash: string; assistantId: number; lang: string; source: string | null; campaign: string | null }): Promise<GuestSessionRow> {
    const r = await this.pg.query(
      `INSERT INTO guest_trial_sessions (token_hash, assistant_id, lang, source, campaign)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${ROW}`,
      [p.tokenHash, p.assistantId, p.lang, p.source, p.campaign],
    );
    return r.rows[0];
  }

  /** Проба по хешу ключа. Неперенесённая — только если последнему сообщению меньше 7 дней. */
  async findLive(tokenHash: string): Promise<GuestSessionRow | null> {
    const r = await this.pg.query(
      `SELECT ${ROW} FROM guest_trial_sessions
        WHERE token_hash = $1
          AND (claimed_at IS NOT NULL OR last_message_at > now() - make_interval(days => $2))`,
      [tokenHash, GUEST_TRIAL_TTL_DAYS],
    );
    return r.rows[0] ?? null;
  }

  async messages(sessionId: string): Promise<GuestHistoryMessage[]> {
    const r = await this.pg.query(
      `SELECT sender_type, content FROM guest_trial_messages WHERE session_id = $1::uuid ORDER BY id`,
      [sessionId],
    );
    return r.rows;
  }

  /** Пара «вопрос — ответ» и счёт пробы одним запросом. Отдаёт новое число ответов. */
  async recordExchange(sessionId: string, human: string, ai: string, humanAt: Date, costUsd: number): Promise<number> {
    const r = await this.pg.query(
      `WITH ins AS (
         -- Результат ins не читается — и не должен: модифицирующий CTE
         -- выполняется как часть одного оператора независимо от того,
         -- ссылается ли на него внешний запрос. Не удалять как «неиспользуемый».
         INSERT INTO guest_trial_messages (session_id, sender_type, content, created_at)
         VALUES ($1::uuid, 'human', $2, $4), ($1::uuid, 'ai', $3, now())
       )
       UPDATE guest_trial_sessions
          SET answers = answers + 1, cost_usd = cost_usd + $5, last_message_at = now()
        WHERE id = $1::uuid
       RETURNING answers`,
      [sessionId, human, ai, humanAt, costUsd],
    );
    return Number(r.rows[0]?.answers ?? 0);
  }

  /**
   * Неперенесённые — через 7 дней тишины, строки перенесённых (без текста) —
   * через 90 дней.
   *
   * Отдельно (ревью A3): claimed_by_hash — sha256 от userId без секрета, у
   * телефонных аккаунтов его можно восстановить перебором номеров. Хеш нужен
   * только около момента входа (повторный перенос тем же человеком), поэтому
   * он гаснет через 7 дней после переноса — раньше, чем удаляется сама строка
   * (90 дней). Возвращаемое число — только удалённые строки, обнуление хеша
   * в него не входит.
   */
  async purge(): Promise<number> {
    await this.pg.query(
      `UPDATE guest_trial_sessions SET claimed_by_hash = NULL
        WHERE claimed_by_hash IS NOT NULL AND claimed_at < now() - make_interval(days => $1)`,
      [GUEST_TRIAL_TTL_DAYS],
    );
    const r = await this.pg.query(
      `DELETE FROM guest_trial_sessions
        WHERE (claimed_at IS NULL AND last_message_at < now() - make_interval(days => $1))
           OR (claimed_at IS NOT NULL AND claimed_at < now() - make_interval(days => $2))`,
      [GUEST_TRIAL_TTL_DAYS, GUEST_CLAIMED_ROW_TTL_DAYS],
    );
    return r.rowCount ?? 0;
  }

  /** Счётчики для админ-ручки: сутки и 7 дней. */
  async status(): Promise<Record<string, number>> {
    const s = await this.pg.query(
      `SELECT count(*) FILTER (WHERE created_at > now() - interval '1 day')::int AS trials_day,
              count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS trials_week,
              count(*) FILTER (WHERE claimed_at > now() - interval '1 day')::int AS claims_day,
              count(*) FILTER (WHERE claimed_at > now() - interval '7 days')::int AS claims_week
         FROM guest_trial_sessions`,
    );
    /**
     * answers_*/cost_usd_* — из событий guest_trial_answer (пишет ход гостя,
     * задача A7: ts — момент ответа, props.cost_usd — его стоимость), а НЕ из
     * guest_trial_sessions.answers/cost_usd по created_at пробы: проба может
     * отвечать до 7 дней после создания, и привязка к created_at отнесла бы
     * все её ответы на день создания пробы, а не на день самого ответа. Кроме
     * того, после переноса пробы в аккаунт её сообщения стираются — строка
     * guest_trial_sessions не остаётся надёжным источником истории ответов.
     */
    const a = await this.pg.query(
      `SELECT count(*) FILTER (WHERE ts > now() - interval '1 day')::int AS answers_day,
              count(*)::int AS answers_week,
              coalesce(sum((props->>'cost_usd')::numeric) FILTER (WHERE ts > now() - interval '1 day'), 0)::float AS cost_usd_day,
              coalesce(sum((props->>'cost_usd')::numeric), 0)::float AS cost_usd_week
         FROM events
        WHERE name = 'guest_trial_answer' AND ts > now() - interval '7 days'`,
    );
    const e = await this.pg.query(
      `SELECT name,
              count(*) FILTER (WHERE ts > now() - interval '1 day')::int AS day,
              count(*)::int AS week
         FROM events
        WHERE name IN ('guest_trial_view', 'guest_trial_wall', 'guest_trial_closed')
          AND ts > now() - interval '7 days'
        GROUP BY name`,
    );
    const out: Record<string, number> = { ...s.rows[0], ...a.rows[0] };
    // Ключи есть всегда, даже без единого события — иначе админ-ручка то
    // показывает ноль, то молчит про ключ вовсе, в зависимости от трафика.
    for (const name of ['guest_trial_view', 'guest_trial_wall', 'guest_trial_closed']) {
      out[`${name}_day`] = 0;
      out[`${name}_week`] = 0;
    }
    for (const row of e.rows) {
      out[`${row.name}_day`] = row.day;
      out[`${row.name}_week`] = row.week;
    }
    return out;
  }
}
