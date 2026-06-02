import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { spawn } from 'child_process';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Daily backup health monitor.
 *
 * Watches /home/dvolkov/backups/linkeon (the directory the nightly
 * backup.sh writes to) for:
 *  - **Freshness**: did the cron actually run? Latest backup ≤ 36h old.
 *  - **Completeness**: are all 5–6 expected artifacts in the latest
 *    snapshot (pg dump, neo4j dump, neo4j.schema.txt once it ships,
 *    spirits_back.env, worker.env, agent-avatars.tar.gz)?
 *  - **Integrity**: gunzip -t to validate gzip CRC; tar tzf to validate
 *    tarball; plain files just need to exist and be non-empty.
 *  - **Trend**: 7-day rolling count + size comparison so silent
 *    truncation (e.g. disk-full mid-pg_dump) shows up before it bites.
 *
 * Alert via Telegram if no backup in >36h OR latest snapshot has any
 * failed-integrity artifact. Cooldown 12h so we don't spam during an
 * ongoing incident.
 *
 * Why this and not actual replication: production runs PostgreSQL,
 * Neo4j, and MinIO on a single node — there's nothing to "synchronize
 * between nodes" yet. Backup health is the closest meaningful proxy
 * for data durability we can measure today. Real replication is its
 * own backlog item.
 */

interface ArtifactStatus {
  name: string;
  expected: boolean;     // we always expect it
  present: boolean;
  sizeBytes: number | null;
  integrityOk: boolean | null; // null = not checked (file missing)
  error: string | null;
}

interface SnapshotInfo {
  dir: string;
  ts: string;            // ISO of the snapshot directory mtime
  ageHours: number;
  totalBytes: number;
  artifacts: ArtifactStatus[];
  fresh: boolean;        // age within FRESH_HOURS
  complete: boolean;     // all expected artifacts present
  healthy: boolean;      // complete + every present artifact OK + fresh
}

const BACKUP_ROOT = process.env.BACKUP_DIR || '/home/dvolkov/backups/linkeon';
const FRESH_HOURS = Number(process.env.BACKUP_FRESH_HOURS || 36);
const ALERT_COOLDOWN_HOURS = Number(process.env.BACKUP_ALERT_COOLDOWN_H || 12);
// NOTE: Telegram creds are read at call time inside maybeAlert(), not here —
// module-level process.env reads run before ConfigModule loads .env, so a
// const here would always be '' and silently disable alerts.

// What backup.sh writes. neo4j.schema.txt was added 2026-06-01 — the
// service treats it as "expected if recent enough" so old snapshots
// without it don't get falsely flagged.
const EXPECTED_ARTIFACTS = [
  'linkeon.sql.gz',
  'neo4j.dump.gz',
  'neo4j.schema.txt',
  'spirits_back.env',
  'spirits_back-worker.env',
  'agent-avatars.tar.gz',
];
// Cutoff after which neo4j.schema.txt becomes mandatory.
const SCHEMA_REQUIRED_FROM = new Date('2026-06-02T00:00:00Z').getTime();

export interface BackupHealthOverview {
  generatedAt: string;
  backupRoot: string;
  freshHours: number;
  latest: SnapshotInfo | null;
  weekTotalGB: number | null;     // sum of last 7 days' snapshot sizes
  weekSnapshotCount: number;      // expect 7
  error: string | null;
}

@Injectable()
export class BackupHealthService implements OnModuleInit {
  private readonly log = new Logger(BackupHealthService.name);
  private cache: BackupHealthOverview = {
    generatedAt: new Date(0).toISOString(),
    backupRoot: BACKUP_ROOT,
    freshHours: FRESH_HOURS,
    latest: null,
    weekTotalGB: null,
    weekSnapshotCount: 0,
    error: null,
  };
  private lastAlertAt: Date | null = null;

  async onModuleInit() {
    this.refresh().catch(() => {});
  }

  @Cron(CronExpression.EVERY_HOUR)
  async hourly() {
    await this.refresh();
    await this.maybeAlert();
  }

  private async refresh(): Promise<void> {
    try {
      if (!fs.existsSync(BACKUP_ROOT)) {
        this.cache = {
          generatedAt: new Date().toISOString(),
          backupRoot: BACKUP_ROOT,
          freshHours: FRESH_HOURS,
          latest: null,
          weekTotalGB: null,
          weekSnapshotCount: 0,
          error: `backup root not found: ${BACKUP_ROOT}`,
        };
        return;
      }
      const dirs = fs.readdirSync(BACKUP_ROOT)
        .filter((n) => /^\d{8}-\d{6}$/.test(n))
        .map((n) => path.join(BACKUP_ROOT, n))
        .filter((p) => fs.statSync(p).isDirectory());
      dirs.sort();

      const latestPath = dirs.length > 0 ? dirs[dirs.length - 1] : null;
      const latest = latestPath ? await this.inspectSnapshot(latestPath) : null;

      // 7-day rolling totals
      const cutoff = Date.now() - 7 * 86400_000;
      let weekBytes = 0;
      let weekCount = 0;
      for (const d of dirs) {
        const m = fs.statSync(d).mtime.getTime();
        if (m < cutoff) continue;
        weekCount += 1;
        weekBytes += this.dirSize(d);
      }

      this.cache = {
        generatedAt: new Date().toISOString(),
        backupRoot: BACKUP_ROOT,
        freshHours: FRESH_HOURS,
        latest,
        weekTotalGB: weekBytes > 0 ? +(weekBytes / 1024 / 1024 / 1024).toFixed(2) : 0,
        weekSnapshotCount: weekCount,
        error: null,
      };
    } catch (e: any) {
      this.log.warn(`Backup refresh failed: ${e.message}`);
      this.cache = {
        generatedAt: new Date().toISOString(),
        backupRoot: BACKUP_ROOT,
        freshHours: FRESH_HOURS,
        latest: null,
        weekTotalGB: null,
        weekSnapshotCount: 0,
        error: e?.message || 'inspect failed',
      };
    }
  }

