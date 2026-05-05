import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import * as jwt from 'jsonwebtoken';
import axios from 'axios';
import { PgService } from '../common/services/pg.service';
import { Neo4jService } from '../neo4j/neo4j.service';
import { TelegramNotifierService } from './telegram-notifier.service';

type Status = 'healthy' | 'degraded' | 'down' | 'unknown';

interface ProbeResult {
  service: string;
  status: Status;
  latencyMs: number | null;
  lastError: string | null;
  details?: any;
}

@Injectable()
export class HealthProbeService implements OnModuleInit {
  private readonly logger = new Logger(HealthProbeService.name);

  constructor(
    private readonly pg: PgService,
    @Optional() private readonly neo4j?: Neo4jService,
    @Optional() private readonly telegram?: TelegramNotifierService,
  ) {}

  async onModuleInit() {
    // Run once on boot so the table is populated immediately.
    setTimeout(() => this.runAll().catch(() => {}), 3000);
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async runAll(): Promise<void> {
    const probes = await Promise.all([
      this.probePostgres(),
      this.probeNeo4j(),
      this.probeAnthropic(),
      this.probeOpenRouter(),
      this.probeKling(),
    ]);
    await Promise.all(probes.map((p) => this.persist(p)));
  }

  private async persist(p: ProbeResult): Promise<void> {
    try {
      // Capture previous status to detect transitions.
      const prev = await this.pg.query(
        `SELECT status FROM service_health WHERE service = $1`, [p.service],
      );
      const prevStatus: Status | null = prev.rows[0]?.status ?? null;

      await this.pg.query(
        `INSERT INTO service_health (service, status, latency_ms, last_check_at, last_error, details)
         VALUES ($1, $2, $3, now(), $4, $5::jsonb)
         ON CONFLICT (service) DO UPDATE
         SET status = EXCLUDED.status,
             latency_ms = EXCLUDED.latency_ms,
             last_check_at = EXCLUDED.last_check_at,
             last_error = EXCLUDED.last_error,
             details = EXCLUDED.details`,
        [p.service, p.status, p.latencyMs, p.lastError, p.details ? JSON.stringify(p.details) : null],
      );

      // Transition logging + Telegram alert on degradations/recoveries.
      if (prevStatus && prevStatus !== p.status) {
        this.logger.warn(
          `health: ${p.service} ${prevStatus} → ${p.status}${p.lastError ? ` (${p.lastError})` : ''}`,
        );
        // Alert only on meaningful transitions to avoid noise:
        //   * degrading from healthy → degraded/down
        //   * recovering from degraded/down → healthy
        const meaningful =
          (prevStatus === 'healthy' && (p.status === 'degraded' || p.status === 'down')) ||
          ((prevStatus === 'degraded' || prevStatus === 'down') && p.status === 'healthy');
        if (meaningful && this.telegram) {
          this.telegram.notifyHealthAlert({
            service: p.service,
            prevStatus,
            newStatus: p.status,
            latencyMs: p.latencyMs,
            lastError: p.lastError,
          }).catch(() => {});
        }
      }
    } catch (e: any) {
      this.logger.error(`persist ${p.service} failed: ${e.message}`);
    }
  }

  // -------------------- Individual probes --------------------

  private async probePostgres(): Promise<ProbeResult> {
    const t0 = Date.now();
    try {
      await this.pg.query('SELECT 1');
      return { service: 'postgres', status: 'healthy', latencyMs: Date.now() - t0, lastError: null };
    } catch (e: any) {
      return { service: 'postgres', status: 'down', latencyMs: null, lastError: e.message };
    }
  }

  private async probeNeo4j(): Promise<ProbeResult> {
    if (!this.neo4j) {
      return { service: 'neo4j', status: 'unknown', latencyMs: null, lastError: 'service not available' };
    }
    const t0 = Date.now();
    try {
      // Use existing public method with a bogus id — session open/close alone is enough.
      await this.neo4j.getProfileEntities('__healthprobe__');
      return { service: 'neo4j', status: 'healthy', latencyMs: Date.now() - t0, lastError: null };
    } catch (e: any) {
      return { service: 'neo4j', status: 'down', latencyMs: null, lastError: e.message };
    }
  }

  private async probeAnthropic(): Promise<ProbeResult> {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) {
      return { service: 'anthropic', status: 'unknown', latencyMs: null, lastError: 'no API key' };
    }
    const t0 = Date.now();
    try {
      const res = await axios.get('https://api.anthropic.com/v1/models?limit=1', {
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        timeout: 6000,
      });
      const ok = res.status >= 200 && res.status < 300;
      const lat = Date.now() - t0;
      return {
        service: 'anthropic',
        status: ok ? (lat > 3000 ? 'degraded' : 'healthy') : 'degraded',
        latencyMs: lat,
        lastError: ok ? null : `status ${res.status}`,
      };
    } catch (e: any) {
      return { service: 'anthropic', status: 'down', latencyMs: null, lastError: e.message };
    }
  }

  private async probeOpenRouter(): Promise<ProbeResult> {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) {
      return { service: 'openrouter', status: 'unknown', latencyMs: null, lastError: 'no API key' };
    }
    const t0 = Date.now();
    try {
      const res = await axios.get('https://openrouter.ai/api/v1/auth/key', {
        headers: { Authorization: `Bearer ${key}` },
        timeout: 6000,
      });
      const ok = res.status >= 200 && res.status < 300;
      const lat = Date.now() - t0;
      return {
        service: 'openrouter',
        status: ok ? (lat > 3000 ? 'degraded' : 'healthy') : 'degraded',
        latencyMs: lat,
        lastError: ok ? null : `status ${res.status}`,
        details: ok ? { credits_left: res.data?.data?.limit_remaining } : undefined,
      };
    } catch (e: any) {
      return { service: 'openrouter', status: 'down', latencyMs: null, lastError: e.message };
    }
  }

  private async probeKling(): Promise<ProbeResult> {
    const ak = process.env.KLING_ACCESS_KEY;
    const sk = process.env.KLING_SECRET_KEY;
    if (!ak || !sk) {
      return { service: 'kling', status: 'unknown', latencyMs: null, lastError: 'no Kling credentials' };
    }
    const t0 = Date.now();
    try {
      const now = Math.floor(Date.now() / 1000);
      const token = jwt.sign(
        { iss: ak, exp: now + 1800, nbf: now - 5 },
        sk,
        { algorithm: 'HS256', header: { alg: 'HS256', typ: 'JWT' } as any },
      );
      // List tasks endpoint — cheap and returns 200 with auth
      const res = await axios.get('https://api.klingai.com/v1/videos/text2video?pageNum=1&pageSize=1', {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 8000,
      });
      const ok = res.status >= 200 && res.status < 300;
      const lat = Date.now() - t0;
      return {
        service: 'kling',
        status: ok ? (lat > 5000 ? 'degraded' : 'healthy') : 'degraded',
        latencyMs: lat,
        lastError: ok ? null : `status ${res.status}`,
      };
    } catch (e: any) {
      const lat = Date.now() - t0;
      // Kling auth errors → still counts as reachable
      const status = axios.isAxiosError(e) && e.response?.status === 401 ? 'degraded' : 'down';
      return { service: 'kling', status, latencyMs: lat, lastError: e.message };
    }
  }
}
