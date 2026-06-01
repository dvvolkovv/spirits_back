import { Injectable, Logger, OnModuleInit, BadRequestException, NotFoundException } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { ClaudeCliService } from '../common/services/claude-cli.service';
import { BacklogService, BacklogItem } from '../backlog/backlog.service';
import * as fs from 'fs';
import * as path from 'path';

export type RecPriority = 'critical' | 'high' | 'medium' | 'low';
export type RecStatus   = 'pending' | 'in_backlog' | 'dismissed' | 'done';

export interface VpmRecommendation {
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

export interface VpmRun {
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

@Injectable()
export class VpmService implements OnModuleInit {
  private readonly log = new Logger(VpmService.name);

  constructor(
    private readonly pg: PgService,
    private readonly claude: ClaudeCliService,
    private readonly backlog: BacklogService,
  ) {}

  async onModuleInit() {
    const file = '001_vpm.sql';
    const candidates = [
      path.join(__dirname, 'migrations', file),
      path.join(__dirname, '..', '..', 'src', 'vpm', 'migrations', file),
    ];
    for (const p of candidates) {
      try {
        if (fs.existsSync(p)) {
          await this.pg.query(fs.readFileSync(p, 'utf8'));
          this.log.log(`vpm migration ${file} applied from ${p}`);
          return;
        }
      } catch (e: any) {
        this.log.error(`vpm migration ${file} failed (${p}): ${e.message}`);
      }
    }
  }

  // ---------------- snapshot assembly ----------------

  // Aggregates everything the VPM needs to look at in one place. Lives on
  // the backend so the prompt is stable across UI reloads and so we have
  // an audit trail of "what the model saw" alongside each run.
  private async buildSnapshot() {
    const snapshot: Record<string, any> = {};

    // 1. Top-level product indicators (growth + funnel + risk)
    try {
      const idR = await this.pg.query(
        `SELECT id, user_id, status, urgency, topic, escalation_reason, created_at
           FROM support_tickets
          WHERE status IN ('escalated','owner_handling','ai_handling')
          ORDER BY updated_at DESC
          LIMIT 10`,
      );
      snapshot.active_tickets_count = idR.rows.length;
      snapshot.recent_active_tickets = idR.rows.map((r: any) => ({
        topic: r.topic ?? '',
        status: r.status,
        urgency: r.urgency,
        age_h: Math.round((Date.now() - new Date(r.created_at).getTime()) / 3600_000),
      }));
    } catch { snapshot.active_tickets_count = null; }

    // 2. Backlog summary (counts + recent proposed)
    try {
      const counts = await this.pg.query(
        `SELECT status, COUNT(*)::int AS n FROM backlog_items GROUP BY status`,
      );
      snapshot.backlog_counts = Object.fromEntries(counts.rows.map((r: any) => [r.status, r.n]));
      const recentProposed = await this.pg.query(
        `SELECT title, complexity, effort FROM backlog_items
          WHERE status IN ('proposed','approved') ORDER BY updated_at DESC LIMIT 10`,
      );
      snapshot.backlog_recent_proposed = recentProposed.rows;
      const recentDone = await this.pg.query(
        `SELECT title FROM backlog_items
          WHERE status='done' AND updated_at > now() - interval '14 days'
          ORDER BY updated_at DESC LIMIT 10`,
      );
      snapshot.backlog_recent_done = recentDone.rows.map((r: any) => r.title);
    } catch { /* silent */ }

    // 3. Recent VPM history — so the model doesn't repeat itself
    try {
      const prev = await this.pg.query(
        `SELECT title, priority, status FROM vpm_recommendations
          WHERE created_at > now() - interval '30 days'
          ORDER BY created_at DESC LIMIT 20`,
      );
      snapshot.prior_recommendations = prev.rows;
    } catch { /* silent */ }

    // 4. Approximate product health from events (cheap proxies)
    try {
      const usage = await this.pg.query(
        `SELECT
           COUNT(*) FILTER (WHERE ts > now() - interval '7 days')::int AS chat_calls_7d,
           COUNT(DISTINCT user_id) FILTER (WHERE ts > now() - interval '7 days')::int AS active_users_7d,
           COUNT(*) FILTER (WHERE ts > now() - interval '30 days')::int AS chat_calls_30d
         FROM events
         WHERE name IN ('chat_message_sent','soulmate_chat_sent')`,
      );
      snapshot.usage = usage.rows[0];
    } catch { /* silent */ }

    snapshot.generated_at = new Date().toISOString();
    return snapshot;
  }

  // ---------------- run a generation ----------------

