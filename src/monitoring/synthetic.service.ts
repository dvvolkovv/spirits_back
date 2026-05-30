import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { PgService } from '../common/services/pg.service';

/**
 * Synthetic E2E results.
 *
 * Cron job on node-3 runs ./scripts/synthetic-runner.js every N minutes,
 * exercising critical paths against my.linkeon.io. Each scenario result
 * is POSTed back to /webhook/admin/monitoring/synthetic/push with the
 * shared SYNTHETIC_PUSH_TOKEN.
 *
 * Per-scenario overview takes the latest run + a 24h aggregate so the UI
 * can show: current status, last run time, last error, recent reliability.
 */

export interface ScenarioStatus {
  scenario: string;
  latestSuccess: boolean | null;
  latestTs: string | null;
  latestDurationMs: number | null;
  latestMessage: string | null;
  runs24h: number;
  successes24h: number;
  successRate24hPct: number | null;
}

export interface SyntheticOverview {
  generatedAt: string;
  scenarios: ScenarioStatus[];
}

@Injectable()
export class SyntheticService implements OnModuleInit {
  private readonly log = new Logger(SyntheticService.name);

  constructor(@Optional() private readonly pg?: PgService) {}

  async onModuleInit() {
    if (!this.pg) return;
    const candidates = [
      path.join(__dirname, 'migrations', '001_synthetic.sql'),
      path.join(__dirname, '..', '..', 'src', 'monitoring', 'migrations', '001_synthetic.sql'),
    ];
    const found = candidates.find((p) => fs.existsSync(p));
    if (!found) {
      this.log.warn('synthetic migration sql not found, skipping');
      return;
    }
    const sql = fs.readFileSync(found, 'utf8');
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        await this.pg.query(sql);
        this.log.log(`synthetic migration applied from ${found}`);
        return;
      } catch (e: any) {
        if (attempt === 5) {
          this.log.error(`synthetic migration failed after 5 attempts: ${e.message}`);
        } else {
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    }
  }

  async record(scenario: string, success: boolean, durationMs: number, message: string | null) {
    if (!this.pg || !scenario) return;
    try {
      await this.pg.query(
        `INSERT INTO synthetic_runs (scenario, success, duration_ms, message)
         VALUES ($1, $2, $3, $4)`,
        [scenario, success, Math.round(durationMs || 0), message ? String(message).slice(0, 500) : null],
      );
    } catch (e: any) {
      this.log.error(`synthetic record failed: ${e.message}`);
    }
  }

  async getOverview(): Promise<SyntheticOverview> {
    if (!this.pg) return { generatedAt: new Date().toISOString(), scenarios: [] };

    // For each scenario: latest run row + 24h aggregates.
    const r = await this.pg.query(
      `WITH latest AS (
         SELECT DISTINCT ON (scenario)
                scenario, ts, success, duration_ms, message
         FROM synthetic_runs
         ORDER BY scenario, ts DESC
       ),
       agg AS (
         SELECT scenario,
                COUNT(*)                                 AS runs,
                COUNT(*) FILTER (WHERE success)          AS successes
         FROM synthetic_runs
         WHERE ts >= now() - interval '24 hours'
         GROUP BY scenario
       )
       SELECT l.scenario,
              l.success                AS latest_success,
              l.ts                     AS latest_ts,
              l.duration_ms            AS latest_duration_ms,
              l.message                AS latest_message,
              COALESCE(a.runs, 0)      AS runs_24h,
              COALESCE(a.successes, 0) AS successes_24h
       FROM latest l
       LEFT JOIN agg a ON a.scenario = l.scenario
       ORDER BY l.scenario`,
    );

    const scenarios: ScenarioStatus[] = r.rows.map((row: any) => {
      const runs = Number(row.runs_24h);
      const succ = Number(row.successes_24h);
      return {
        scenario: row.scenario,
        latestSuccess: row.latest_success,
        latestTs: row.latest_ts instanceof Date ? row.latest_ts.toISOString() : String(row.latest_ts),
        latestDurationMs: row.latest_duration_ms,
        latestMessage: row.latest_message,
        runs24h: runs,
        successes24h: succ,
        successRate24hPct: runs > 0 ? (succ / runs) * 100 : null,
      };
    });
    return { generatedAt: new Date().toISOString(), scenarios };
  }
}
