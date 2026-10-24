import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { PgService } from '../common/services/pg.service';
import type { DigestFinding } from './insights-digest';
import type { FindingStatus, FrictionType, PriorFinding, Signals, SynthFinding } from './insights.types';

export const INSIGHTS_MIGRATIONS = ['001_insights.sql'];

export interface RunRow {
  id: string;
  week_start: string;
  status: string;
  attempts: number;
  manual: boolean;
}

export interface CallbackFinding {
  id: string;
  type: FrictionType;
  title: string;
  description: string;
  proposal: string;
  status: FindingStatus;
  firstWeek: string;
  people: number;
  conversations: number;
  assistants: string[];
  weeks: number;
  runFindingIds: string[] | null;
}

@Injectable()
export class InsightsStore implements OnModuleInit {
  private readonly log = new Logger('InsightsStore');

  constructor(private readonly pg: PgService) {}

  async onModuleInit(): Promise<void> {
    for (const file of INSIGHTS_MIGRATIONS) {
      // .sql в dist не копируется (nest-cli.json без assets): на проде
      // работает второй путь, через src. Не удалять его как «dev-фолбэк».
      const candidates = [
        path.join(__dirname, 'migrations', file),
        path.join(__dirname, '..', '..', 'src', 'insights', 'migrations', file),
      ];
      const p = candidates.find((c) => fs.existsSync(c));
      if (!p) {
        this.log.error(`insights migration ${file} not found`);
        continue;
      }
      try {
        await this.pg.query(fs.readFileSync(p, 'utf8'));
      } catch (e: any) {
        this.log.error(`insights migration ${file} failed: ${e.message}`);
      }
    }
  }

  async isEnabled(): Promise<boolean> {
    const r = await this.pg.query(`SELECT value FROM insights_settings WHERE key = 'enabled'`);
    return r.rows[0]?.value === true;
  }

