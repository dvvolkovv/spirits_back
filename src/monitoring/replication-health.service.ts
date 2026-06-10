import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import axios from 'axios';
import { sendTelegramPayload } from '../common/telegram-alert';
import { Pool } from 'pg';
import { PgService } from '../common/services/pg.service';

/**
 * Replication health — surfaces PostgreSQL streaming replication state for the
 * DR setup: prod (212.113.106.202) is the publisher, node-3 (10.10.0.3 over
 * WireGuard) is a hot standby consuming WAL through slot `node3_dr`.
 *
 * Two vantage points:
 *
 *  1. Publisher side (prod's local Postgres, via PgService — the api conn
 *     already points there):
 *       - Connected standbys with state + per-client lag (write/flush/replay)
 *       - Replication slots — restart_lsn, wal_status, retention
 *
 *  2. Standby side (node-3, via a separate lazily-opened pool over WG):
 *       - pg_is_in_recovery — is it actually a standby?
 *       - wal receiver status, sender, slot
 *       - receive vs replay LSN → apply backlog (bytes of received-but-not-yet-
 *         applied WAL — meaningful regardless of write traffic)
 *       - last-xact replay age (reported but NOT used for health: on a
 *         low-write standby it grows during idle even though replication is
 *         perfectly healthy — the authoritative lag is the publisher-side
 *         replay_lag and the apply-backlog byte count)
 *
 * Standby probe is gated: it runs only when STANDBY_DATABASE_URL is set, or
 * REPLICATION_STANDBY_HOST is set (then the conn string is derived from
 * DATABASE_URL by swapping the host — same role/password, it's a physical
 * replica). Where neither is configured (e.g. the test server, which has no
 * standby) the standby block reports `configured: false` and does not drag
 * down overall health.
 *
 * Standby setup (Sprint 1 done 2026-06-01):
 *  - Standby Docker container `postgres-standby` on node-3, 10.10.0.3:5433
 *  - Slot name `node3_dr`, role `replicator`
 *  - WG tunnel 10.10.0.1 ↔ 10.10.0.3 as transport
 */

interface StandbyRow {
  pid: number;
  client_addr: string;
  application_name: string;
  state: string;            // streaming / catchup / backup / startup
  sync_state: string;       // async / sync / quorum / potential
  write_lag_sec: number | null;
  flush_lag_sec: number | null;
  replay_lag_sec: number | null;
  sent_lsn: string | null;
  replay_lsn: string | null;
  reply_time: string | null;
}

interface SlotRow {
  slot_name: string;
  slot_type: string;
  active: boolean;
  active_pid: number | null;
  wal_status: string;       // reserved / extended / unreserved / lost
  restart_lsn: string | null;
  safe_wal_size_bytes: number | null;
}

// The standby's own view of itself (queried directly on node-3).
export interface StandbyView {
  configured: boolean;       // is a standby endpoint configured at all?
  reachable: boolean;        // did the probe connect + query OK?
  inRecovery: boolean | null;
  replayPaused: boolean | null;
  receiveLsn: string | null;
  replayLsn: string | null;
  applyBacklogBytes: number | null;   // received - replayed; 0 == fully applied
  lastXactReplayAgeSec: number | null; // idle-sensitive — informational only
  receiver: {
    status: string | null;            // streaming / stopping / ...
    senderHost: string | null;
    senderPort: number | null;
    slotName: string | null;
    writtenLsn: string | null;
    flushedLsn: string | null;
    latestEndLsn: string | null;
    lastMsgReceiptTime: string | null;
    sinceLastMsgSec: number | null;
  } | null;
  healthy: boolean;          // in_recovery + receiver streaming + backlog ok + not paused
  error: string | null;
}

export interface ReplicationOverview {
  generatedAt: string;
  standbys: StandbyRow[];
  slots: SlotRow[];
  standby: StandbyView;     // node-3's self-reported state
  healthy: boolean;         // publisher healthy AND (standby unconfigured OR standby healthy)
  maxReplayLagSec: number | null;
  thresholdSec: number;
  error: string | null;
}

