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
