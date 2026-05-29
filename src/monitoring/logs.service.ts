import { Injectable, Logger } from '@nestjs/common';

const LOKI_URL = process.env.LOKI_URL || 'http://10.10.0.3:3100';
const TIMEOUT_MS = 8000;

export interface LogLine {
  ts: number;            // unix epoch ms
  stream: Record<string, string>;
  line: string;
}

export interface LogsResponse {
  query: string;
  from: string;
  to: string;
  lines: LogLine[];
  generatedAt: string;
}

@Injectable()
export class LogsService {
  private readonly log = new Logger(LogsService.name);

  async listLabelValues(label: string): Promise<string[]> {
    try {
      const r = await fetch(`${LOKI_URL}/loki/api/v1/label/${encodeURIComponent(label)}/values`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!r.ok) throw new Error(`loki ${r.status}`);
      const json: any = await r.json();
      return Array.isArray(json?.data) ? json.data : [];
    } catch (e: any) {
      this.log.error(`label values failed (${label}): ${e.message}`);
      return [];
    }
  }

  async query(opts: { query: string; from: string; to: string; limit: number }): Promise<LogsResponse> {
    const params = new URLSearchParams({
      query: opts.query,
      start: opts.from,
      end: opts.to,
      limit: String(opts.limit),
      direction: 'backward',
    });
    const url = `${LOKI_URL}/loki/api/v1/query_range?${params.toString()}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error(`loki ${r.status}: ${body.slice(0, 200)}`);
    }
    const json: any = await r.json();
    const results: Array<{ stream: Record<string, string>; values: Array<[string, string]> }> =
      json?.data?.result || [];

    // Merge all streams, sort newest first.
    const lines: LogLine[] = [];
    for (const r of results) {
      for (const [tsNs, line] of r.values) {
        lines.push({ ts: Number(tsNs) / 1e6, stream: r.stream, line });
      }
    }
    lines.sort((a, b) => b.ts - a.ts);

    return {
      query: opts.query,
      from: opts.from,
      to: opts.to,
      lines: lines.slice(0, opts.limit),
      generatedAt: new Date().toISOString(),
    };
  }
}
