import { Injectable, Logger } from '@nestjs/common';

const PROM_URL = process.env.PROMETHEUS_URL || 'http://10.10.0.3:9090';
const TIMEOUT_MS = 5000;

interface NodeOverview {
  instance: string;
  host: string;
  up: boolean;
  load1: number | null;
  cpuPct: number | null;
  memPct: number | null;
  diskPct: number | null;
  uptimeSec: number | null;
}

interface ProbeOverview {
  target: string;
  success: boolean;
  httpStatus: number | null;
  latencySec: number | null;
  tlsSecLeft: number | null;
}

export interface PostgresOverview {
  instance: string;
  up: boolean;
  dbSizeBytes: number | null;
  connections: number | null;
  tps: number | null;          // commits / sec, last 5m
  cacheHitRatio: number | null; // 0..1 — block hit / (hit + read)
  deadlocks: number | null;     // since stats reset
}

export interface RedisOverview {
  instance: string;
  up: boolean;
  memoryUsedBytes: number | null;
  connectedClients: number | null;
  opsPerSec: number | null;     // commands / sec, last 5m
  keyspaceHitRatio: number | null; // 0..1
  evictedKeys: number | null;   // since start
}

export interface MinioOverview {
  instance: string;
  up: boolean;
  buckets: number | null;
  objects: number | null;
  usedBytes: number | null;
  freeBytes: number | null;
  totalBytes: number | null;
}

export interface DatabasesOverview {
  postgres: PostgresOverview[];
  redis: RedisOverview[];
  minio: MinioOverview[];
  generatedAt: string;
}

@Injectable()
export class MonitoringService {
  private readonly log = new Logger(MonitoringService.name);