const LAG_THRESHOLD_SEC = Number(process.env.REPLICATION_LAG_THRESHOLD_SEC || 60);
// One 16MB WAL segment of received-but-unapplied WAL is the default "behind" alarm.
const APPLY_BACKLOG_THRESHOLD_BYTES = Number(
  process.env.REPLICATION_APPLY_BACKLOG_THRESHOLD_BYTES || 16 * 1024 * 1024,
);
const ALERT_COOLDOWN_HOURS = Number(process.env.REPLICATION_ALERT_COOLDOWN_H || 6);

@Injectable()
export class ReplicationHealthService implements OnModuleDestroy {
  private readonly log = new Logger(ReplicationHealthService.name);
  private standbyPool: Pool | null = null;
  private standbyPoolBroken = false;
  private lastAlertAt: Date | null = null;

  constructor(private readonly pg: PgService) {}

  // DR Sprint 4: hourly alert pass. The widget is pull-only (admin opens Инфра);
  // this pushes a Telegram heads-up when the publisher↔standby link degrades so
  // a stalled replica doesn't sit unnoticed until someone looks.
  @Cron(CronExpression.EVERY_HOUR)
  async hourly() {
    try {
      const ov = await this.getOverview();
      await this.maybeAlert(ov);
    } catch (e: any) {
      this.log.warn(`replication hourly alert pass failed: ${e.message}`);
    }
  }

  private async maybeAlert(ov: ReplicationOverview): Promise<void> {
    const problems: string[] = [];
    if (ov.error) {
      problems.push(`не удалось опросить publisher: ${ov.error}`);
    } else {
      if (ov.standbys.length === 0) problems.push('нет подключённых standby (репликация не идёт)');
      const notStreaming = ov.standbys.filter((s) => s.state !== 'streaming').map((s) => `${s.client_addr}:${s.state}`);
      if (notStreaming.length) problems.push(`standby не в streaming: ${notStreaming.join(', ')}`);
      if (ov.maxReplayLagSec != null && ov.maxReplayLagSec > ov.thresholdSec) {
        problems.push(`replay lag ${ov.maxReplayLagSec.toFixed(1)}с > порога ${ov.thresholdSec}с`);
      }
      const lostSlots = ov.slots.filter((s) => s.wal_status === 'lost').map((s) => s.slot_name);
      if (lostSlots.length) problems.push(`WAL-слоты потеряны: ${lostSlots.join(', ')}`);
    }
    // Standby self-view, only when configured.
    if (ov.standby.configured) {
      if (!ov.standby.reachable) problems.push(`standby (node-3) недоступен: ${ov.standby.error || 'unknown'}`);
      else if (!ov.standby.healthy) {
        if (ov.standby.replayPaused) problems.push('replay на standby приостановлен');
        if (ov.standby.receiver?.status !== 'streaming') problems.push(`wal receiver на standby: ${ov.standby.receiver?.status ?? 'нет'}`);
      }
    }

    if (problems.length === 0) return;
    const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
    const TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';
    if (!TG_TOKEN || !TG_CHAT) return;
    const now = new Date();
    if (this.lastAlertAt && (now.getTime() - this.lastAlertAt.getTime()) < ALERT_COOLDOWN_HOURS * 3600_000) return;
    try {
      await sendTelegramPayload({
        chat_id: TG_CHAT,
        parse_mode: 'HTML',
        text: `<b>⚠️ Репликация PostgreSQL: проблемы</b>\n` +
          problems.map((p) => `• ${p}`).join('\n') +
          `\n\nДеталь: <code>/admin/monitoring/tech/replication</code>`,
      }, { timeout: 8000 });
      this.lastAlertAt = now;
      this.log.warn(`Replication alert sent: ${problems.join(' | ')}`);
    } catch (e: any) {
      this.log.error(`Telegram alert failed: ${e?.message || 'unknown'}`);
    }
  }

  async onModuleDestroy() {
    if (this.standbyPool) {
      try { await this.standbyPool.end(); } catch { /* ignore */ }
      this.standbyPool = null;
    }
  }

