import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { spawn } from 'child_process';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Neo4j DR-snapshot health (DR Sprint 2).
 *
 * Neo4j Community can't do streaming replication (Enterprise-only), so the DR
 * story for the graph is a daily snapshot rsync: backup.sh dumps neo4j nightly
 * and rsyncs neo4j.dump.gz + neo4j.schema.txt to node-3 over WireGuard. This
 * service answers "is node-3 actually holding a fresh, byte-identical copy of
 * the latest prod dump?"
 *
 * It compares prod's local latest snapshot (the newest dir under BACKUP_ROOT,
 * same files BackupHealthService validates) against node-3's DR copy probed
 * over SSH:
 *  - both present?
 *  - md5 match → byte-identical (and since BackupHealthService gunzip-tests the
 *    prod copy, an md5 match transitively proves the node-3 copy is valid too)
 *  - age of the node-3 copy (rsync -a preserves mtime, so this == the backup
 *    time) below the freshness threshold?
 *  - size trend vs the previous snapshot, to catch silent truncation
 *
 * Gated on NEO4J_DR_HOST — unset (e.g. the test server, which has no node-3)
 * → configured:false, doesn't probe, doesn't drag health down.
 */

interface NeoDrFile {
  name: string;
  localPresent: boolean;
  localSizeBytes: number | null;
  localMtime: string | null;
  localMd5: string | null;
  remotePresent: boolean;
  remoteSizeBytes: number | null;
  remoteMtime: string | null;
  remoteMd5: string | null;
  inSync: boolean;                // md5 match, both present
  remoteAgeHours: number | null;  // now - remote mtime
}

export interface NeoSnapshotOverview {
  generatedAt: string;
  configured: boolean;
  reachable: boolean;             // SSH to node-3 succeeded
  host: string | null;
  dir: string | null;
  files: NeoDrFile[];
  dumpSizeBytes: number | null;       // current prod dump size
  prevDumpSizeBytes: number | null;   // previous snapshot's dump size (trend)
  freshHours: number;
  healthy: boolean;
  error: string | null;
}

const BACKUP_ROOT = process.env.BACKUP_DIR || '/home/dvolkov/backups/linkeon';
const DR_HOST = process.env.NEO4J_DR_HOST || '';
const DR_USER = process.env.NEO4J_DR_SSH_USER || 'dvolkov';
const DR_DIR = process.env.NEO4J_DR_DIR || '/var/lib/linkeon-dr/neo4j';
const FRESH_HOURS = Number(process.env.NEO4J_DR_FRESH_HOURS || 48);
const ALERT_COOLDOWN_HOURS = Number(process.env.NEO4J_DR_ALERT_COOLDOWN_H || 12);
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';

// The DR-mirrored artifacts. The dump drives health; schema is informational.
const DR_FILES = ['neo4j.dump.gz', 'neo4j.schema.txt'];
const CRITICAL_FILE = 'neo4j.dump.gz';

@Injectable()
export class NeoSnapshotHealthService implements OnModuleInit {
  private readonly log = new Logger(NeoSnapshotHealthService.name);
  private cache: NeoSnapshotOverview = this.emptyOverview();
  private lastAlertAt: Date | null = null;

  private emptyOverview(error: string | null = null): NeoSnapshotOverview {
    return {
      generatedAt: new Date(0).toISOString(),
      configured: !!DR_HOST,
      reachable: false,
      host: DR_HOST || null,
      dir: DR_HOST ? DR_DIR : null,
      files: [],
      dumpSizeBytes: null,
      prevDumpSizeBytes: null,
      freshHours: FRESH_HOURS,
      healthy: false,
      error,
    };
  }

  async onModuleInit() {
    if (DR_HOST) this.refresh().catch(() => {});
  }

  @Cron(CronExpression.EVERY_HOUR)
  async hourly() {
    if (!DR_HOST) return;
    await this.refresh();
    await this.maybeAlert();
  }

