import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';

/**
 * Replication health — surfaces PostgreSQL streaming replication state on
 * prod (the publisher side; the standby on node-3 is a passive consumer).
 *
 * Three signals:
 *  - Connected standbys with state + per-client lag (write/flush/replay)
 *  - Replication slots — restart_lsn, wal_status, retention (or lack of)
 *  - Health summary: at least one streaming standby with replay lag below
 *    threshold? Anything stale?
 *
 * Read from prod's local Postgres via PgService (the api server's PG conn
 * already points at prod). No standby-side metrics yet — those would
 * require either an SSH probe or a Prometheus pg_exporter on node-3.
 *
 * Standby setup (Sprint 1 done 2026-06-01):
 *  - Standby Docker container `postgres-standby` on node-3 (10.10.0.3)
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

export interface ReplicationOverview {
  generatedAt: string;
  standbys: StandbyRow[];
  slots: SlotRow[];
  healthy: boolean;         // at least one streaming standby + max replay_lag below threshold
  maxReplayLagSec: number | null;
  thresholdSec: number;
  error: string | null;
}

const LAG_THRESHOLD_SEC = Number(process.env.REPLICATION_LAG_THRESHOLD_SEC || 60);

@Injectable()
export class ReplicationHealthService {
  private readonly log = new Logger(ReplicationHealthService.name);

  constructor(private readonly pg: PgService) {}

  async getOverview(): Promise<ReplicationOverview> {
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
      const standbys: StandbyRow[] = sb.rows.map((r: any) => ({
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
      const slots: SlotRow[] = sl.rows.map((r: any) => ({
        slot_name: r.slot_name,
        slot_type: r.slot_type,
        active: !!r.active,
        active_pid: r.active_pid != null ? Number(r.active_pid) : null,
        wal_status: r.wal_status,
        restart_lsn: r.restart_lsn,
        safe_wal_size_bytes: r.safe_wal_size_bytes != null ? Number(r.safe_wal_size_bytes) : null,
      }));
      const maxReplayLagSec = standbys.length === 0
        ? null
        : Math.max(...standbys.map((s) => s.replay_lag_sec ?? 0));
      const healthy = standbys.length > 0
        && standbys.every((s) => s.state === 'streaming')
        && (maxReplayLagSec == null || maxReplayLagSec <= LAG_THRESHOLD_SEC)
        && slots.every((s) => s.wal_status !== 'lost');
      return {
        generatedAt: new Date().toISOString(),
        standbys,
        slots,
        healthy,
        maxReplayLagSec,
        thresholdSec: LAG_THRESHOLD_SEC,
        error: null,
      };
    } catch (e: any) {
      this.log.warn(`replication overview failed: ${e.message}`);
      return {
        generatedAt: new Date().toISOString(),
        standbys: [],
        slots: [],
        healthy: false,
        maxReplayLagSec: null,
        thresholdSec: LAG_THRESHOLD_SEC,
        error: e?.message || 'query failed',
      };
    }
  }
}
