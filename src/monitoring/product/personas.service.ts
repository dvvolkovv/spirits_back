import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PgService } from '../../common/services/pg.service';

/**
 * Personas — see monitoring.functions.md §3.9.
 *
 * Rule-based assignment, not clustering — at 40 active users k-means
 * gives noise. The classification is plain SQL (no LLM → 0 tokens), but we
 * persist each run into `persona_runs` (snapshot + meta) so the admin sees
 * the same VPM-style "last run / cost" line and the «Обновить» button does a
 * real, observable recompute instead of a silent re-fetch. When the user base
 * grows past ~500, move the recompute onto a nightly cron.
 *
 * Rules:
 *   content_creator   ≥ 5 image/video generations
 *   smm               ≥ 40% messages to assistants with category 'smm'
 *   business          ≥ 40% messages to assistants with category 'business'
 *   personal_growth   ≥ 40% messages to assistants with category 'personal'
 *   curious           total messages < 5
 *   mixed             everything else
 *
 * Excluded from the calculation:
 *   - все админ-аккаунты (isadmin=true) — сюда же попадает владелец, т.к. раздел
 *     «Персоны» виден только под AdminGuard. Динамически, без хардкода номера.
 *   - канонический список тест-номеров (mirror auth.controller isTestPhone).
 *   - что добавлено в env FUNNEL_EXCLUDED_USERS.
 */