  private async query(promql: string): Promise<Array<{ metric: Record<string, string>; value: [number, string] }>> {
    const url = `${PROM_URL}/api/v1/query?query=${encodeURIComponent(promql)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`prom ${res.status} for ${promql}`);
    const json: any = await res.json();
    if (json?.status !== 'success') throw new Error(`prom non-success: ${json?.errorType || ''} ${json?.error || ''}`);
    return json.data.result;
  }

  async getNodeOverview(): Promise<NodeOverview[]> {
    const [up, load1, cpu, mem, disk, uptime] = await Promise.all([
      this.query('up{job="node"}'),
      this.query('node_load1'),
      this.query('100 * (1 - avg by (instance, host) (rate(node_cpu_seconds_total{mode="idle"}[5m])))'),
      this.query('(node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes) / node_memory_MemTotal_bytes * 100'),
      this.query('(node_filesystem_size_bytes{mountpoint="/"} - node_filesystem_avail_bytes{mountpoint="/"}) / node_filesystem_size_bytes{mountpoint="/"} * 100'),
      this.query('node_time_seconds - node_boot_time_seconds'),
    ]);

    const byInstance = new Map<string, NodeOverview>();
    const ensure = (m: Record<string, string>): NodeOverview => {
      const inst = m.instance;
      let row = byInstance.get(inst);
      if (!row) {
        row = { instance: inst, host: m.host || '', up: false, load1: null, cpuPct: null, memPct: null, diskPct: null, uptimeSec: null };
        byInstance.set(inst, row);
      }
      if (m.host && !row.host) row.host = m.host;
      return row;
    };
    for (const r of up) ensure(r.metric).up = parseFloat(r.value[1]) === 1;
    for (const r of load1) ensure(r.metric).load1 = parseFloat(r.value[1]);
    for (const r of cpu) ensure(r.metric).cpuPct = parseFloat(r.value[1]);
    for (const r of mem) ensure(r.metric).memPct = parseFloat(r.value[1]);
    for (const r of disk) ensure(r.metric).diskPct = parseFloat(r.value[1]);
    for (const r of uptime) ensure(r.metric).uptimeSec = parseFloat(r.value[1]);

    return Array.from(byInstance.values()).sort((a, b) => a.instance.localeCompare(b.instance));
  }

  async getDatabases(): Promise<DatabasesOverview> {
    const [
      pgUp, pgSize, pgConn, pgTps, pgHit, pgRead, pgDl,
      rUp, rMem, rClients, rOps, rHits, rMisses, rEvicted,
    ] = await Promise.all([
      this.query('pg_up'),
      this.query('pg_database_size_bytes{datname="linkeon"}'),
      this.query('sum by (instance) (pg_stat_database_numbackends{datname="linkeon"})'),
      this.query('sum by (instance) (rate(pg_stat_database_xact_commit{datname="linkeon"}[5m]))'),
      this.query('sum by (instance) (rate(pg_stat_database_blks_hit{datname="linkeon"}[5m]))'),
      this.query('sum by (instance) (rate(pg_stat_database_blks_read{datname="linkeon"}[5m]))'),
      this.query('sum by (instance) (pg_stat_database_deadlocks{datname="linkeon"})'),
      this.query('redis_up'),
      this.query('redis_memory_used_bytes'),
      this.query('redis_connected_clients'),
      this.query('rate(redis_commands_processed_total[5m])'),
      this.query('redis_keyspace_hits_total'),
      this.query('redis_keyspace_misses_total'),
      this.query('redis_evicted_keys_total'),
    ]);

    const idx = (rows: any[]): Map<string, number> => {
      const m = new Map<string, number>();
      for (const r of rows) m.set(r.metric.instance, parseFloat(r.value[1]));
      return m;
    };
    const pUp = idx(pgUp), pSize = idx(pgSize), pConn = idx(pgConn), pTps = idx(pgTps),
          pHit = idx(pgHit), pRead = idx(pgRead), pDl = idx(pgDl);
    const rUpM = idx(rUp), rMemM = idx(rMem), rClM = idx(rClients), rOpsM = idx(rOps),
          rHM = idx(rHits), rMM = idx(rMisses), rEvM = idx(rEvicted);

    const pgInstances = Array.from(new Set(pgUp.map((r) => r.metric.instance)));
    const rInstances  = Array.from(new Set(rUp.map((r) => r.metric.instance)));

    const postgres: PostgresOverview[] = pgInstances.sort().map((i) => {
      const hit = pHit.get(i) ?? null;
      const read = pRead.get(i) ?? null;
      const cacheHit = hit !== null && read !== null && hit + read > 0 ? hit / (hit + read) : null;
      return {
        instance: i,
        up: pUp.get(i) === 1,
        dbSizeBytes: pSize.get(i) ?? null,
        connections: pConn.get(i) ?? null,
        tps: pTps.get(i) ?? null,
        cacheHitRatio: cacheHit,
        deadlocks: pDl.get(i) ?? null,
      };
    });

    const redis: RedisOverview[] = rInstances.sort().map((i) => {
      const hits = rHM.get(i) ?? null;
      const misses = rMM.get(i) ?? null;
      const ratio = hits !== null && misses !== null && hits + misses > 0 ? hits / (hits + misses) : null;
      return {
        instance: i,
        up: rUpM.get(i) === 1,
        memoryUsedBytes: rMemM.get(i) ?? null,
        connectedClients: rClM.get(i) ?? null,
        opsPerSec: rOpsM.get(i) ?? null,
        keyspaceHitRatio: ratio,
        evictedKeys: rEvM.get(i) ?? null,
      };
    });

    // MinIO — native /minio/v2/metrics/cluster endpoint
    const [mUp, mBuckets, mObjects, mUsed, mFree, mTotal] = await Promise.all([
      this.query('up{job="minio"}'),
      this.query('minio_cluster_bucket_total'),
      this.query('minio_cluster_usage_object_total'),
      this.query('minio_cluster_usage_total_bytes'),
      this.query('minio_cluster_capacity_usable_free_bytes'),
      this.query('minio_cluster_capacity_usable_total_bytes'),
    ]);
    const idxMinio = (rows: any[]): Map<string, number> => {
      const m = new Map<string, number>();
      for (const r of rows) m.set(r.metric.instance, parseFloat(r.value[1]));
      return m;
    };
    const mU = idxMinio(mUp), mB = idxMinio(mBuckets), mO = idxMinio(mObjects),
          mUs = idxMinio(mUsed), mF = idxMinio(mFree), mT = idxMinio(mTotal);
    const mInstances = Array.from(new Set(mUp.map((r) => r.metric.instance)));
    const minio: MinioOverview[] = mInstances.sort().map((i) => ({
      instance: i,
      up: mU.get(i) === 1,
      buckets: mB.get(i) ?? null,
      objects: mO.get(i) ?? null,
      usedBytes: mUs.get(i) ?? null,
      freeBytes: mF.get(i) ?? null,
      totalBytes: mT.get(i) ?? null,
    }));

    return { postgres, redis, minio, generatedAt: new Date().toISOString() };
  }

  async getProbes(): Promise<ProbeOverview[]> {
    const [success, status, latency, tlsExp] = await Promise.all([
      this.query('probe_success'),
      this.query('probe_http_status_code'),
      this.query('probe_duration_seconds'),
      this.query('probe_ssl_earliest_cert_expiry - time()'),
    ]);

    const byTarget = new Map<string, ProbeOverview>();
    const ensure = (m: Record<string, string>): ProbeOverview => {
      const tgt = m.instance;
      let row = byTarget.get(tgt);
      if (!row) {
        row = { target: tgt, success: false, httpStatus: null, latencySec: null, tlsSecLeft: null };
        byTarget.set(tgt, row);
      }
      return row;
    };
    for (const r of success) ensure(r.metric).success = parseFloat(r.value[1]) === 1;
    for (const r of status) ensure(r.metric).httpStatus = parseInt(r.value[1], 10);
    for (const r of latency) ensure(r.metric).latencySec = parseFloat(r.value[1]);
    for (const r of tlsExp) ensure(r.metric).tlsSecLeft = parseFloat(r.value[1]);

    return Array.from(byTarget.values()).sort((a, b) => a.target.localeCompare(b.target));
  }
}
