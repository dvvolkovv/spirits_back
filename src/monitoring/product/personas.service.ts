import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../../common/services/pg.service';

/**
 * Personas — see monitoring.functions.md §3.9.
 *
 * Rule-based assignment, not clustering — at 40 active users k-means
 * gives noise. Recompute on each request (small dataset). When the
 * user base grows past ~500, persist into a user_personas table and
 * run a nightly cron instead.
 *
 * Rules:
 *   content_creator   ≥ 5 image/video generations
 *   smm               ≥ 40% messages to assistants with category 'smm'
 *   business          ≥ 40% messages to assistants with category 'business'
 *   personal_growth   ≥ 40% messages to assistants with category 'personal'
 *   curious           total messages < 5
 *   mixed             everything else
 *
 * Test users are excluded via the existing FUNNEL_EXCLUDED_USERS env.
 */

const DEFAULT_EXCLUDED = ['70000000000', '79030169187'];
const EXCLUDED = (process.env.FUNNEL_EXCLUDED_USERS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const excluded = EXCLUDED.length > 0 ? EXCLUDED : DEFAULT_EXCLUDED;

export type PersonaKey = 'business' | 'personal_growth' | 'content_creator' | 'smm' | 'curious' | 'mixed';

export interface PersonaBucket {
  key: PersonaKey;
  label: string;
  description: string;
  users: number;
  sharePct: number;
  avgPaymentRub: number | null;
  avgMessages: number | null;
  activeInLast14d: number;
  retention14dPct: number | null;
  topAssistants: Array<{ name: string; displayName: string | null; share: number }>;
}

export interface PersonasOverview {
  generatedAt: string;
  excludedUsers: string[];
  totalUsers: number;
  buckets: PersonaBucket[];
}

const PERSONA_META: Record<PersonaKey, { label: string; description: string }> = {
  business: {
    label: 'Предприниматель',
    description: 'Работает с бизнес-ассистентами (юрист/HR/маркетолог/бухгалтер). Приходит за конкретными документами и текстами. Отвалится если ответы будут поверхностными.',
  },
  personal_growth: {
    label: 'Personal growth',
    description: 'Коуч/психолог/игропрактик. Приходит поговорить, разобраться в себе. Удерживает растущий профиль и динамика. Отвалится если профиль не растёт.',
  },
  content_creator: {
    label: 'Создатель контента',
    description: 'Активно генерирует изображения/видео. Удерживается через скорость и качество генераций.',
  },
  smm: {
    label: 'SMM',
    description: 'Работает с SMM-ассистентом (Юлей). Постит, сценарии, публикации.',
  },
  curious: {
    label: 'Любопытствующий',
    description: 'Менее 5 сообщений за всё время. На стадии «попробовать». Отвалится если стартовых токенов не хватит на ощущение ценности.',
  },
  mixed: {
    label: 'Смешанный профиль',
    description: 'Не доминирует одна категория ассистентов. Может быть в точке выбора или просто пробует разное.',
  },
};

@Injectable()
export class PersonasService {
  private readonly log = new Logger(PersonasService.name);
  constructor(private readonly pg: PgService) {}

  async getOverview(): Promise<PersonasOverview> {
    const sql = `
      WITH
      -- per-user message volume + category share
      msg AS (
        SELECT
          e.user_id,
          COUNT(*) AS total_msgs,
          SUM(CASE WHEN a.category = 'business' THEN 1 ELSE 0 END)::numeric AS biz_msgs,
          SUM(CASE WHEN a.category = 'personal' THEN 1 ELSE 0 END)::numeric AS per_msgs,
          SUM(CASE WHEN a.category = 'smm'      THEN 1 ELSE 0 END)::numeric AS smm_msgs,
          MAX(e.ts) AS last_msg_ts
        FROM events e
        LEFT JOIN agents a ON a.id::text = (e.props->>'assistant_id')
        WHERE e.name = 'message_sent'
          AND e.user_id IS NOT NULL
          AND e.user_id <> ALL($1::text[])
        GROUP BY e.user_id
      ),
      gen AS (
        SELECT user_id, SUM(c) AS gen_count FROM (
          SELECT user_id, COUNT(*) AS c FROM generated_images GROUP BY 1
          UNION ALL
          SELECT user_id, COUNT(*) AS c FROM video_jobs GROUP BY 1
        ) x GROUP BY 1
      ),
      pay AS (
        SELECT user_id, SUM(amount)::numeric AS revenue
        FROM payments WHERE status = 'succeeded' GROUP BY 1
      ),
      -- pick persona per user
      classified AS (
        SELECT
          m.user_id,
          m.total_msgs,
          COALESCE(g.gen_count, 0) AS gen_count,
          COALESCE(p.revenue, 0)   AS revenue,
          m.last_msg_ts,
          CASE
            WHEN COALESCE(g.gen_count, 0) >= 5         THEN 'content_creator'
            WHEN m.smm_msgs / m.total_msgs >= 0.40     THEN 'smm'
            WHEN m.biz_msgs / m.total_msgs >= 0.40     THEN 'business'
            WHEN m.per_msgs / m.total_msgs >= 0.40     THEN 'personal_growth'
            WHEN m.total_msgs < 5                      THEN 'curious'
            ELSE 'mixed'
          END AS persona
        FROM msg m
        LEFT JOIN gen g ON g.user_id = m.user_id
        LEFT JOIN pay p ON p.user_id = m.user_id
      )
      SELECT
        persona,
        COUNT(*)::int                                              AS users,
        AVG(revenue)::numeric(10,2)                                AS avg_revenue,
        AVG(total_msgs)::numeric(10,1)                             AS avg_messages,
        COUNT(*) FILTER (WHERE last_msg_ts >= now() - interval '14 days')::int AS active_14d
      FROM classified
      GROUP BY persona
    `;
    const rows = await this.pg.query(sql, [excluded]).catch((e) => {
      this.log.error(`personas main query failed: ${e.message}`);
      return { rows: [] };
    });

    // Top assistants per persona — separate query for clarity
    const topSql = `
      WITH msg AS (
        SELECT
          e.user_id,
          (e.props->>'assistant_id') AS aid,
          a.name AS aname,
          a.display_name AS dname,
          SUM(CASE WHEN a.category = 'business' THEN 1 ELSE 0 END) OVER (PARTITION BY e.user_id) AS biz,
          SUM(CASE WHEN a.category = 'personal' THEN 1 ELSE 0 END) OVER (PARTITION BY e.user_id) AS per,
          SUM(CASE WHEN a.category = 'smm'      THEN 1 ELSE 0 END) OVER (PARTITION BY e.user_id) AS smm,
          COUNT(*) OVER (PARTITION BY e.user_id) AS total
        FROM events e
        LEFT JOIN agents a ON a.id::text = (e.props->>'assistant_id')
        WHERE e.name = 'message_sent'
          AND e.user_id IS NOT NULL
          AND e.user_id <> ALL($1::text[])
      ),
      gen AS (
        SELECT user_id, SUM(c) AS gen_count FROM (
          SELECT user_id, COUNT(*) AS c FROM generated_images GROUP BY 1
          UNION ALL
          SELECT user_id, COUNT(*) AS c FROM video_jobs GROUP BY 1
        ) x GROUP BY 1
      ),
      user_persona AS (
        SELECT DISTINCT
          m.user_id,
          CASE
            WHEN COALESCE(g.gen_count, 0) >= 5                     THEN 'content_creator'
            WHEN m.smm / NULLIF(m.total, 0) >= 0.40                THEN 'smm'
            WHEN m.biz / NULLIF(m.total, 0) >= 0.40                THEN 'business'
            WHEN m.per / NULLIF(m.total, 0) >= 0.40                THEN 'personal_growth'
            WHEN m.total < 5                                       THEN 'curious'
            ELSE 'mixed'
          END AS persona
        FROM msg m
        LEFT JOIN gen g ON g.user_id = m.user_id
      ),
      cnt AS (
        SELECT up.persona, m.aname, m.dname, COUNT(*) AS msgs
        FROM msg m JOIN user_persona up ON up.user_id = m.user_id
        WHERE m.aname IS NOT NULL
        GROUP BY up.persona, m.aname, m.dname
      ),
      ranked AS (
        SELECT persona, aname, dname, msgs,
               ROW_NUMBER() OVER (PARTITION BY persona ORDER BY msgs DESC) AS rn,
               SUM(msgs) OVER (PARTITION BY persona) AS persona_total
        FROM cnt
      )
      SELECT persona, aname, dname, msgs, persona_total
      FROM ranked WHERE rn <= 3 ORDER BY persona, msgs DESC
    `;
    const topRows = await this.pg.query(topSql, [excluded]).catch(() => ({ rows: [] }));

    const topByPersona = new Map<string, Array<{ name: string; displayName: string | null; share: number }>>();
    for (const r of topRows.rows) {
      const p = r.persona;
      if (!topByPersona.has(p)) topByPersona.set(p, []);
      const total = Number(r.persona_total) || 1;
      topByPersona.get(p)!.push({
        name: r.aname,
        displayName: r.dname || null,
        share: Number(r.msgs) / total,
      });
    }

    const totalUsers = rows.rows.reduce((s, r: any) => s + parseInt(r.users, 10), 0);
    const buckets: PersonaBucket[] = (Object.keys(PERSONA_META) as PersonaKey[]).map((key) => {
      const row = rows.rows.find((r: any) => r.persona === key);
      const meta = PERSONA_META[key];
      const users = row ? parseInt(row.users, 10) : 0;
      const active14d = row ? parseInt(row.active_14d, 10) : 0;
      return {
        key,
        label: meta.label,
        description: meta.description,
        users,
        sharePct: totalUsers > 0 ? (users / totalUsers) * 100 : 0,
        avgPaymentRub: row && row.avg_revenue !== null ? Number(row.avg_revenue) : null,
        avgMessages: row && row.avg_messages !== null ? Number(row.avg_messages) : null,
        activeInLast14d: active14d,
        retention14dPct: users > 0 ? (active14d / users) * 100 : null,
        topAssistants: topByPersona.get(key) || [],
      };
    });

    return {
      generatedAt: new Date().toISOString(),
      excludedUsers: excluded,
      totalUsers,
      buckets: buckets.sort((a, b) => b.users - a.users),
    };
  }
}
