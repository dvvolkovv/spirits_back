import { Injectable, Logger, OnModuleInit, BadRequestException, NotFoundException } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { ClaudeCliService } from '../common/services/claude-cli.service';
import { BacklogService, BacklogItem } from '../backlog/backlog.service';
import { PersonasService } from '../monitoring/product/personas.service';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Virtual Marketing Manager («виртуальный маркетолог»).
 *
 * Симметричен Виртуальному PM (vpm.service), но смотрит на маркетинг:
 * привлечение по каналам/источникам, активация, удержание, монетизация,
 * персоны как сегменты для таргета и креативов. Выдаёт 3–7 конкретных
 * маркетинговых задач, которые владелец может одобрить (→ задача в ТОМ ЖЕ
 * бэклоге продукта) или отклонить — тот же workflow, что и у VPM.
 *
 * Почему отдельный модуль, а не флаг у VPM: разные снапшоты, разные промпты и
 * раздельная история рекомендаций/прогонов (vmm_* таблицы) — чтобы продуктовые
 * и маркетинговые советы не путались и не «забивали» друг друга.
 */

export type RecPriority = 'critical' | 'high' | 'medium' | 'low';
export type RecStatus   = 'pending' | 'in_backlog' | 'dismissed' | 'done';

export interface VmmRecommendation {
  id: string;
  run_id: string;
  priority: RecPriority;
  title: string;
  rationale_md: string;
  proposed_action_md: string;
  related_metrics: string[];
  status: RecStatus;
  backlog_item_id: string | null;
  status_changed_at: string | null;
  status_changed_by: string | null;
  created_at: string;
}

export interface VmmRun {
  id: string;
  triggered_by: string | null;
  trigger: 'manual' | 'cron';
  snapshot: any;
  cost_usd: number | null;
  duration_ms: number | null;
  error_message: string | null;
  created_at: string;
}

const PRIORITIES: RecPriority[] = ['critical', 'high', 'medium', 'low'];

// Тестовые/синтетические аккаунты — исключаем из маркетинговых метрик, иначе
// smoke-аккаунт один спамит сотни сообщений и искажает воронку/каналы.
const TEST_USERS = ['70000000000', '79030169187', '79169403771', '79656445804'];
const TEST_PATTERN = '^790300[0-9]{5}$';

@Injectable()
export class VmmService implements OnModuleInit {
  private readonly log = new Logger(VmmService.name);

  constructor(
    private readonly pg: PgService,
    private readonly claude: ClaudeCliService,
    private readonly backlog: BacklogService,
    private readonly personas: PersonasService,
  ) {}

  async onModuleInit() {
    const file = '001_vmm.sql';
    const candidates = [
      path.join(__dirname, 'migrations', file),
      path.join(__dirname, '..', '..', 'src', 'vmm', 'migrations', file),
    ];
    for (const p of candidates) {
      try {
        if (fs.existsSync(p)) {
          await this.pg.query(fs.readFileSync(p, 'utf8'));
          this.log.log(`vmm migration ${file} applied from ${p}`);
          return;
        }
      } catch (e: any) {
        this.log.error(`vmm migration ${file} failed (${p}): ${e.message}`);
      }
    }
  }

  // ---------------- marketing snapshot ----------------