  // Newest two snapshot dirs under BACKUP_ROOT (latest, previous).
  private snapshotDirs(): string[] {
    if (!fs.existsSync(BACKUP_ROOT)) return [];
    return fs.readdirSync(BACKUP_ROOT)
      .filter((n) => /^\d{8}-\d{6}$/.test(n))
      .map((n) => path.join(BACKUP_ROOT, n))
      .filter((p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } })
      .sort();
  }

  private async refresh(): Promise<void> {
    if (!DR_HOST) { this.cache = this.emptyOverview(); return; }
    try {
      const dirs = this.snapshotDirs();
      const latestDir = dirs.length ? dirs[dirs.length - 1] : null;
      const prevDir = dirs.length > 1 ? dirs[dirs.length - 2] : null;

      // Local side (prod's latest snapshot)
      const local: Record<string, { size: number | null; mtime: string | null; md5: string | null }> = {};
      for (const name of DR_FILES) {
        const p = latestDir ? path.join(latestDir, name) : null;
        if (p && fs.existsSync(p)) {
          const st = fs.statSync(p);
          local[name] = { size: st.size, mtime: st.mtime.toISOString(), md5: await this.localMd5(p) };
        } else {
          local[name] = { size: null, mtime: null, md5: null };
        }
      }

      // Remote side (node-3 DR copy) over SSH — one round-trip for all files.
      const remote = await this.probeRemote();

      const files: NeoDrFile[] = DR_FILES.map((name) => {
        const l = local[name];
        const r = remote.files[name] || { present: false, size: null, mtimeEpoch: null, md5: null };
        const remoteMtime = r.mtimeEpoch != null ? new Date(r.mtimeEpoch * 1000).toISOString() : null;
        const remoteAgeHours = r.mtimeEpoch != null
          ? +(((Date.now() / 1000) - r.mtimeEpoch) / 3600).toFixed(2)
          : null;
        const inSync = !!(l.md5 && r.md5 && l.md5 === r.md5);
        return {
          name,
          localPresent: l.md5 != null || l.size != null,
          localSizeBytes: l.size,
          localMtime: l.mtime,
          localMd5: l.md5,
          remotePresent: r.present,
          remoteSizeBytes: r.size,
          remoteMtime,
          remoteMd5: r.md5,
          inSync,
          remoteAgeHours,
        };
      });

      const dump = files.find((f) => f.name === CRITICAL_FILE);
      const prevDumpSizeBytes = prevDir
        ? (() => { try { return fs.statSync(path.join(prevDir, CRITICAL_FILE)).size; } catch { return null; } })()
        : null;

      const healthy = remote.reachable
        && !!dump
        && dump.localPresent && dump.remotePresent
        && dump.inSync
        && dump.remoteAgeHours != null && dump.remoteAgeHours <= FRESH_HOURS;

      this.cache = {
        generatedAt: new Date().toISOString(),
        configured: true,
        reachable: remote.reachable,
        host: DR_HOST,
        dir: DR_DIR,
        files,
        dumpSizeBytes: dump?.localSizeBytes ?? null,
        prevDumpSizeBytes,
        freshHours: FRESH_HOURS,
        healthy,
        error: remote.reachable ? null : (remote.error || 'node-3 unreachable'),
      };
    } catch (e: any) {
      this.log.warn(`neo4j DR refresh failed: ${e.message}`);
      this.cache = this.emptyOverview(e?.message || 'refresh failed');
    }
  }

  // Probe node-3 in one SSH call: per file emit "name|size|mtimeEpoch|md5" or "name|MISSING".
  private async probeRemote(): Promise<{
    reachable: boolean;
    error: string | null;
    files: Record<string, { present: boolean; size: number | null; mtimeEpoch: number | null; md5: string | null }>;
  }> {
    const fileList = DR_FILES.join(' ');
    const remoteCmd =
      `cd ${DR_DIR} 2>/dev/null || exit 7; for f in ${fileList}; do ` +
      `if [ -f "$f" ]; then echo "$f|$(stat -c '%s|%Y' "$f")|$(md5sum "$f" | cut -d' ' -f1)"; ` +
      `else echo "$f|MISSING"; fi; done`;

    const res = await this.runSsh(remoteCmd);
    const files: Record<string, { present: boolean; size: number | null; mtimeEpoch: number | null; md5: string | null }> = {};
    if (!res.ok) {
      return { reachable: false, error: res.error || 'ssh failed', files };
    }
    for (const line of res.stdout.split('\n').map((l) => l.trim()).filter(Boolean)) {
      const parts = line.split('|');
      const name = parts[0];
      if (!DR_FILES.includes(name)) continue;
      if (parts[1] === 'MISSING') {
        files[name] = { present: false, size: null, mtimeEpoch: null, md5: null };
      } else {
        files[name] = {
          present: true,
          size: parts[1] != null ? Number(parts[1]) : null,
          mtimeEpoch: parts[2] != null ? Number(parts[2]) : null,
          md5: parts[3] || null,
        };
      }
    }
    return { reachable: true, error: null, files };
  }

  private runSsh(remoteCmd: string): Promise<{ ok: boolean; stdout: string; error: string | null }> {
    return new Promise((resolve) => {
      const args = [
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=8',
        '-o', 'StrictHostKeyChecking=accept-new',
        `${DR_USER}@${DR_HOST}`,
        remoteCmd,
      ];
      const proc = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const killer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } }, 15000);
      proc.stdout.on('data', (b) => { stdout += b.toString(); });
      proc.stderr.on('data', (b) => { stderr += b.toString(); });
      proc.on('close', (code) => {
        clearTimeout(killer);
        resolve({ ok: code === 0, stdout, error: code === 0 ? null : (stderr.slice(0, 200) || `ssh exit ${code}`) });
      });
      proc.on('error', (e) => { clearTimeout(killer); resolve({ ok: false, stdout: '', error: e.message }); });
    });
  }

  private localMd5(file: string): Promise<string | null> {
    return new Promise((resolve) => {
      const proc = spawn('md5sum', [file], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      proc.stdout.on('data', (b) => { out += b.toString(); });
      proc.on('close', (code) => resolve(code === 0 ? (out.trim().split(/\s+/)[0] || null) : null));
      proc.on('error', () => resolve(null));
    });
  }

  private async maybeAlert(): Promise<void> {
    const c = this.cache;
    if (!c.configured) return;
    const problems: string[] = [];
    if (!c.reachable) {
      problems.push(`node-3 недоступен по SSH (${c.error || 'unknown'})`);
    } else {
      const dump = c.files.find((f) => f.name === CRITICAL_FILE);
      if (!dump || !dump.remotePresent) problems.push('neo4j.dump.gz отсутствует на node-3');
      else {
        if (!dump.inSync) problems.push('md5 дампа на node-3 не совпадает с прод-latest (рассинхрон)');
        if (dump.remoteAgeHours != null && dump.remoteAgeHours > FRESH_HOURS) {
          problems.push(`копия на node-3 ${dump.remoteAgeHours.toFixed(1)}ч (порог ${FRESH_HOURS}ч)`);
        }
      }
    }
    if (problems.length === 0 || !TG_TOKEN || !TG_CHAT) return;
    const now = new Date();
    if (this.lastAlertAt && (now.getTime() - this.lastAlertAt.getTime()) < ALERT_COOLDOWN_HOURS * 3600_000) return;
    try {
      await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        chat_id: TG_CHAT,
        parse_mode: 'HTML',
        text: `<b>⚠️ Neo4j DR (node-3): проблемы</b>\n` +
          problems.map((p) => `• ${p}`).join('\n') +
          `\n\nЦель: <code>${DR_USER}@${DR_HOST}:${DR_DIR}</code>`,
      }, { timeout: 8000 });
      this.lastAlertAt = now;
      this.log.warn(`Neo4j DR alert sent: ${problems.join(' | ')}`);
    } catch (e: any) {
      this.log.error(`Telegram alert failed: ${e?.message || 'unknown'}`);
    }
  }

  async getOverview(): Promise<NeoSnapshotOverview> {
    // Serve cache; if it was never populated (e.g. first call before the cron),
    // refresh on-demand so the widget isn't empty right after a restart.
    if (DR_HOST && this.cache.generatedAt === new Date(0).toISOString()) {
      await this.refresh();
    }
    return this.cache;
  }
}