  async setEnabled(on: boolean): Promise<void> {
    await this.pg.query(
      `INSERT INTO insights_settings (key, value) VALUES ('enabled', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [JSON.stringify(on)],
    );
  }

  async doneRunExists(weekStart: string): Promise<boolean> {
    const r = await this.pg.query(
      `SELECT 1 FROM insights_runs WHERE week_start = $1::date AND NOT manual AND status IN ('done', 'running', 'postponed') LIMIT 1`,
      [weekStart],
    );
    return r.rows.length > 0;
  }

  async createRun(weekStart: string, manual: boolean): Promise<string> {
    const r = await this.pg.query(
      `INSERT INTO insights_runs (week_start, manual, status) VALUES ($1::date, $2, 'running') RETURNING id::text AS id`,
      [weekStart, manual],
    );
    return r.rows[0].id;
  }

  async markRunning(id: string): Promise<void> {
    await this.pg.query(`UPDATE insights_runs SET status = 'running', started_at = now() WHERE id = $1::uuid`, [id]);
  }

  async finishRun(
    id: string,
    p: { conversations: number; people: number; crisis: number; signals: Signals; costUsd: number },
  ): Promise<void> {
    await this.pg.query(
      `UPDATE insights_runs
          SET status = 'done', finished_at = now(), conversations = $2, people = $3, crisis_count = $4,
              signals = $5::jsonb, cost_usd = $6, error = NULL
        WHERE id = $1::uuid`,
      [id, p.conversations, p.people, p.crisis, JSON.stringify(p.signals), p.costUsd],
    );
  }

  async failRun(id: string, error: string): Promise<void> {
    await this.pg.query(
      `UPDATE insights_runs SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1::uuid`,
      [id, error.slice(0, 1000)],
    );
  }

  /** Отложить на 6 часов. Возвращает число уже сделанных попыток. */
  async postponeRun(id: string, error: string): Promise<number> {
    const r = await this.pg.query(
      `UPDATE insights_runs
          SET status = 'postponed', attempts = attempts + 1, retry_at = now() + interval '6 hours', error = $2
        WHERE id = $1::uuid
        RETURNING attempts`,
      [id, error.slice(0, 1000)],
    );
    return Number(r.rows[0]?.attempts ?? 0);
  }

  async duePostponed(maxAttempts: number): Promise<RunRow[]> {
    const r = await this.pg.query(
      `SELECT id::text AS id, to_char(week_start, 'YYYY-MM-DD') AS week_start, status, attempts, manual
         FROM insights_runs
        WHERE status = 'postponed' AND retry_at <= now() AND attempts < $1
        ORDER BY retry_at`,
      [maxAttempts],
    );
    return r.rows;
  }

  async setDigest(id: string, chatId: number, messageId: number | null, findingIds: string[]): Promise<void> {
    await this.pg.query(
      `UPDATE insights_runs SET digest_chat_id = $2, digest_message_id = $3, finding_ids = $4::uuid[] WHERE id = $1::uuid`,
      [id, chatId, messageId, findingIds],
    );
  }

  /** Находки последних восьми недель до weekStart — со статусами и числом людей на последней неделе. */
  async priorFindings(weekStart: string): Promise<PriorFinding[]> {
    const r = await this.pg.query(
      `SELECT f.id::text AS id, f.type, f.title, f.status, f.rejected_people,
              (SELECT count(*)::int FROM insights_finding_weeks w WHERE w.finding_id = f.id) AS weeks,
              (SELECT w.people FROM insights_finding_weeks w WHERE w.finding_id = f.id ORDER BY w.week_start DESC LIMIT 1) AS last_people
         FROM insights_findings f
        WHERE f.last_week >= $1::date - 56 AND f.last_week < $1::date
        ORDER BY f.last_week DESC`,
      [weekStart],
    );
    return r.rows.map((x: any) => ({
      id: x.id,
      type: x.type,
      title: x.title,
      status: x.status,
      weeks: Number(x.weeks ?? 0),
      lastPeople: Number(x.last_people ?? 0),
      rejectedPeople: x.rejected_people === null ? null : Number(x.rejected_people),
    }));
  }

  async saveFindings(weekStart: string, list: readonly SynthFinding[], prior: readonly PriorFinding[]): Promise<DigestFinding[]> {
    const priorById = new Map(prior.map((p) => [p.id, p]));
    const out: DigestFinding[] = [];
    for (const f of list) {
      let id: string;
      let status: FindingStatus = 'open';
      let weeksSeen = 1;
      let prevPeople: number | null = null;
      const before = f.priorId ? priorById.get(f.priorId) : undefined;
      if (before) {
        // Отклонённая сюда доходит, только если людей стало вдвое больше
        // (parseFindings) — тогда она снова открыта.
        const r = await this.pg.query(
          `UPDATE insights_findings
              SET title = $2, description = $3, proposal = $4, last_week = $5::date,
                  status = CASE WHEN status = 'rejected' THEN 'open' ELSE status END, updated_at = now()
            WHERE id = $1::uuid
            RETURNING id::text AS id, status`,
          [before.id, f.title, f.description, f.proposal, weekStart],
        );
        id = r.rows[0].id;
        status = r.rows[0].status;
        weeksSeen = before.weeks + 1;
        prevPeople = before.lastPeople;
      } else {
        const r = await this.pg.query(
          `INSERT INTO insights_findings (type, title, description, proposal, first_week, last_week)
           VALUES ($1, $2, $3, $4, $5::date, $5::date) RETURNING id::text AS id`,
          [f.type, f.title, f.description, f.proposal, weekStart],
        );
        id = r.rows[0].id;
      }
      await this.pg.query(
        `INSERT INTO insights_finding_weeks (finding_id, week_start, people, conversations, assistants, severity)
         VALUES ($1::uuid, $2::date, $3, $4, $5::text[], $6)
         ON CONFLICT (finding_id, week_start) DO UPDATE
           SET people = EXCLUDED.people, conversations = EXCLUDED.conversations,
               assistants = EXCLUDED.assistants, severity = EXCLUDED.severity`,
        [id, weekStart, f.people, f.conversations, f.assistants, f.severity],
      );
      out.push({ ...f, id, status, weeksSeen, prevPeople });
    }
    return out;
  }

  async findingForCallback(id: string): Promise<CallbackFinding | null> {
    const r = await this.pg.query(
      `SELECT f.id::text AS id, f.type, f.title, f.description, f.proposal, f.status,
              to_char(f.first_week, 'YYYY-MM-DD') AS first_week,
              w.people, w.conversations, w.assistants,
              (SELECT count(*)::int FROM insights_finding_weeks x WHERE x.finding_id = f.id) AS weeks,
              (SELECT r.finding_ids::text[] FROM insights_runs r
                WHERE f.id = ANY (r.finding_ids) ORDER BY r.started_at DESC LIMIT 1) AS run_finding_ids
         FROM insights_findings f
         LEFT JOIN LATERAL (
           SELECT y.people, y.conversations, y.assistants FROM insights_finding_weeks y
            WHERE y.finding_id = f.id ORDER BY y.week_start DESC LIMIT 1
         ) w ON true
        WHERE f.id = $1::uuid`,
      [id],
    );
    const x = r.rows[0];
    if (!x) return null;
    return {
      id: x.id,
      type: x.type,
      title: x.title,
      description: x.description,
      proposal: x.proposal,
      status: x.status,
      firstWeek: x.first_week,
      people: Number(x.people ?? 0),
      conversations: Number(x.conversations ?? 0),
      assistants: x.assistants ?? [],
      weeks: Number(x.weeks ?? 0),
      runFindingIds: x.run_finding_ids ?? null,
    };
  }

  /** open → backlog одним UPDATE: второе нажатие (или гонка) получит false. */
  async claimBacklog(id: string): Promise<boolean> {
    const r = await this.pg.query(
      `UPDATE insights_findings SET status = 'backlog', updated_at = now() WHERE id = $1::uuid AND status = 'open' RETURNING id`,
      [id],
    );
    return r.rows.length > 0;
  }

  async setBacklogItem(id: string, itemId: string): Promise<void> {
    await this.pg.query(`UPDATE insights_findings SET backlog_item_id = $2::uuid, updated_at = now() WHERE id = $1::uuid`, [id, itemId]);
  }

  async revertToOpen(id: string): Promise<void> {
    await this.pg.query(
      `UPDATE insights_findings SET status = 'open', updated_at = now()
        WHERE id = $1::uuid AND status = 'backlog' AND backlog_item_id IS NULL`,
      [id],
    );
  }

  async reject(id: string, people: number): Promise<boolean> {
    const r = await this.pg.query(
      `UPDATE insights_findings SET status = 'rejected', rejected_people = $2, updated_at = now()
        WHERE id = $1::uuid AND status = 'open' RETURNING id`,
      [id, people],
    );
    return r.rows.length > 0;
  }

  async statuses(ids: string[]): Promise<Map<string, FindingStatus>> {
    if (!ids.length) return new Map();
    const r = await this.pg.query(`SELECT id::text AS id, status FROM insights_findings WHERE id = ANY ($1::uuid[])`, [ids]);
    return new Map(r.rows.map((x: any) => [x.id, x.status]));
  }

  async status(): Promise<{ enabled: boolean; runs: unknown[] }> {
    const runs = await this.pg.query(
      `SELECT id::text AS id, to_char(week_start, 'YYYY-MM-DD') AS week_start, manual, status, attempts,
              conversations, people, crisis_count, cost_usd, error, started_at, finished_at
         FROM insights_runs ORDER BY started_at DESC LIMIT 5`,
    );
    return { enabled: await this.isEnabled(), runs: runs.rows };
  }
}