  private async buildSnapshot() {
    const snapshot: Record<string, any> = {};

    // 1. Acquisition funnel (real users; test traffic excluded). Регистрации,
    // активация (дошёл до первого чата), возвраты, медианное время до 1-го чата.
    try {
      const reg = await this.pg.query(
        `SELECT
           COUNT(*) FILTER (WHERE created_at > now()-interval '7 days')  AS registrations_7d,
           COUNT(*) FILTER (WHERE created_at > now()-interval '30 days') AS registrations_30d,
           COUNT(*)                                                       AS users_total
         FROM ai_profiles_consolidated
         WHERE user_id <> ALL($1) AND user_id !~ $2
           AND user_id NOT IN (SELECT user_id FROM ai_profiles_consolidated WHERE isadmin = true)`,
        [TEST_USERS, TEST_PATTERN],
      );
      const act = await this.pg.query(
        `WITH chat AS (
           SELECT split_part(session_id,'_',1) AS uid, created_at
             FROM custom_chat_history
            WHERE sender_type='human'
              AND split_part(session_id,'_',1) <> ALL($1)
              AND split_part(session_id,'_',1) !~ $2
         ),
         firsts AS (SELECT uid, min(created_at) AS first_at FROM chat GROUP BY uid)
         SELECT
           (SELECT COUNT(*) FROM firsts WHERE first_at > now()-interval '7 days')   AS first_chat_users_7d,
           (SELECT COUNT(DISTINCT uid) FROM chat WHERE created_at > now()-interval '7 days') AS active_users_7d,
           (SELECT COUNT(*) FROM (
              SELECT uid FROM chat WHERE created_at > now()-interval '7 days'
              GROUP BY uid HAVING COUNT(DISTINCT date_trunc('day',created_at)) >= 2
           ) r)                                                                       AS returning_users_7d`,
        [TEST_USERS, TEST_PATTERN],
      );
      const f: any = { ...reg.rows[0], ...act.rows[0] };
      const reg7 = Number(f.registrations_7d) || 0;
      const fcu = Number(f.first_chat_users_7d) || 0;
      f.activation_rate_7d_pct = reg7 > 0 ? Math.round((100 * fcu) / reg7 * 10) / 10 : null;
      snapshot.acquisition = f;
    } catch { /* silent */ }

    // 2. Источники привлечения (UTM/referrer). Захват — на анонимном landing-event
    // (events.source), линкуем к регистранту по session_id. Историч. регистрации
    // без source → 'unknown'. Это и есть основа атрибуции под рекламу.
    try {
      const bySource = await this.pg.query(
        `WITH regs AS (
           SELECT user_id FROM ai_profiles_consolidated
            WHERE created_at > now()-interval '90 days'
              AND user_id <> ALL($1) AND user_id !~ $2
         ),
         sess AS (
           SELECT DISTINCT e.session_id, e.user_id
             FROM events e JOIN regs r ON r.user_id = e.user_id
            WHERE e.session_id IS NOT NULL
         ),
         src AS (
           SELECT DISTINCT ON (e.session_id) e.session_id, e.source
             FROM events e
            WHERE e.source IS NOT NULL AND e.source <> ''
            ORDER BY e.session_id, e.ts ASC
         )
         SELECT COALESCE(src.source,'unknown') AS source, count(DISTINCT regs.user_id)::int AS registrations_90d
           FROM regs
           LEFT JOIN sess ON sess.user_id = regs.user_id
           LEFT JOIN src  ON src.session_id = sess.session_id
          GROUP BY 1 ORDER BY 2 DESC`,
        [TEST_USERS, TEST_PATTERN],
      );
      snapshot.registrations_by_source_90d = Object.fromEntries(
        bySource.rows.map((r: any) => [r.source, r.registrations_90d]),
      );
      // Верх воронки: лендинги по источникам (трафик, ещё до регистрации).
      const landings = await this.pg.query(
        `SELECT COALESCE(NULLIF(source,''),'unknown') AS source, COUNT(*)::int AS landing_views_30d
           FROM events
          WHERE name='landing_view' AND ts > now()-interval '30 days'
          GROUP BY 1 ORDER BY 2 DESC LIMIT 12`,
      );
      snapshot.landing_views_by_source_30d = Object.fromEntries(
        landings.rows.map((r: any) => [r.source, r.landing_views_30d]),
      );
    } catch { /* silent */ }

    // 3. Реферальный канал (единственный «органический рост» сейчас).
    try {
      const ref = await this.pg.query(
        `SELECT
           (SELECT COUNT(*) FROM referral_referees WHERE registered_at > now()-interval '30 days') AS referral_registrations_30d,
           (SELECT COUNT(*) FROM referral_referees)                                                AS referral_referees_total,
           (SELECT COUNT(*) FROM referral_leaders WHERE is_active)                                  AS referral_active_leaders`,
      );
      snapshot.referral = ref.rows[0];
    } catch { /* silent */ }

    // 4. Монетизация: платящие, выручка, конверсия в оплату, ARPPU.
    try {
      const rev = await this.pg.query(
        `WITH paid AS (
           SELECT user_id, SUM(amount)::numeric AS revenue, MIN(created_at) AS first_pay
             FROM payments WHERE status='succeeded'
              AND user_id <> ALL($1) AND user_id !~ $2
            GROUP BY user_id
         )
         SELECT
           (SELECT COUNT(*) FROM paid)                                              AS payers_total,
           (SELECT COALESCE(SUM(revenue),0) FROM paid)                              AS revenue_total_rub,
           (SELECT COALESCE(SUM(amount),0) FROM payments WHERE status='succeeded'
              AND created_at > now()-interval '30 days'
              AND user_id <> ALL($1) AND user_id !~ $2)                             AS revenue_30d_rub,
           (SELECT COUNT(*) FROM paid WHERE first_pay > now()-interval '30 days')   AS new_payers_30d,
           (SELECT round(AVG(revenue)::numeric,0) FROM paid)                        AS arppu_rub`,
        [TEST_USERS, TEST_PATTERN],
      );
      const m: any = rev.rows[0];
      const usersTotal = Number(snapshot.acquisition?.users_total) || 0;
      m.paid_conversion_pct = usersTotal > 0 ? Math.round((100 * Number(m.payers_total)) / usersTotal * 10) / 10 : null;
      snapshot.monetization = m;
    } catch { /* silent */ }

    // 5. Когорты по неделе регистрации (последние 10): размер, активация (дошли
    // до 1-го чата), удержание (были активны за последние 14 дней). Кросс с
    // персонами/источником — следующий шаг, но и это уже показывает динамику.
    try {
      const cohorts = await this.pg.query(
        `WITH u AS (
           SELECT user_id, date_trunc('week', created_at) AS wk, created_at
             FROM ai_profiles_consolidated
            WHERE created_at > now()-interval '11 weeks'
              AND user_id <> ALL($1) AND user_id !~ $2
              AND user_id NOT IN (SELECT user_id FROM ai_profiles_consolidated WHERE isadmin = true)
         ),
         chat AS (
           SELECT split_part(session_id,'_',1) AS uid,
                  min(created_at) AS first_chat,
                  max(created_at) AS last_chat
             FROM custom_chat_history WHERE sender_type='human' GROUP BY 1
         )
         SELECT to_char(u.wk,'YYYY-MM-DD') AS week,
                COUNT(*)::int AS signups,
                COUNT(*) FILTER (WHERE c.first_chat IS NOT NULL)::int AS activated,
                COUNT(*) FILTER (WHERE c.last_chat > now()-interval '14 days')::int AS retained_14d
           FROM u LEFT JOIN chat c ON c.uid = u.user_id
          GROUP BY u.wk ORDER BY u.wk DESC LIMIT 10`,
        [TEST_USERS, TEST_PATTERN],
      );
      snapshot.signup_cohorts = cohorts.rows;
    } catch { /* silent */ }

    // 6. Персоны — сегменты для таргета/креативов (кто платит, у кого retention,
    // к каким ассистентам идут). Уже исключают тест/админов.
    try {
      const p = await this.personas.getLatest();
      snapshot.personas = {
        total_users: p.totalUsers,
        buckets: p.buckets.map((b) => ({
          persona: b.key,
          label: b.label,
          users: b.users,
          share_pct: b.sharePct,
          avg_payment_rub: b.avgPaymentRub,
          retention_14d_pct: b.retention14dPct,
          top_assistant: b.topAssistants?.[0]?.displayName ?? b.topAssistants?.[0]?.name ?? null,
        })),
      };
    } catch { /* silent */ }

    // 7. Чтобы не предлагать дубли — недавний бэклог и прошлые рекомендации маркетолога.
    try {
      const recentProposed = await this.pg.query(
        `SELECT title FROM backlog_items WHERE status IN ('proposed','approved')
          ORDER BY updated_at DESC LIMIT 15`,
      );
      snapshot.backlog_recent = recentProposed.rows.map((r: any) => r.title);
      const prev = await this.pg.query(
        `SELECT title, priority, status FROM vmm_recommendations
          WHERE created_at > now()-interval '60 days' ORDER BY created_at DESC LIMIT 20`,
      );
      snapshot.prior_recommendations = prev.rows;
    } catch { /* silent */ }

    snapshot.context_note =
      'Стадия: РАННЯЯ, трафика мало (единицы–десятки активных юзеров). Любые когорты/персоны — НАПРАВЛЕНИЕ, не статзначимый вывод; не переусложняй аналитику на таком N. ' +
      'Атрибуция источников уже работает: фронт ловит utm_source/utm_medium/utm_campaign + referrer на лендинге (events.source), линкуется к регистрации по session_id. Историч. регистрации без source = "unknown" — это норма, заполнится с трафиком. ' +
      'Все метрики (acquisition/monetization/cohorts/personas) исключают тестовые номера и админ-аккаунты (включая владельца). ' +
      'Владелец — технический, планирует ЗАПУСК ПЛАТНОЙ РЕКЛАМЫ. Цени измеримость (UTM-разметка кампаний, что мерить ДО/ПОСЛЕ запуска) и конкретику каналов/креативов под персоны.';

    snapshot.generated_at = new Date().toISOString();
    return snapshot;
  }

