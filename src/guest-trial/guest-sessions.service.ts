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

/** Известные причины guest_trial_error (ход гостя, src/guest-trial/guest-turn.service.ts) —
 *  предзаполняются нулями в status(), чтобы админ-ручка не молчала про причину, которой сегодня не было. */
const KNOWN_ERROR_REASONS = ['busy', 'model', 'breaker', 'claimed', 'internal'];

/** numeric из pg (строка или число) → число, округлённое до цента. */
function toMoney(v: unknown): number {
  return Math.round(Number(v) * 100) / 100;
}

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

  /**
   * Пара «вопрос — ответ» и счёт пробы одним запросом. Отдаёт новое число
   * ответов — или null, если проба уже перенесена в аккаунт (claimed_at не
   * пуст): перенос мог случиться посреди хода (другая вкладка/устройство),
   * и дописывать пару в историю, которая уже не принадлежит пробе, нельзя.
   *
   * ins_human → ins_ai: вторая вставка читает ИЗ первой (FROM ins_human), а
   * не только из upd. Это настоящая зависимость данных, а не просто порядок
   * записи в тексте запроса — Postgres гарантирует её выполнение после
   * ins_human. Без этого порядок двух INSERT из одного VALUES/SELECT не
   * гарантирован, а messages() отдаёт пары по ORDER BY id: human обязан
   * получить id раньше ai, иначе пара перевернётся в истории промпта.
   */
  async recordExchange(sessionId: string, human: string, ai: string, humanAt: Date, costUsd: number): Promise<number | null> {
    const r = await this.pg.query(
      `WITH upd AS (
         UPDATE guest_trial_sessions
            SET answers = answers + 1, cost_usd = cost_usd + $5, last_message_at = now()
          WHERE id = $1::uuid AND claimed_at IS NULL
         RETURNING answers
       ),
       ins_human AS (
         INSERT INTO guest_trial_messages (session_id, sender_type, content, created_at)
         SELECT $1::uuid, 'human', $2, $4::timestamptz FROM upd
         RETURNING id
       ),
       ins_ai AS (
         INSERT INTO guest_trial_messages (session_id, sender_type, content, created_at)
         SELECT $1::uuid, 'ai', $3, now() FROM ins_human
       )
       SELECT answers FROM upd`,
      [sessionId, human, ai, humanAt, costUsd],
    );
    return r.rows[0] ? Number(r.rows[0].answers) : null;
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
     * answers_day/answers_week и cost_usd_day/cost_usd_week — из событий
     * guest_trial_answer (пишет ход гостя,
     * задача A7: ts — момент ответа, props.cost_usd — его стоимость), а НЕ из
     * guest_trial_sessions.answers/cost_usd по created_at пробы: проба может
     * отвечать до 7 дней после создания, и привязка к created_at отнесла бы
     * все её ответы на день создания пробы, а не на день самого ответа. Кроме
     * того, после переноса пробы в аккаунт её сообщения стираются — строка
     * guest_trial_sessions не остаётся надёжным источником истории ответов.
     *
     * Ревью A10: events/track открыта без JWT — props приходит от кого
     * угодно. jsonb_typeof-проверка не даёт нечисловому cost_usd (строка "x",
     * "1e400" и т.п.) дойти до ::numeric — такой cast бросает ошибку и роняет
     * ВЕСЬ status() на 7 дней, пока мусорная строка не устареет из окна. Сумму
     * не кастуем в ::float здесь — переполнение double на честном, но огромном
     * numeric тоже кидает ошибку; округление до цента — уже в JS (toMoney).
     */
    const a = await this.pg.query(
      `SELECT count(*) FILTER (WHERE ts > now() - interval '1 day')::int AS answers_day,
              count(*)::int AS answers_week,
              coalesce(sum(CASE WHEN jsonb_typeof(props->'cost_usd') = 'number' THEN (props->'cost_usd')::numeric END) FILTER (WHERE ts > now() - interval '1 day'), 0) AS cost_usd_day,
              coalesce(sum(CASE WHEN jsonb_typeof(props->'cost_usd') = 'number' THEN (props->'cost_usd')::numeric END), 0) AS cost_usd_week
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
    // cost_usd_* пришли из pg как numeric (строка или число — зависит от
    // парсера типов) — округляем до цента в JS, а не ::float в SQL (ревью A10,
    // см. комментарий у запроса выше).
    out.cost_usd_day = toMoney(a.rows[0].cost_usd_day);
    out.cost_usd_week = toMoney(a.rows[0].cost_usd_week);
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
    // Отказы хода гостя — отдельной разбивкой по причине (ревью A7, N1):
    // guest_trial_error_<reason>_day/_week. Известные причины — нулями
    // заранее.
    const err = await this.pg.query(
      `SELECT props->>'reason' AS reason,
              count(*) FILTER (WHERE ts > now() - interval '1 day')::int AS day,
              count(*)::int AS week
         FROM events
        WHERE name = 'guest_trial_error' AND ts > now() - interval '7 days'
        GROUP BY 1`,
    );
    for (const reason of KNOWN_ERROR_REASONS) {
      out[`guest_trial_error_${reason}_day`] = 0;
      out[`guest_trial_error_${reason}_week`] = 0;
    }
    for (const row of err.rows) {
      // Ревью A10: events/track открыта, reason — из props, чужой ввод.
      // Опечатка/подделка не должна заводить новый ключ статистики — цифры
      // воронки не должно быть видно отличить от «такого отказа не было».
      if (!KNOWN_ERROR_REASONS.includes(row.reason)) continue;
      out[`guest_trial_error_${row.reason}_day`] = row.day;
      out[`guest_trial_error_${row.reason}_week`] = row.week;
    }
    // Возраст самой старой неперенесённой пробы — 0, если таких нет. Если
    // уборка (guest-trial.cron.ts) сломана, число растёт без остановки —
    // сигнал виден прямо в админ-ручке, без отдельного алерта (ревью A10).
    const oldest = await this.pg.query(
      `SELECT COALESCE(FLOOR(EXTRACT(EPOCH FROM (now() - min(last_message_at))) / 86400), 0)::int AS days
         FROM guest_trial_sessions WHERE claimed_at IS NULL`,
    );
    out.oldest_unclaimed_days = oldest.rows[0]?.days ?? 0;
    return out;
  }
}
