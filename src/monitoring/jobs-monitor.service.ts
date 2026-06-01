import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';

/**
 * Async-jobs overview — a single endpoint summarising every background
 * queue we run so the admin can see at a glance whether anything is
 * backed up or stuck.
 *
 * Covered surfaces (all live in PG, no external state):
 *  - video_jobs (Kling generation pipeline)
 *  - token_consumption_tasks (billing — should drain every 5s via cron)
 *  - vpm_runs (Virtual PM generations — small volume, last 5 shown)
 *  - profile compaction (daily cron @ 04:00 UTC — schedule status only)
 *
 * Each surface gets: counts by status, oldest active item age (so a
 * backed-up queue is obvious), and an alert flag when an item has been
 * stuck longer than the per-queue threshold.
 *
 * The widget consuming this lives in MonitoringInfraView ("Фоновые задачи"
 * section).
 */

interface VideoJobsStat {
  status_counts: Record<string, number>;
  pending_total: number;        // pending + processing combined
  oldest_pending_age_min: number | null;
  stuck: boolean;               // oldest pending older than the threshold
  threshold_min: number;
}

interface TokenTasksStat {
  status_counts: Record<string, number>;
  pending_total: number;
  oldest_pending_age_sec: number | null;
  stuck: boolean;
  threshold_sec: number;
}

interface VpmRecentRun {
  id: string;
  trigger: string;
  cost_usd: number | null;
  duration_ms: number | null;
  ok: boolean;
  rec_count: number;
  created_at: string;
}

interface CompactionStat {
  schedule_human: string;       // "Daily 04:00 UTC"
  next_run_in_h: number | null; // hours until next scheduled trigger
  last_run_at: string | null;   // best-effort guess from events / consolidations table
  active_profiles: number;      // total profiles eligible to compact
}

export interface JobsMonitorOverview {
  generatedAt: string;
  video: VideoJobsStat;
  tokens: TokenTasksStat;
  vpm_recent: VpmRecentRun[];
  compaction: CompactionStat;
}

const VIDEO_STUCK_MIN = Number(process.env.VIDEO_STUCK_THRESHOLD_MIN || 30);
const TOKEN_STUCK_SEC = Number(process.env.TOKEN_TASK_STUCK_THRESHOLD_SEC || 60);

@Injectable()
export class JobsMonitorService {
  private readonly log = new Logger(JobsMonitorService.name);

  constructor(private readonly pg: PgService) {}

  async getOverview(): Promise<JobsMonitorOverview> {
    const [video, tokens, vpm, compaction] = await Promise.all([
      this.videoJobs(),
      this.tokenTasks(),
      this.vpmRecent(),
      this.compaction(),
    ]);
    return {
      generatedAt: new Date().toISOString(),
      video, tokens, vpm_recent: vpm, compaction,
    };
  }

  private async videoJobs(): Promise<VideoJobsStat> {
    try {
      const counts = await this.pg.query(
        `SELECT status, COUNT(*)::int AS n
           FROM video_jobs
          WHERE created_at > now() - interval '30 days'
          GROUP BY status`,
      );
      const status_counts: Record<string, number> = {};
      for (const r of counts.rows as any[]) status_counts[r.status] = r.n;

      const oldest = await this.pg.query(
        `SELECT EXTRACT(EPOCH FROM (now() - MIN(created_at)))/60 AS age_min
           FROM video_jobs WHERE status IN ('pending','processing')`,
      );
      const ageMin = oldest.rows[0]?.age_min;
      const oldest_pending_age_min = ageMin == null ? null : +Number(ageMin).toFixed(1);
      const pending_total = (status_counts['pending'] || 0) + (status_counts['processing'] || 0);
      return {
        status_counts,
        pending_total,
        oldest_pending_age_min,
        stuck: oldest_pending_age_min != null && oldest_pending_age_min > VIDEO_STUCK_MIN,
        threshold_min: VIDEO_STUCK_MIN,
      };
    } catch (e: any) {
      this.log.warn(`videoJobs failed: ${e.message}`);
      return { status_counts: {}, pending_total: 0, oldest_pending_age_min: null, stuck: false, threshold_min: VIDEO_STUCK_MIN };
    }
  }

  private async tokenTasks(): Promise<TokenTasksStat> {
    try {
      const counts = await this.pg.query(
        `SELECT status::text AS status, COUNT(*)::int AS n
           FROM token_consumption_tasks
          WHERE created_at > now() - interval '7 days'
          GROUP BY status`,
      );
      const status_counts: Record<string, number> = {};
      for (const r of counts.rows as any[]) status_counts[r.status] = r.n;

      const oldest = await this.pg.query(
        `SELECT EXTRACT(EPOCH FROM (now() - MIN(created_at))) AS age_sec
           FROM token_consumption_tasks WHERE status::text IN ('pending','processing')`,
      );
      const ageSec = oldest.rows[0]?.age_sec;
      const oldest_pending_age_sec = ageSec == null ? null : +Number(ageSec).toFixed(0);
      const pending_total = (status_counts['pending'] || 0) + (status_counts['processing'] || 0);
      return {
        status_counts,
        pending_total,
        oldest_pending_age_sec,
        stuck: oldest_pending_age_sec != null && oldest_pending_age_sec > TOKEN_STUCK_SEC,
        threshold_sec: TOKEN_STUCK_SEC,
      };
    } catch (e: any) {
      this.log.warn(`tokenTasks failed: ${e.message}`);
      return { status_counts: {}, pending_total: 0, oldest_pending_age_sec: null, stuck: false, threshold_sec: TOKEN_STUCK_SEC };
    }
  }

  private async vpmRecent(): Promise<VpmRecentRun[]> {
    try {
      const r = await this.pg.query(
        `SELECT id, trigger, cost_usd, duration_ms, error_message, created_at,
                (SELECT COUNT(*)::int FROM vpm_recommendations WHERE run_id = vpm_runs.id) AS rec_count
           FROM vpm_runs
          ORDER BY created_at DESC
          LIMIT 5`,
      );
      return r.rows.map((row: any) => ({
        id: row.id,
        trigger: row.trigger,
        cost_usd: row.cost_usd == null ? null : Number(row.cost_usd),
        duration_ms: row.duration_ms,
        ok: !row.error_message,
        rec_count: row.rec_count,
        created_at: new Date(row.created_at).toISOString(),
      }));
    } catch { return []; }
  }

  private async compaction(): Promise<CompactionStat> {
    // Schedule string mirrors the @Cron('0 4 * * *') in profile-compaction.service.
    // We compute "next run in" relative to that. Last-run is best-effort: the
    // compaction writes back to ai_profiles_consolidated.updated_at on each
    // user, so the latest updated_at AT the moment of 04:00 UTC is a fair
    // proxy for "compaction ran".
    let active_profiles = 0;
    let last_run_at: string | null = null;
    try {
      const cnt = await this.pg.query(`SELECT COUNT(*)::int AS n FROM ai_profiles_consolidated`);
      active_profiles = cnt.rows[0]?.n || 0;
      const last = await this.pg.query(
        `SELECT MAX(updated_at) AS t FROM ai_profiles_consolidated`,
      );
      last_run_at = last.rows[0]?.t ? new Date(last.rows[0].t).toISOString() : null;
    } catch { /* silent */ }

    const now = new Date();
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 4, 0, 0));
    if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
    const next_run_in_h = +((next.getTime() - now.getTime()) / 3600_000).toFixed(1);
    return {
      schedule_human: 'Daily 04:00 UTC',
      next_run_in_h,
      last_run_at,
      active_profiles,
    };
  }
}
