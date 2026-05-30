import { Injectable, Logger, Optional } from '@nestjs/common';
import { Neo4jService } from '../../neo4j/neo4j.service';

/**
 * Profile depth — see monitoring.functions.md §3.3.
 *
 * Profile Depth Score uses the weights laid out in the doc:
 *   Value × 3, Intent × 3, Belief × 2, Desire × 2, Skill × 2, Interest × 1.
 * Computed both as a per-user distribution (avg/p50/p95) and as the
 * total entity count per type.
 */

const ENTITY_WEIGHTS: Record<string, number> = {
  Value: 3,
  Intent: 3,
  Belief: 2,
  Desire: 2,
  Skill: 2,
  Interest: 1,
};

export interface EntityCount {
  label: string;
  count: number;
  weight: number;
}

export interface ProfileDepthRow {
  profiles: number;
  avgPds: number | null;
  p50Pds: number | null;
  p95Pds: number | null;
}

export interface ProfileDepthOverview {
  generatedAt: string;
  entityCounts: EntityCount[];
  totalEntities: number;
  totalPds: number;
  perUser: ProfileDepthRow;
  // Last 8 ISO week buckets — when profiles were created.
  weeklyGrowth: Array<{ week: string; newProfiles: number }>;
}

@Injectable()
export class ProfileDepthService {
  private readonly log = new Logger(ProfileDepthService.name);

  constructor(@Optional() private readonly neo4j?: Neo4jService) {}

  private toInt(v: any): number {
    if (v === null || v === undefined) return 0;
    if (typeof v === 'number') return v;
    if (typeof v?.toNumber === 'function') return v.toNumber();
    return Number(v) || 0;
  }

  async getOverview(): Promise<ProfileDepthOverview> {
    if (!this.neo4j) {
      return {
        generatedAt: new Date().toISOString(),
        entityCounts: [],
        totalEntities: 0,
        totalPds: 0,
        perUser: { profiles: 0, avgPds: null, p50Pds: null, p95Pds: null },
        weeklyGrowth: [],
      };
    }

    // Entity counts per label across all profiles
    const counts = await this.neo4j.readRows(
      `MATCH (n)
       WHERE labels(n)[0] IN ['Value','Belief','Desire','Intent','Interest','Skill']
       RETURN labels(n)[0] AS label, count(*) AS cnt`,
    ).catch((e) => { this.log.error(`entity counts failed: ${e.message}`); return []; });

    const entityCounts: EntityCount[] = counts.map((r) => {
      const cnt = this.toInt(r.cnt);
      return { label: r.label, count: cnt, weight: ENTITY_WEIGHTS[r.label] ?? 1 };
    }).sort((a, b) => b.count - a.count);

    const totalEntities = entityCounts.reduce((s, e) => s + e.count, 0);
    const totalPds = entityCounts.reduce((s, e) => s + e.count * e.weight, 0);

    // Per-user PDS via per-profile aggregation
    const perUserRows = await this.neo4j.readRows(
      `MATCH (p:Profile)
       OPTIONAL MATCH (p)-[]-(e)
       WHERE labels(e)[0] IN ['Value','Belief','Desire','Intent','Interest','Skill']
       WITH p, labels(e)[0] AS label, count(e) AS c
       WITH p,
            sum(CASE label WHEN 'Value' THEN c*3 WHEN 'Intent' THEN c*3
                           WHEN 'Belief' THEN c*2 WHEN 'Desire' THEN c*2 WHEN 'Skill' THEN c*2
                           WHEN 'Interest' THEN c*1 ELSE 0 END) AS pds
       RETURN pds`,
    ).catch(() => []);

    const scores = perUserRows.map((r) => this.toInt(r.pds)).sort((a, b) => a - b);
    const profiles = scores.length;
    const avgPds = profiles > 0 ? scores.reduce((s, v) => s + v, 0) / profiles : null;
    const pctIdx = (q: number): number => Math.min(scores.length - 1, Math.floor(q * scores.length));
    const p50Pds = profiles > 0 ? scores[pctIdx(0.5)] : null;
    const p95Pds = profiles > 0 ? scores[pctIdx(0.95)] : null;

    // Weekly growth — Profile nodes don't necessarily have created_at, so we
    // try a few common properties and bucket whatever we get.
    const weekly = await this.neo4j.readRows(
      `MATCH (p:Profile)
       WITH p,
            coalesce(p.created_at, p.createdAt, p.firstSeen, p.first_seen) AS ts
       WHERE ts IS NOT NULL AND ts >= datetime() - duration({weeks: 8})
       WITH date.truncate('week', date(ts)) AS week, count(*) AS n
       RETURN toString(week) AS week, n
       ORDER BY week`,
    ).catch(() => []);

    return {
      generatedAt: new Date().toISOString(),
      entityCounts,
      totalEntities,
      totalPds,
      perUser: {
        profiles,
        avgPds: avgPds !== null ? Math.round(avgPds) : null,
        p50Pds,
        p95Pds,
      },
      weeklyGrowth: weekly.map((r) => ({ week: String(r.week), newProfiles: this.toInt(r.n) })),
    };
  }
}