// Канонический whitelist тест-номеров (синхронно с auth.controller.isTestPhone).
const TEST_PHONES = ['70000000000', '79030169187', '79169403771', '79656445804'];
const ENV_EXCLUDED = (process.env.FUNNEL_EXCLUDED_USERS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
// Тест-номера + env. Админы исключаются отдельно подзапросом по isadmin (ловит
// владельца автоматически, даже если его номер не в списке).
const excluded = Array.from(new Set([...TEST_PHONES, ...ENV_EXCLUDED]));

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

export interface PersonaRunMeta {
  createdAt: string;
  triggeredBy: string | null;
  trigger: 'manual' | 'cron' | 'auto';
  durationMs: number | null;
  totalUsers: number;
  tokensSpent: number;     // всегда 0 — разметка правило-ориентированная, без LLM
  error: string | null;
}

export interface PersonasOverview {
  generatedAt: string;
  excludedUsers: string[];
  totalUsers: number;
  buckets: PersonaBucket[];
  lastRun?: PersonaRunMeta;   // мета пересчёта, породившего этот снапшот
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
export class PersonasService implements OnModuleInit {
  private readonly log = new Logger(PersonasService.name);
  constructor(private readonly pg: PgService) {}

  async onModuleInit() {
    // Лог пересчётов персон (VPM-стиль). tokens_spent всегда 0 — разметка
    // правило-ориентированная, без LLM; колонка есть для единообразия UI.
    try {
      await this.pg.query(`
        CREATE TABLE IF NOT EXISTS persona_runs (
          id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          triggered_by  text,
          trigger       text NOT NULL DEFAULT 'manual',
          duration_ms   integer,
          total_users   integer,
          tokens_spent  integer NOT NULL DEFAULT 0,
          error_message text,
          snapshot      jsonb,
          created_at    timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS persona_runs_created_idx ON persona_runs (created_at DESC);
      `);
    } catch (e: any) {
      this.log.error(`persona_runs migration failed: ${e.message}`);
    }
  }

  // Чистый пересчёт по правилам (SQL, без LLM). Возвращает overview без lastRun.
  private async computeOverview(): Promise<PersonasOverview> {
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
          AND e.user_id NOT IN (SELECT user_id FROM ai_profiles_consolidated WHERE isadmin = true)
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
          AND e.user_id NOT IN (SELECT user_id FROM ai_profiles_consolidated WHERE isadmin = true)
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
            WHEN m.smm::numeric / NULLIF(m.total, 0) >= 0.40       THEN 'smm'
            WHEN m.biz::numeric / NULLIF(m.total, 0) >= 0.40       THEN 'business'
            WHEN m.per::numeric / NULLIF(m.total, 0) >= 0.40       THEN 'personal_growth'
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

  // Реальный пересчёт: гоняет правила, замеряет время, пишет строку в
  // persona_runs (снапшот + мета) и возвращает свежий overview с lastRun.
  // Это то, что дёргает кнопка «Обновить» — наблюдаемое действие, а не тихий
  // повторный GET.
  async recompute(triggeredBy: string | null, trigger: 'manual' | 'cron' | 'auto' = 'manual'): Promise<PersonasOverview> {
    const t0 = Date.now();
    let overview: PersonasOverview | null = null;
    let error: string | null = null;
    try {
      overview = await this.computeOverview();
    } catch (e: any) {
      error = e?.message || String(e);
      this.log.error(`personas recompute failed: ${error}`);
    }
    const durationMs = Date.now() - t0;
    const totalUsers = overview?.totalUsers ?? 0;

    let createdAt = new Date().toISOString();
    try {
      const ins = await this.pg.query(
        `INSERT INTO persona_runs (triggered_by, trigger, duration_ms, total_users, tokens_spent, error_message, snapshot)
         VALUES ($1, $2, $3, $4, 0, $5, $6)
         RETURNING created_at`,
        [triggeredBy, trigger, durationMs, totalUsers, error, overview ? JSON.stringify(overview) : null],
      );
      createdAt = new Date(ins.rows[0]?.created_at ?? createdAt).toISOString();
    } catch (e: any) {
      this.log.error(`persona_runs insert failed: ${e.message}`);
    }

    const lastRun: PersonaRunMeta = {
      createdAt, triggeredBy, trigger, durationMs, totalUsers, tokensSpent: 0, error,
    };
    if (!overview) {
      // Пересчёт упал — отдаём пустой каркас + мету с ошибкой, чтобы UI показал её.
      return { generatedAt: createdAt, excludedUsers: excluded, totalUsers: 0, buckets: [], lastRun };
    }
    return { ...overview, lastRun };
  }

  // Отдаёт последний сохранённый снапшот + мету последнего запуска (мгновенно,
  // без пересчёта). Если снапшотов ещё нет — считает первый раз (trigger=auto).
  async getLatest(): Promise<PersonasOverview> {
    let row: any = null;
    try {
      const r = await this.pg.query(
        `SELECT triggered_by, trigger, duration_ms, total_users, tokens_spent, error_message, snapshot, created_at
           FROM persona_runs
          WHERE snapshot IS NOT NULL AND error_message IS NULL
          ORDER BY created_at DESC LIMIT 1`,
      );
      row = r.rows[0] ?? null;
    } catch (e: any) {
      this.log.error(`persona_runs read failed: ${e.message}`);
    }
    if (!row) return this.recompute(null, 'auto');

    const snap: PersonasOverview = typeof row.snapshot === 'string' ? JSON.parse(row.snapshot) : row.snapshot;
    const lastRun: PersonaRunMeta = {
      createdAt: new Date(row.created_at).toISOString(),
      triggeredBy: row.triggered_by ?? null,
      trigger: row.trigger,
      durationMs: row.duration_ms ?? null,
      totalUsers: row.total_users ?? snap.totalUsers ?? 0,
      tokensSpent: row.tokens_spent ?? 0,
      error: row.error_message ?? null,
    };
    return { ...snap, lastRun };
  }

  // Разбивка сессий (диалогов user×assistant из custom_chat_history) по персонам
  // + avg sessions/user. Переиспользует ту же rule-based классификацию (msg/gen/
  // pay/classified), что и персоны, и джойнит к сессиям. Для snapshot VPM (b6ec07e2).
  async sessionsByPersona(): Promise<{
    avgSessionsPerUser: number | null;
    totalSessions: number;
    byPersona: Array<{ persona: PersonaKey; users: number; sessions: number; avgSessionsPerUser: number | null; avgMsgsPerSession: number | null }>;
  }> {
    const sql = `
      WITH
      msg AS (
        SELECT e.user_id, COUNT(*) AS total_msgs,
               SUM(CASE WHEN a.category='business' THEN 1 ELSE 0 END)::numeric AS biz_msgs,
               SUM(CASE WHEN a.category='personal' THEN 1 ELSE 0 END)::numeric AS per_msgs,
               SUM(CASE WHEN a.category='smm'      THEN 1 ELSE 0 END)::numeric AS smm_msgs
          FROM events e LEFT JOIN agents a ON a.id::text = (e.props->>'assistant_id')
         WHERE e.name='message_sent' AND e.user_id IS NOT NULL
           AND e.user_id <> ALL($1::text[])
           AND e.user_id NOT IN (SELECT user_id FROM ai_profiles_consolidated WHERE isadmin = true)
         GROUP BY e.user_id
      ),
      gen AS (
        SELECT user_id, SUM(c) AS gen_count FROM (
          SELECT user_id, COUNT(*) AS c FROM generated_images GROUP BY 1
          UNION ALL SELECT user_id, COUNT(*) AS c FROM video_jobs GROUP BY 1
        ) x GROUP BY 1
      ),
      classified AS (
        SELECT m.user_id,
          CASE
            WHEN COALESCE(g.gen_count,0) >= 5      THEN 'content_creator'
            WHEN m.smm_msgs / m.total_msgs >= 0.40 THEN 'smm'
            WHEN m.biz_msgs / m.total_msgs >= 0.40 THEN 'business'
            WHEN m.per_msgs / m.total_msgs >= 0.40 THEN 'personal_growth'
            WHEN m.total_msgs < 5                  THEN 'curious'
            ELSE 'mixed'
          END AS persona
        FROM msg m LEFT JOIN gen g ON g.user_id = m.user_id
      ),
      sessions AS (
        SELECT split_part(session_id,'_',1) AS uid, session_id, COUNT(*) AS msgs
          FROM custom_chat_history
         WHERE sender_type='human'
         GROUP BY session_id
      )
      SELECT c.persona,
             COUNT(DISTINCT c.user_id)::int AS users,
             COUNT(s.session_id)::int AS sessions,
             round(COUNT(s.session_id)::numeric / NULLIF(COUNT(DISTINCT c.user_id),0), 2) AS avg_sessions_per_user,
             round(AVG(s.msgs)::numeric, 1) AS avg_msgs_per_session
        FROM classified c
        LEFT JOIN sessions s ON s.uid = c.user_id
       GROUP BY c.persona
       ORDER BY sessions DESC NULLS LAST`;
    try {
      const r = await this.pg.query(sql, [excluded]);
      const byPersona = r.rows.map((x: any) => ({
        persona: x.persona as PersonaKey,
        users: Number(x.users) || 0,
        sessions: Number(x.sessions) || 0,
        avgSessionsPerUser: x.avg_sessions_per_user != null ? Number(x.avg_sessions_per_user) : null,
        avgMsgsPerSession: x.avg_msgs_per_session != null ? Number(x.avg_msgs_per_session) : null,
      }));
      const totalSessions = byPersona.reduce((s, p) => s + p.sessions, 0);
      const totalUsers = byPersona.reduce((s, p) => s + p.users, 0);
      return {
        avgSessionsPerUser: totalUsers > 0 ? Math.round((totalSessions / totalUsers) * 100) / 100 : null,
        totalSessions,
        byPersona,
      };
    } catch (e: any) {
      this.log.error(`sessionsByPersona failed: ${e.message}`);
      return { avgSessionsPerUser: null, totalSessions: 0, byPersona: [] };
    }
  }

  // Открытия приложения vs чат-сессии по персонам за 7d (задача 7311bfb9).
  // app_opens_7d — события app_open (открытие авторизованным юзером, ставится
  // фронтом раз на сессию браузера). chat_sessions_7d — диалоги с ≥1 сообщением
  // за 7d. Ratio chat/open диагностирует барьер Mixed: низкий ratio → discovery
  // (открывают, но не пишут); ~0 открытий → re-engagement (не возвращаются).
  async opensVsChatsByPersona(): Promise<Array<{
    persona: PersonaKey; appOpens7d: number; chatSessions7d: number; chatToOpenRatio: number | null;
  }>> {
    const sql = `
      WITH
      msg AS (
        SELECT e.user_id, COUNT(*) AS total_msgs,
               SUM(CASE WHEN a.category='business' THEN 1 ELSE 0 END)::numeric AS biz_msgs,
               SUM(CASE WHEN a.category='personal' THEN 1 ELSE 0 END)::numeric AS per_msgs,
               SUM(CASE WHEN a.category='smm'      THEN 1 ELSE 0 END)::numeric AS smm_msgs
          FROM events e LEFT JOIN agents a ON a.id::text = (e.props->>'assistant_id')
         WHERE e.name='message_sent' AND e.user_id IS NOT NULL
           AND e.user_id <> ALL($1::text[])
           AND e.user_id NOT IN (SELECT user_id FROM ai_profiles_consolidated WHERE isadmin = true)
         GROUP BY e.user_id
      ),
      gen AS (
        SELECT user_id, SUM(c) AS gen_count FROM (
          SELECT user_id, COUNT(*) AS c FROM generated_images GROUP BY 1
          UNION ALL SELECT user_id, COUNT(*) AS c FROM video_jobs GROUP BY 1
        ) x GROUP BY 1
      ),
      classified AS (
        SELECT m.user_id,
          CASE
            WHEN COALESCE(g.gen_count,0) >= 5      THEN 'content_creator'
            WHEN m.smm_msgs / m.total_msgs >= 0.40 THEN 'smm'
            WHEN m.biz_msgs / m.total_msgs >= 0.40 THEN 'business'
            WHEN m.per_msgs / m.total_msgs >= 0.40 THEN 'personal_growth'
            WHEN m.total_msgs < 5                  THEN 'curious'
            ELSE 'mixed'
          END AS persona
        FROM msg m LEFT JOIN gen g ON g.user_id = m.user_id
      ),
      opens AS (
        SELECT user_id, COUNT(*) AS n FROM events
         WHERE name='app_open' AND user_id IS NOT NULL AND ts > now()-interval '7 days'
         GROUP BY user_id
      ),
      chats AS (
        SELECT split_part(session_id,'_',1) AS uid, COUNT(DISTINCT session_id) AS n
          FROM custom_chat_history
         WHERE sender_type='human' AND created_at > now()-interval '7 days'
         GROUP BY 1
      )
      SELECT c.persona,
             COALESCE(SUM(o.n),0)::int  AS app_opens_7d,
             COALESCE(SUM(ch.n),0)::int AS chat_sessions_7d
        FROM classified c
        LEFT JOIN opens o  ON o.user_id = c.user_id
        LEFT JOIN chats ch ON ch.uid    = c.user_id
       GROUP BY c.persona`;
    try {
      const r = await this.pg.query(sql, [excluded]);
      return r.rows.map((x: any) => {
        const opens = Number(x.app_opens_7d) || 0;
        const chats = Number(x.chat_sessions_7d) || 0;
        return {
          persona: x.persona as PersonaKey,
          appOpens7d: opens,
          chatSessions7d: chats,
          chatToOpenRatio: opens > 0 ? Math.round((chats / opens) * 100) / 100 : null,
        };
      });
    } catch (e: any) {
      this.log.error(`opensVsChatsByPersona failed: ${e.message}`);
      return [];
    }
  }
}
