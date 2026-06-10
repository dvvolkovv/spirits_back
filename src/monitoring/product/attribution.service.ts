import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../../common/services/pg.service';

/**
 * Attribution — воронка по источникам привлечения (UTM/referral/referrer).
 *
 * Закрывает critical-задачу Виртуального маркетолога (d5245dce): перед запуском
 * платной рекламы нужно видеть атрибуцию ВПЛОТЬ до оплаты, иначе CAC по каналу
 * не посчитать. Source захватывается фронтом (eventsClient) на анонимном
 * landing_view (events.source: utm:<src>/<medium> | referral:<slug> |
 * ref-site:<host> | direct) и наследуется последующими событиями по session_id.
 *
 * First-touch модель: источник пользователя = source самого раннего его события.
 * Тестовые номера и админы (включая владельца) исключены из регистраций/оплат.
 */

const TEST_USERS = ['70000000000', '79030169187', '79169403771', '79656445804'];
const TEST_PATTERN = '^790300[0-9]{5}$';

export interface AttributionRow {
  source: string;
  landings: number;        // landing_view за окно (верх воронки, до регистрации)
  registrations: number;   // зарегистрировались за окно
  activated: number;       // дошли до первого чата
  payers: number;          // хоть раз заплатили
  revenueRub: number;      // суммарная выручка от этих юзеров
}

export interface AttributionOverview {
  generatedAt: string;
  windowDays: number;
  rows: AttributionRow[];
  totals: { landings: number; registrations: number; activated: number; payers: number; revenueRub: number };
  note: string;
}

@Injectable()
export class AttributionService {
  private readonly log = new Logger(AttributionService.name);
  constructor(private readonly pg: PgService) {}

  async getOverview(windowDays = 30): Promise<AttributionOverview> {
    const wd = Math.min(Math.max(Math.round(windowDays) || 30, 1), 365);

    // Лендинги по источникам (анонимный верх воронки).
    let landings: Record<string, number> = {};
    try {
      const r = await this.pg.query(
        `SELECT COALESCE(NULLIF(source,''),'unknown') AS source, COUNT(*)::int AS n
           FROM events
          WHERE name='landing_view' AND ts > now() - ($1 || ' days')::interval
          GROUP BY 1`,
        [String(wd)],
      );
      landings = Object.fromEntries(r.rows.map((x: any) => [x.source, Number(x.n)]));
    } catch (e: any) { this.log.warn(`attribution landings failed: ${e.message}`); }

    // Регистрации → активация → оплата по first-touch источнику.
    let funnelRows: any[] = [];
    try {
      const r = await this.pg.query(
        `WITH regs AS (
           SELECT user_id, signup_source FROM ai_profiles_consolidated
            WHERE created_at > now() - ($1 || ' days')::interval
              AND user_id <> ALL($2) AND user_id !~ $3
              AND user_id NOT IN (SELECT user_id FROM ai_profiles_consolidated WHERE isadmin = true)
         ),
         -- session_id'ы зарегистрировавшихся (из их событий, где user_id уже есть)
         sess AS (
           SELECT DISTINCT e.session_id, e.user_id
             FROM events e JOIN regs r ON r.user_id = e.user_id
            WHERE e.session_id IS NOT NULL
         ),
         -- источник ПРИВЛЕЧЕНИЯ по сессии: самое раннее событие с source. source
         -- захватывается на АНОНИМНОМ landing_view (user_id=null) — поэтому связь
         -- идёт через session_id, а НЕ через user_id (иначе все регистрации
         -- падают в 'unknown' — баг до 2026-06-10). Внутренние метки
         -- (chat.saveChatHistory и пр.) отфильтрованы.
         src AS (
           SELECT DISTINCT ON (e.session_id) e.session_id, e.source, e.ts
             FROM events e
            WHERE e.source IS NOT NULL
              AND (e.source LIKE 'utm:%' OR e.source LIKE 'referral:%'
                   OR e.source LIKE 'ref-site:%' OR e.source IN ('direct','organic'))
            ORDER BY e.session_id, e.ts ASC
         ),
         -- first-touch источник юзера = source его самой ранней сессии с source
         first_src AS (
           SELECT DISTINCT ON (sess.user_id) sess.user_id, src.source
             FROM sess JOIN src ON src.session_id = sess.session_id
            ORDER BY sess.user_id, src.ts ASC
         ),
         chat AS (
           SELECT split_part(session_id,'_',1) AS uid, min(created_at) AS first_chat
             FROM custom_chat_history WHERE sender_type='human' GROUP BY 1
         ),
         pay AS (
           SELECT user_id, SUM(amount)::numeric AS rev
             FROM payments WHERE status='succeeded' GROUP BY 1
         )
         -- Источник: НАДЁЖНЫЙ signup_source (записан при регистрации) приоритетнее
         -- session-эвристики fs (она не доживает между визитами/доменами).
         SELECT COALESCE(NULLIF(r.signup_source,''), fs.source, 'unknown') AS source,
                COUNT(*)::int                                        AS registrations,
                COUNT(*) FILTER (WHERE c.uid IS NOT NULL)::int       AS activated,
                COUNT(*) FILTER (WHERE p.user_id IS NOT NULL)::int   AS payers,
                COALESCE(SUM(p.rev),0)::numeric                      AS revenue
           FROM regs r
           LEFT JOIN first_src fs ON fs.user_id = r.user_id
           LEFT JOIN chat c      ON c.uid = r.user_id
           LEFT JOIN pay p       ON p.user_id = r.user_id
          GROUP BY 1`,
        [String(wd), TEST_USERS, TEST_PATTERN],
      );
      funnelRows = r.rows;
    } catch (e: any) { this.log.warn(`attribution funnel failed: ${e.message}`); }

    // Слияние по источнику.
    const bySource = new Map<string, AttributionRow>();
    const ensure = (s: string): AttributionRow => {
      if (!bySource.has(s)) bySource.set(s, { source: s, landings: 0, registrations: 0, activated: 0, payers: 0, revenueRub: 0 });
      return bySource.get(s)!;
    };
    for (const [s, n] of Object.entries(landings)) ensure(s).landings = n;
    for (const row of funnelRows) {
      const r = ensure(String(row.source));
      r.registrations = Number(row.registrations) || 0;
      r.activated = Number(row.activated) || 0;
      r.payers = Number(row.payers) || 0;
      r.revenueRub = Math.round(Number(row.revenue) || 0);
    }

    const rows = Array.from(bySource.values()).sort(
      (a, b) => (b.registrations - a.registrations) || (b.landings - a.landings),
    );
    const totals = rows.reduce(
      (t, r) => ({
        landings: t.landings + r.landings,
        registrations: t.registrations + r.registrations,
        activated: t.activated + r.activated,
        payers: t.payers + r.payers,
        revenueRub: t.revenueRub + r.revenueRub,
      }),
      { landings: 0, registrations: 0, activated: 0, payers: 0, revenueRub: 0 },
    );

    return {
      generatedAt: new Date().toISOString(),
      windowDays: wd,
      rows,
      totals,
      note:
        'First-touch: источник юзера = самое раннее его событие с source. ' +
        'Историч. юзеры без захваченного source → "unknown" (source-трекинг на фронте появился недавно). ' +
        'landings — анонимный верх воронки (до регистрации); registrations/activated/payers — исключают тест-номера и админов. ' +
        'utm:<source>/<medium> — UTM-метки; referral:<slug>; ref-site:<host>; direct.',
    };
  }
}