  private dirSize(d: string): number {
    try {
      return fs.readdirSync(d).reduce((sum, f) => {
        try { return sum + fs.statSync(path.join(d, f)).size; }
        catch { return sum; }
      }, 0);
    } catch { return 0; }
  }

  private async inspectSnapshot(dir: string): Promise<SnapshotInfo> {
    const st = fs.statSync(dir);
    const ageMs = Date.now() - st.mtime.getTime();
    const ageHours = ageMs / 3600_000;

    const schemaRequired = st.mtime.getTime() >= SCHEMA_REQUIRED_FROM;

    const artifacts: ArtifactStatus[] = [];
    for (const name of EXPECTED_ARTIFACTS) {
      const expected = name !== 'neo4j.schema.txt' || schemaRequired;
      const p = path.join(dir, name);
      let present = false;
      let sizeBytes: number | null = null;
      try {
        const s = fs.statSync(p);
        present = true;
        sizeBytes = s.size;
      } catch { /* not present */ }
      let integrityOk: boolean | null = null;
      let error: string | null = null;
      if (present) {
        if ((sizeBytes ?? 0) <= 100) {
          integrityOk = false;
          error = `file too small (${sizeBytes} bytes) — probably truncated`;
        } else if (name.endsWith('.gz')) {
          const r = await this.gunzipTest(p);
          integrityOk = r.ok;
          if (!r.ok) error = r.error;
        } else if (name.endsWith('.tar.gz')) {
          const r = await this.tarTest(p);
          integrityOk = r.ok;
          if (!r.ok) error = r.error;
        } else {
          // .env or .txt — non-empty is enough
          integrityOk = true;
        }
      } else if (expected) {
        error = 'missing';
      }
      artifacts.push({ name, expected, present, sizeBytes, integrityOk, error });
    }
    const totalBytes = artifacts.reduce((s, a) => s + (a.sizeBytes ?? 0), 0);
    const complete = artifacts.every((a) => !a.expected || a.present);
    const integrityClean = artifacts.every((a) => !a.present || a.integrityOk === true);
    const fresh = ageHours <= FRESH_HOURS;
    return {
      dir,
      ts: st.mtime.toISOString(),
      ageHours: +ageHours.toFixed(2),
      totalBytes,
      artifacts,
      fresh,
      complete,
      healthy: fresh && complete && integrityClean,
    };
  }

  // `gunzip -t <file>` validates gzip CRC without writing to disk.
  // Cheap on 100MB files.
  private gunzipTest(file: string): Promise<{ ok: boolean; error: string | null }> {
    return new Promise((resolve) => {
      const proc = spawn('gunzip', ['-t', file], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      proc.stderr.on('data', (b) => { stderr += b.toString(); });
      proc.on('close', (code) => resolve({ ok: code === 0, error: code === 0 ? null : stderr.slice(0, 200) }));
      proc.on('error', (e) => resolve({ ok: false, error: e.message }));
    });
  }

  // `tar tzf` lists archive contents — fails fast on corruption.
  private tarTest(file: string): Promise<{ ok: boolean; error: string | null }> {
    return new Promise((resolve) => {
      const proc = spawn('tar', ['tzf', file], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      proc.stderr.on('data', (b) => { stderr += b.toString(); });
      proc.on('close', (code) => resolve({ ok: code === 0, error: code === 0 ? null : stderr.slice(0, 200) }));
      proc.on('error', (e) => resolve({ ok: false, error: e.message }));
    });
  }

  private async maybeAlert(): Promise<void> {
    const latest = this.cache.latest;
    const problems: string[] = [];
    if (!latest) {
      problems.push('Бэкап не найден в директории');
    } else {
      if (!latest.fresh) problems.push(`Последний бэкап ${latest.ageHours.toFixed(1)}ч назад (порог ${FRESH_HOURS}ч)`);
      if (!latest.complete) {
        const missing = latest.artifacts.filter((a) => a.expected && !a.present).map((a) => a.name);
        problems.push(`Отсутствуют: ${missing.join(', ')}`);
      }
      const broken = latest.artifacts.filter((a) => a.present && a.integrityOk === false);
      if (broken.length > 0) {
        problems.push(`Повреждены: ${broken.map((b) => `${b.name} (${b.error?.slice(0, 80)})`).join(', ')}`);
      }
    }
    if (problems.length === 0) return;
    const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
    const TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';
    if (!TG_TOKEN || !TG_CHAT) return;
    const now = new Date();
    if (this.lastAlertAt && (now.getTime() - this.lastAlertAt.getTime()) < ALERT_COOLDOWN_HOURS * 3600_000) {
      return;
    }
    try {
      await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        chat_id: TG_CHAT,
        parse_mode: 'HTML',
        text: `<b>⚠️ Бэкап: обнаружены проблемы</b>\n` +
              problems.map((p) => `• ${p}`).join('\n') + `\n\n` +
              `Директория: <code>${BACKUP_ROOT}</code>`,
      }, { timeout: 8000 });
      this.lastAlertAt = now;
      this.log.warn(`Backup health alert sent: ${problems.join(' | ')}`);
    } catch (e: any) {
      this.log.error(`Telegram alert failed: ${e?.message || 'unknown'}`);
    }
  }

  async getOverview(): Promise<BackupHealthOverview> {
    return this.cache;
  }
}