  // ---------------- run a generation ----------------

  async generate(triggeredBy: string | null, trigger: 'manual' | 'cron' = 'manual'): Promise<{ run: VmmRun; recommendations: VmmRecommendation[] }> {
    const snapshot = await this.buildSnapshot();

    const prompt = [
      'Ты — виртуальный маркетолог платформы my.linkeon.io.',
      'Платформа: B2C-сервис общения с AI-ассистентами (психолог, коуч, юрист, SMM и др.), система токенов, генерация изображений/видео, поиск единомышленников.',
      '',
      'Контекст: трафика пока мало, владелец (технический человек) планирует запускать платную рекламу. Нужны понятные, выполнимые маркетинговые задачи.',
      '',
      'Твоя задача: посмотреть на снимок маркетинга (ниже) и предложить **3–7 конкретных задач** по маркетингу на ближайшие 1–2 недели. Это могут быть: выбор/тест каналов привлечения, UTM-разметка и измеримость до запуска рекламы, креативы/мессседжи под конкретные персоны, лендинг/оффер, активация и удержание новых юзеров, монетизация, конкретные эксперименты.',
      '',
      'Правила:',
      '- Опирайся на конкретные цифры из snapshot (acquisition, registrations_by_source, monetization, signup_cohorts, personas). В rationale_md явно укажи, на что смотришь.',
      '- Сегментируй: предлагай под конкретные `personas` (кто платит, у кого retention, к каким ассистентам идут) — какой канал и какое сообщение под какую персону, а не «в среднем».',
      '- Помни про раннюю стадию (см. context_note): не строй выводов из шума на крошечном N; если данных мало — предложи дешёвый эксперимент/замер, а не дорогую кампанию вслепую.',
      '- Для рекламы цени ИЗМЕРИМОСТЬ: размечать кампании UTM, что именно мерить (CAC, конверсия в активацию/оплату по каналу), какие события не хватает трекать — заведи это задачей, если нужно.',
      '- Не предлагай дубли того, что уже в бэклоге (backlog_recent) или повторов prior_recommendations.',
      '- Priority: critical = горит/блокирует запуск рекламы. high = сильно влияет на привлечение/деньги. medium = улучшение. low = nice-to-have.',
      '',
      'Верни СТРОГО валидный JSON-массив без обёрток и без ```. Каждый элемент:',
      '{',
      '  "priority": "critical" | "high" | "medium" | "low",',
      '  "title": "<5–10 слов на русском, конкретная маркетинговая задача>",',
      '  "rationale_md": "<markdown, 1–2 абзаца: почему сейчас, на какие цифры опирается>",',
      '  "proposed_action_md": "<markdown, 1–2 абзаца: что конкретно сделать, как измерить результат>",',
      '  "related_metrics": ["<метрика/сигнал из snapshot>", "..."]',
      '}',
      '',
      'Snapshot:',
      JSON.stringify(snapshot, null, 2),
    ].join('\n');

    const t0 = Date.now();
    let text = '';
    let costUsd = 0;
    let errorMessage: string | null = null;
    try {
      const r = await this.claude.textWithCost(prompt, {
        model: 'claude-sonnet-4-6',
        timeoutMs: 360_000,
      });
      text = r.text;
      costUsd = r.costUsd;
    } catch (e: any) {
      errorMessage = e?.message || 'claude call failed';
      this.log.error(`vmm generation: claude error — ${errorMessage}`);
    }
    const durationMs = Date.now() - t0;

    let parsed: any[] = [];
    if (text && !errorMessage) {
      const cleaned = text.trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```\s*$/i, '');
      try {
        parsed = JSON.parse(cleaned);
        if (!Array.isArray(parsed)) parsed = [];
      } catch (e: any) {
        errorMessage = `JSON parse failed: ${e.message}; raw head: ${cleaned.slice(0, 200)}`;
        this.log.warn(`vmm generation: ${errorMessage}`);
      }
    }

    const runRes = await this.pg.query(
      `INSERT INTO vmm_runs (triggered_by, trigger, snapshot, cost_usd, duration_ms, error_message)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [triggeredBy, trigger, JSON.stringify(snapshot), costUsd, durationMs, errorMessage],
    );
    const run = runRes.rows[0] as VmmRun;

    const recs: VmmRecommendation[] = [];
    for (const r of parsed) {
      const priority = PRIORITIES.includes(r?.priority) ? r.priority : 'medium';
      const title = String(r?.title || '').trim();
      if (!title) continue;
      const rationale = String(r?.rationale_md || '').trim();
      const action = String(r?.proposed_action_md || '').trim();
      const metrics = Array.isArray(r?.related_metrics)
        ? r.related_metrics.map((m: any) => String(m)).filter(Boolean).slice(0, 12)
        : [];
      const ins = await this.pg.query(
        `INSERT INTO vmm_recommendations
           (run_id, priority, title, rationale_md, proposed_action_md, related_metrics)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         RETURNING *`,
        [run.id, priority, title, rationale, action, JSON.stringify(metrics)],
      );
      recs.push(this.rowToRec(ins.rows[0]));
    }

    return { run, recommendations: recs };
  }

