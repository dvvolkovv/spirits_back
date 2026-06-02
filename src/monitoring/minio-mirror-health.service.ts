import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import axios from 'axios';
import * as fs from 'fs';

/**
 * MinIO DR-mirror health (DR Sprint 3).
 *
 * SMM media (buckets linkeon-smm-videos / linkeon-smm-music) lives only in
 * prod's single-node MinIO. The DR mirror is an hourly `mc mirror` (prod →
 * node-3 over WireGuard) run by minio-mirror.sh, which writes a status JSON
 * after each pass. This service surfaces that status: when did the mirror last
 * run, is node-3 covering every prod object, and did mc report errors.
 *
 * Mirror semantics are COVERAGE, not byte-exact equality — minio-mirror.sh runs
 * `mc mirror --overwrite` WITHOUT `--remove`, so a prod-side wipe can't cascade
 * to the DR copy. "inSync" therefore means node-3 holds ≥ everything prod holds.
 *
 * We read the cron's status file rather than talking to MinIO ourselves: the
 * cron already does the work and is the authoritative record of the last real
 * sync (same pattern as BackupHealthService reading the nightly snapshot dir).
 *
 * Gated on the status file existing — on the test server there's no mirror, so
 * configured:false and it doesn't drag health down. Env read at construction,
 * not module load (module-level process.env reads run before ConfigModule
 * populates .env).
 */

interface MinioBucketStatus {
  bucket: string;
  srcObjects: number;
  srcBytes: number;
  dstObjects: number;
  dstBytes: number;
  inSync: boolean;
}

export interface MinioMirrorOverview {
  generatedAt: string;
  configured: boolean;
  statusPresent: boolean;
  lastRunAt: string | null;
  ageMin: number | null;
  durationSec: number | null;
  drEndpoint: string | null;
  buckets: MinioBucketStatus[];
  totalSrcObjects: number | null;
  totalDstObjects: number | null;
  totalSrcBytes: number | null;
  totalDstBytes: number | null;
  errors: string[];
  freshMin: number;
  healthy: boolean;
  error: string | null;
}

@Injectable()
export class MinioMirrorHealthService {
  private readonly log = new Logger(MinioMirrorHealthService.name);

  private readonly statusPath: string;
  private readonly freshMin: number;
  private readonly alertCooldownH: number;
  private lastAlertAt: Date | null = null;

  constructor() {
    this.statusPath = process.env.MINIO_MIRROR_STATUS
      || '/home/dvolkov/backups/linkeon/minio-mirror-status.json';
    // Cron is hourly; allow a couple of missed runs before flagging stale.
    this.freshMin = Number(process.env.MINIO_MIRROR_FRESH_MIN || 180);
    this.alertCooldownH = Number(process.env.MINIO_MIRROR_ALERT_COOLDOWN_H || 6);
  }

  // DR Sprint 4: hourly alert pass — Telegram heads-up if the mirror goes
  // stale, a bucket stops being covered, or mc logged errors.
  @Cron(CronExpression.EVERY_HOUR)
  async hourly() {
    try {
      const ov = await this.getOverview();
      await this.maybeAlert(ov);
    } catch (e: any) {
      this.log.warn(`minio mirror hourly alert pass failed: ${e.message}`);
    }
  }