  async generate(triggeredBy: string | null, trigger: 'manual' | 'cron' = 'manual'): Promise<{ run: VpmRun; recommendations: VpmRecommendation[] }> {
    const snapshot = await this.buildSnapshot();

    const prompt = [
      'Ты — виртуальный продакт-менеджер платформы my.linkeon.io.',
      'Платформа: B2C-сервис общения с AI-ассистентами (психолог, коуч, юрист и др.), система токенов, поиск партнёров, генерация видео.',
      '',
      'Твоя задача: посмотреть на снимок состояния продукта (ниже) и предложить **3–7 конкретных рекомендаций**, что стоит сделать в продукте в ближайшие 1–2 недели.',
      '',
      'Правила:',
      '- Не предлагай задачи, которые уже в бэклоге (см. backlog_recent_proposed) или уже сделаны недавно (backlog_recent_done).',
      '- Опирайся на конкретные метрики и тикеты в snapshot. В rationale_md явно укажи на что смотришь.',
      '- Если данных не хватает — это тоже рекомендация (например, "Добавить метрику X").',
      '- Не повторяй prior_recommendations с тем же смыслом.',
      '- Priority: critical = блокирует бизнес сейчас. high = реальная боль для пользователей. medium = улучшение. low = nice-to-have / cleanup.',
      '',
      'Верни СТРОГО валидный JSON-массив без обёрток и без ```. Каждый элемент:',
      '{',
      '  "priority": "critical" | "high" | "medium" | "low",',
      '  "title": "<5–10 слов на русском, конкретная фича/действие>",',
      '  "rationale_md": "<markdown, 1–2 абзаца: почему сейчас, на какие метрики опирается>",',
      '  "proposed_action_md": "<markdown, 1–2 абзаца: что конкретно сделать>",',
      '  "related_metrics": ["<label метрики или сигнала из snapshot>", "..."]',
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
        timeoutMs: 120_000,
      });
      text = r.text;
      costUsd = r.costUsd;
    } catch (e: any) {
      errorMessage = e?.message || 'claude call failed';
      this.log.error(`vpm generation: claude error — ${errorMessage}`);
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
        this.log.warn(`vpm generation: ${errorMessage}`);
      }
    }

    // Insert the run + the recommendations in one go.
    const runRes = await this.pg.query(
      `INSERT INTO vpm_runs (triggered_by, trigger, snapshot, cost_usd, duration_ms, error_message)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [triggeredBy, trigger, JSON.stringify(snapshot), costUsd, durationMs, errorMessage],
    );
    const run = runRes.rows[0] as VpmRun;

    const recs: VpmRecommendation[] = [];
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
        `INSERT INTO vpm_recommendations
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

  async listRecommendations(opts: { status?: RecStatus; limit?: number } = {}): Promise<VpmRecommendation[]> {
    const lim = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const params: any[] = [];
    let where = '';
    if (opts.status) {
      params.push(opts.status);
      where = `WHERE status = $${params.length}`;
    }
    params.push(lim);
    const r = await this.pg.query(
      `SELECT * FROM vpm_recommendations ${where} ORDER BY
         CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END,
         created_at DESC
       LIMIT $${params.length}`,
      params,
    );
    return r.rows.map((row: any) => this.rowToRec(row));
  }

  async listRuns(limit = 20): Promise<VpmRun[]> {
    const lim = Math.min(Math.max(limit, 1), 100);
    const r = await this.pg.query(
      `SELECT id, triggered_by, trigger, cost_usd, duration_ms, error_message, created_at,
              (SELECT COUNT(*)::int FROM vpm_recommendations WHERE run_id = vpm_runs.id) AS rec_count
         FROM vpm_runs ORDER BY created_at DESC LIMIT $1`,
      [lim],
    );
    return r.rows as any[];
  }

  async dismiss(id: string, by: string): Promise<VpmRecommendation> {
    return this.setStatus(id, 'dismissed', by);
  }

  async markDone(id: string, by: string): Promise<VpmRecommendation> {
    return this.setStatus(id, 'done', by);
  }

  private async setStatus(id: string, status: RecStatus, by: string): Promise<VpmRecommendation> {
    const r = await this.pg.query(
      `UPDATE vpm_recommendations
          SET status = $1, status_changed_at = now(), status_changed_by = $2
        WHERE id = $3
        RETURNING *`,
      [status, by, id],
    );
    if (!r.rows[0]) throw new NotFoundException('recommendation not found');
    return this.rowToRec(r.rows[0]);
  }

  // Convert a recommendation into a backlog item. Reuses BacklogService.create
  // and stamps the recommendation with the new item id so the UI can link to it.
  async toBacklog(id: string, by: string): Promise<{ recommendation: VpmRecommendation; backlogItem: BacklogItem }> {
    const recRow = await this.pg.query(`SELECT * FROM vpm_recommendations WHERE id = $1`, [id]);
    if (!recRow.rows[0]) throw new NotFoundException('recommendation not found');
    const rec = this.rowToRec(recRow.rows[0]);
    if (rec.backlog_item_id) {
      throw new BadRequestException('already converted to backlog item');
    }
    const item = await this.backlog.create(by, {
      title: rec.title,
      analysis_md: [
        '## Источник',
        '',
        `Эта задача предложена Виртуальным PM (рекомендация ${rec.id}, приоритет: **${rec.priority}**).`,
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
      `UPDATE vpm_recommendations
          SET status = 'in_backlog', backlog_item_id = $1, status_changed_at = now(), status_changed_by = $2
        WHERE id = $3
        RETURNING *`,
      [item.id, by, id],
    );
    return { recommendation: this.rowToRec(updated.rows[0]), backlogItem: item };
  }

  private rowToRec(row: any): VpmRecommendation {
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