  // ---------------- listing & per-rec actions ----------------

  async listRecommendations(opts: { status?: RecStatus; limit?: number } = {}): Promise<VmmRecommendation[]> {
    const lim = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const params: any[] = [];
    let where = '';
    if (opts.status) {
      params.push(opts.status);
      where = `WHERE status = $${params.length}`;
    }
    params.push(lim);
    const r = await this.pg.query(
      `SELECT * FROM vmm_recommendations ${where} ORDER BY
         CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END,
         created_at DESC
       LIMIT $${params.length}`,
      params,
    );
    return r.rows.map((row: any) => this.rowToRec(row));
  }

  async listRuns(limit = 20): Promise<any[]> {
    const lim = Math.min(Math.max(limit, 1), 100);
    const r = await this.pg.query(
      `SELECT id, triggered_by, trigger, cost_usd, duration_ms, error_message, created_at,
              (SELECT COUNT(*)::int FROM vmm_recommendations WHERE run_id = vmm_runs.id) AS rec_count
         FROM vmm_runs ORDER BY created_at DESC LIMIT $1`,
      [lim],
    );
    return r.rows as any[];
  }

  async dismiss(id: string, by: string): Promise<VmmRecommendation> {
    return this.setStatus(id, 'dismissed', by);
  }

  async markDone(id: string, by: string): Promise<VmmRecommendation> {
    return this.setStatus(id, 'done', by);
  }