  // Resolve the standby connection string, or null if standby probing is off.
  private standbyConnString(): string | null {
    const explicit = process.env.STANDBY_DATABASE_URL;
    if (explicit) return explicit;
    const host = process.env.REPLICATION_STANDBY_HOST;
    if (!host) return null;
    const base = process.env.DATABASE_URL;
    if (!base) return null;
    try {
      // Physical replica → same role/password/db as prod. Swap only the host
      // (and optionally the port) so the secret lives in one place.
      const url = new URL(base);
      url.hostname = host;
      const port = process.env.REPLICATION_STANDBY_PORT;
      if (port) url.port = port;
      return url.toString();
    } catch (e: any) {
      this.log.warn(`cannot derive standby conn string: ${e.message}`);
      return null;
    }
  }

  private getStandbyPool(): Pool | null {
    if (this.standbyPoolBroken) return null;
    if (this.standbyPool) return this.standbyPool;
    const conn = this.standbyConnString();
    if (!conn) return null;
    try {
      this.standbyPool = new Pool({
        connectionString: conn,
        max: 2,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 4000,
        // A standby probe must never hang the monitoring endpoint.
        statement_timeout: 4000,
        query_timeout: 4000,
        application_name: 'linkeon-replication-monitor',
      });
      this.standbyPool.on('error', (err) => {
        this.log.warn(`standby pool error: ${err.message}`);
      });
      return this.standbyPool;
    } catch (e: any) {
      this.log.warn(`cannot create standby pool: ${e.message}`);
      this.standbyPoolBroken = true;
      return null;
    }
  }

  private async getStandbyView(): Promise<StandbyView> {
    const empty: StandbyView = {
      configured: false,
      reachable: false,
      inRecovery: null,
      replayPaused: null,
      receiveLsn: null,
      replayLsn: null,
      applyBacklogBytes: null,
      lastXactReplayAgeSec: null,
      receiver: null,
      healthy: false,
      error: null,
    };

    const pool = this.getStandbyPool();
    if (!pool) return empty; // probing disabled → configured:false, not counted against health

    try {
      const [rec, wr] = await Promise.all([
        pool.query(
          `SELECT pg_is_in_recovery()                               AS in_recovery,
                  pg_is_wal_replay_paused()                         AS replay_paused,
                  pg_last_wal_receive_lsn()::text                   AS receive_lsn,
                  pg_last_wal_replay_lsn()::text                    AS replay_lsn,
                  pg_wal_lsn_diff(pg_last_wal_receive_lsn(),
                                  pg_last_wal_replay_lsn())::float8  AS apply_backlog_bytes,
                  EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))::float8
                                                                    AS last_xact_replay_age_sec`,
        ),
        pool.query(
          `SELECT status, sender_host, sender_port, slot_name,
                  written_lsn::text    AS written_lsn,
                  flushed_lsn::text    AS flushed_lsn,
                  latest_end_lsn::text AS latest_end_lsn,
                  last_msg_receipt_time,
                  EXTRACT(EPOCH FROM (now() - last_msg_receipt_time))::float8 AS since_last_msg_sec
             FROM pg_stat_wal_receiver`,
        ),
      ]);

      const r = rec.rows[0] || {};
      const w = wr.rows[0];
      const inRecovery = r.in_recovery === true || r.in_recovery === 't';
      const applyBacklogBytes = r.apply_backlog_bytes != null ? Number(r.apply_backlog_bytes) : null;
      const replayPaused = r.replay_paused === true || r.replay_paused === 't';

      const receiver = w
        ? {
            status: w.status ?? null,
            senderHost: w.sender_host ?? null,
            senderPort: w.sender_port != null ? Number(w.sender_port) : null,
            slotName: w.slot_name ?? null,
            writtenLsn: w.written_lsn ?? null,
            flushedLsn: w.flushed_lsn ?? null,
            latestEndLsn: w.latest_end_lsn ?? null,
            lastMsgReceiptTime: w.last_msg_receipt_time
              ? new Date(w.last_msg_receipt_time).toISOString()
              : null,
            sinceLastMsgSec: w.since_last_msg_sec != null ? Number(w.since_last_msg_sec) : null,
          }
        : null;

      // Healthy = it really is a standby, the receiver is streaming, replay
      // isn't paused, and it has applied (nearly) all the WAL it received.
      // Note: we deliberately do NOT use lastXactReplayAgeSec here — see the
      // class doc; it grows in idle and would false-alarm.
      const healthy =
        inRecovery &&
        receiver?.status === 'streaming' &&
        !replayPaused &&
        (applyBacklogBytes == null || applyBacklogBytes <= APPLY_BACKLOG_THRESHOLD_BYTES);

      return {
        configured: true,
        reachable: true,
        inRecovery,
        replayPaused,
        receiveLsn: r.receive_lsn ?? null,
        replayLsn: r.replay_lsn ?? null,
        applyBacklogBytes,
        lastXactReplayAgeSec: r.last_xact_replay_age_sec != null ? Number(r.last_xact_replay_age_sec) : null,
        receiver,
        healthy,
        error: null,
      };
    } catch (e: any) {
      this.log.warn(`standby probe failed: ${e.message}`);
      return { ...empty, configured: true, reachable: false, error: e?.message || 'standby probe failed' };
    }
  }