  private async maybeAlert(ov: MinioMirrorOverview): Promise<void> {
    if (!ov.configured) return; // not running here (e.g. test) — nothing to alert on
    const problems: string[] = [];
    if (!ov.statusPresent || ov.error) {
      problems.push(`статус зеркала недоступен: ${ov.error || 'нет файла'}`);
    } else {
      if (ov.ageMin != null && ov.ageMin > ov.freshMin) {
        problems.push(`последний sync ${(ov.ageMin / 60).toFixed(1)}ч назад (порог ${(ov.freshMin / 60).toFixed(0)}ч)`);
      }
      const behind = ov.buckets.filter((b) => !b.inSync).map((b) => `${b.bucket} (${b.dstObjects}/${b.srcObjects})`);
      if (behind.length) problems.push(`бакеты отстают: ${behind.join(', ')}`);
      if (ov.errors.length) problems.push(`ошибки mc (${ov.errors.length}): ${ov.errors.slice(0, 3).join('; ').slice(0, 200)}`);
    }

    if (problems.length === 0) return;
    const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
    const TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';
    if (!TG_TOKEN || !TG_CHAT) return;
    const now = new Date();
    if (this.lastAlertAt && (now.getTime() - this.lastAlertAt.getTime()) < this.alertCooldownH * 3600_000) return;
    try {
      await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        chat_id: TG_CHAT,
        parse_mode: 'HTML',
        text: `<b>⚠️ MinIO DR-зеркало (node-3): проблемы</b>\n` +
          problems.map((p) => `• ${p}`).join('\n') +
          `\n\nДеталь: <code>/admin/monitoring/tech/minio-dr</code>`,
      }, { timeout: 8000 });
      this.lastAlertAt = now;
      this.log.warn(`MinIO DR alert sent: ${problems.join(' | ')}`);
    } catch (e: any) {
      this.log.error(`Telegram alert failed: ${e?.message || 'unknown'}`);
    }
  }

  private empty(configured: boolean, error: string | null = null): MinioMirrorOverview {
    return {
      generatedAt: new Date().toISOString(),
      configured,
      statusPresent: false,
      lastRunAt: null,
      ageMin: null,
      durationSec: null,
      drEndpoint: null,
      buckets: [],
      totalSrcObjects: null,
      totalDstObjects: null,
      totalSrcBytes: null,
      totalDstBytes: null,
      errors: [],
      freshMin: this.freshMin,
      healthy: false,
      error,
    };
  }

  async getOverview(): Promise<MinioMirrorOverview> {
    if (!fs.existsSync(this.statusPath)) {
      // No status file → mirror not configured on this host (e.g. test server).
      return this.empty(false);
    }
    try {
      const raw = fs.readFileSync(this.statusPath, 'utf8');
      const parsed = JSON.parse(raw);

      const buckets: MinioBucketStatus[] = Array.isArray(parsed.buckets)
        ? parsed.buckets.map((b: any) => ({
            bucket: String(b.bucket),
            srcObjects: Number(b.srcObjects ?? 0),
            srcBytes: Number(b.srcBytes ?? 0),
            dstObjects: Number(b.dstObjects ?? 0),
            dstBytes: Number(b.dstBytes ?? 0),
            inSync: b.inSync === true,
          }))
        : [];
      const errors: string[] = Array.isArray(parsed.errors) ? parsed.errors.map((e: any) => String(e)) : [];

      const lastRunAt = parsed.lastRunAt ? String(parsed.lastRunAt) : null;
      const lastRunMs = lastRunAt ? Date.parse(lastRunAt) : NaN;
      const ageMin = Number.isFinite(lastRunMs)
        ? +(((Date.now() - lastRunMs) / 60000)).toFixed(1)
        : null;

      const totalSrcObjects = buckets.reduce((s, b) => s + b.srcObjects, 0);
      const totalDstObjects = buckets.reduce((s, b) => s + b.dstObjects, 0);
      const totalSrcBytes = buckets.reduce((s, b) => s + b.srcBytes, 0);
      const totalDstBytes = buckets.reduce((s, b) => s + b.dstBytes, 0);

      const fresh = ageMin != null && ageMin <= this.freshMin;
      const allInSync = buckets.length > 0 && buckets.every((b) => b.inSync);
      const healthy = fresh && allInSync && errors.length === 0;

      return {
        generatedAt: new Date().toISOString(),
        configured: true,
        statusPresent: true,
        lastRunAt,
        ageMin,
        durationSec: parsed.durationSec != null ? Number(parsed.durationSec) : null,
        drEndpoint: parsed.drEndpoint ? String(parsed.drEndpoint) : null,
        buckets,
        totalSrcObjects,
        totalDstObjects,
        totalSrcBytes,
        totalDstBytes,
        errors,
        freshMin: this.freshMin,
        healthy,
        error: null,
      };
    } catch (e: any) {
      this.log.warn(`minio mirror status read failed: ${e.message}`);
      return this.empty(true, e?.message || 'status read failed');
    }
  }
}