  private async setStatus(id: string, status: RecStatus, by: string): Promise<VmmRecommendation> {
    const r = await this.pg.query(
      `UPDATE vmm_recommendations
          SET status = $1, status_changed_at = now(), status_changed_by = $2
        WHERE id = $3
        RETURNING *`,
      [status, by, id],
    );
    if (!r.rows[0]) throw new NotFoundException('recommendation not found');
    return this.rowToRec(r.rows[0]);
  }

  // Одобрение: рекомендация → задача в ТОМ ЖЕ бэклоге продукта (тот же workflow,
  // что у VPM), помечена как маркетинговая.
  async toBacklog(id: string, by: string): Promise<{ recommendation: VmmRecommendation; backlogItem: BacklogItem }> {
    const recRow = await this.pg.query(`SELECT * FROM vmm_recommendations WHERE id = $1`, [id]);
    if (!recRow.rows[0]) throw new NotFoundException('recommendation not found');
    const rec = this.rowToRec(recRow.rows[0]);
    if (rec.backlog_item_id) {
      throw new BadRequestException('already converted to backlog item');
    }
    const item = await this.backlog.create(by, {
      title: `[Маркетинг] ${rec.title}`,
      analysis_md: [
        '## Источник',
        '',
        `Эта задача предложена Виртуальным маркетологом (рекомендация ${rec.id}, приоритет: **${rec.priority}**).`,
        '',
        '## Обоснование',
        '',
        rec.rationale_md || '_не указано_',
        '',
        '## Предложенное действие',
        '',
        rec.proposed_action_md || '_не указано_',
        '',
        rec.related_metrics.length > 0
          ? '## Связанные метрики\n\n' + rec.related_metrics.map((m) => `- ${m}`).join('\n')
          : '',
      ].filter(Boolean).join('\n'),
      status: 'proposed',
    });
    const updated = await this.pg.query(
      `UPDATE vmm_recommendations
          SET status = 'in_backlog', backlog_item_id = $1, status_changed_at = now(), status_changed_by = $2
        WHERE id = $3
        RETURNING *`,
      [item.id, by, id],
    );
    return { recommendation: this.rowToRec(updated.rows[0]), backlogItem: item };
  }

  private rowToRec(row: any): VmmRecommendation {
    return {
      id: row.id,
      run_id: row.run_id,
      priority: row.priority,
      title: row.title,
      rationale_md: row.rationale_md,
      proposed_action_md: row.proposed_action_md,
      related_metrics: Array.isArray(row.related_metrics) ? row.related_metrics : [],
      status: row.status,
      backlog_item_id: row.backlog_item_id,
      status_changed_at: row.status_changed_at,
      status_changed_by: row.status_changed_by,
      created_at: row.created_at,
    };
  }
}