  async getOverview(): Promise<ReplicationOverview> {
    let publisherError: string | null = null;
    let standbys: StandbyRow[] = [];
    let slots: SlotRow[] = [];

    // Publisher side and standby side are independent — probe them together so
    // a slow standby connect doesn't serialize behind the prod queries.
    const standbyViewP = this.getStandbyView();

    try {
      const [sb, sl] = await Promise.all([
        this.pg.query(
          `SELECT pid, client_addr::text AS client_addr,
                  application_name,
                  state,
                  sync_state,
                  EXTRACT(EPOCH FROM write_lag)::float  AS write_lag_sec,
                  EXTRACT(EPOCH FROM flush_lag)::float  AS flush_lag_sec,
                  EXTRACT(EPOCH FROM replay_lag)::float AS replay_lag_sec,
                  sent_lsn::text AS sent_lsn,
                  replay_lsn::text AS replay_lsn,
                  reply_time
             FROM pg_stat_replication`,
        ),
        this.pg.query(
          `SELECT slot_name, slot_type, active, active_pid,
                  wal_status, restart_lsn::text AS restart_lsn,
                  safe_wal_size AS safe_wal_size_bytes
             FROM pg_replication_slots`,
        ),
      ]);
      standbys = sb.rows.map((r: any) => ({
        pid: Number(r.pid),
        client_addr: r.client_addr,
        application_name: r.application_name,
        state: r.state,
        sync_state: r.sync_state,
        write_lag_sec:  r.write_lag_sec  != null ? Number(r.write_lag_sec)  : null,
        flush_lag_sec:  r.flush_lag_sec  != null ? Number(r.flush_lag_sec)  : null,
        replay_lag_sec: r.replay_lag_sec != null ? Number(r.replay_lag_sec) : null,
        sent_lsn: r.sent_lsn,
        replay_lsn: r.replay_lsn,
        reply_time: r.reply_time ? new Date(r.reply_time).toISOString() : null,
      }));
      slots = sl.rows.map((r: any) => ({
        slot_name: r.slot_name,
        slot_type: r.slot_type,
        active: !!r.active,
        active_pid: r.active_pid != null ? Number(r.active_pid) : null,
        wal_status: r.wal_status,
        restart_lsn: r.restart_lsn,
        safe_wal_size_bytes: r.safe_wal_size_bytes != null ? Number(r.safe_wal_size_bytes) : null,
      }));
    } catch (e: any) {
      this.log.warn(`replication overview (publisher) failed: ${e.message}`);
      publisherError = e?.message || 'query failed';
    }

    const standby = await standbyViewP;

    const maxReplayLagSec = standbys.length === 0
      ? null
      : Math.max(...standbys.map((s) => s.replay_lag_sec ?? 0));

    const publisherHealthy = !publisherError
      && standbys.length > 0
      && standbys.every((s) => s.state === 'streaming')
      && (maxReplayLagSec == null || maxReplayLagSec <= LAG_THRESHOLD_SEC)
      && slots.every((s) => s.wal_status !== 'lost');

    // The standby only counts against health when it's actually configured.
    const standbyOk = !standby.configured || standby.healthy;

    return {
      generatedAt: new Date().toISOString(),
      standbys,
      slots,
      standby,
      healthy: publisherHealthy && standbyOk,
      maxReplayLagSec,
      thresholdSec: LAG_THRESHOLD_SEC,
      error: publisherError,
    };
  }
}
