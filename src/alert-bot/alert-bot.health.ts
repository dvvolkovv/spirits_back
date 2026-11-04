import { Injectable } from '@nestjs/common';
import { MonitoringService } from '../monitoring/monitoring.service';
import { SyntheticService } from '../monitoring/synthetic.service';
import { SmsHealthService } from '../monitoring/sms-health.service';
import { NanoBananaHealthService } from '../monitoring/nanobanana-health.service';
import { TgHealthService } from '../monitoring/tg-health.service';
import { PaymentsHealthService } from '../monitoring/payments-health.service';
import { QualityMonitorService } from '../monitoring/quality-monitor.service';
import { ClaudeHealthService } from '../monitoring/claude-health.service';
import { GeoAvailabilityService } from '../monitoring/geo-availability.service';
import { BackupHealthService } from '../monitoring/backup-health.service';
import { ModelsRegistryService } from '../monitoring/models-registry.service';
import { JobsMonitorService } from '../monitoring/jobs-monitor.service';
import { ReplicationHealthService } from '../monitoring/replication-health.service';
import { NeoSnapshotHealthService } from '../monitoring/neo-snapshot-health.service';
import { MinioMirrorHealthService } from '../monitoring/minio-mirror-health.service';

export const HEALTH_SECTIONS = [
  'overview', 'databases', 'sms', 'nanobanana', 'tg-bot', 'payments', 'quality', 'claude',
  'geo', 'backups', 'models', 'jobs', 'replication', 'neo4j-dr', 'minio-dr', 'synthetic',
] as const;
export type HealthSection = typeof HEALTH_SECTIONS[number];

const STATUS_KEYS = new Set(['status', 'state', 'health', 'llmStatus']);
const BAD_STATUSES = new Set([
  'down', 'bad', 'unhealthy', 'failed', 'error', 'critical', 'degraded', 'warn', 'stale',
]);

function hasBadStatus(value: unknown, depth = 0, seen = new WeakSet<object>()): boolean {
  if (depth > 6 || value === null || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);

  if (Array.isArray(value)) {
    return value.some((item) => hasBadStatus(item, depth + 1, seen));
  }

  for (const [key, nested] of Object.entries(value)) {
    if (STATUS_KEYS.has(key) && typeof nested === 'string'
      && BAD_STATUSES.has(nested.trim().toLowerCase())) return true;
    if (hasBadStatus(nested, depth + 1, seen)) return true;
  }
  return false;
}

@Injectable()
export class AlertBotHealthService {
  constructor(
    private readonly monitoring: MonitoringService,
    private readonly synthetic: SyntheticService,
    private readonly sms: SmsHealthService,
    private readonly nano: NanoBananaHealthService,
    private readonly tg: TgHealthService,
    private readonly payments: PaymentsHealthService,
    private readonly quality: QualityMonitorService,
    private readonly claude: ClaudeHealthService,
    private readonly geo: GeoAvailabilityService,
    private readonly backups: BackupHealthService,
    private readonly models: ModelsRegistryService,
    private readonly jobs: JobsMonitorService,
    private readonly replication: ReplicationHealthService,
    private readonly neo: NeoSnapshotHealthService,
    private readonly minio: MinioMirrorHealthService,
  ) {}

  async getSection(section: HealthSection): Promise<unknown> {
    try {
      switch (section) {
        case 'overview': {
          const [nodes, probes] = await Promise.all([this.monitoring.getNodeOverview(), this.monitoring.getProbes()]);
          return { nodes, probes, generatedAt: new Date().toISOString() };
        }
        case 'databases': return await this.monitoring.getDatabases();
        case 'sms': return await this.sms.getOverview();
        case 'nanobanana': return await this.nano.getOverview();
        case 'tg-bot': return await this.tg.getOverview();
        case 'payments': return await this.payments.getOverview();
        case 'quality': return await this.quality.getOverview();
        case 'claude': return await this.claude.getOverview();
        case 'geo': return await this.geo.getLatest();
        case 'backups': return await this.backups.getOverview();
        case 'models': return await this.models.getOverview();
        case 'jobs': return await this.jobs.getOverview();
        case 'replication': return await this.replication.getOverview();
        case 'neo4j-dr': return await this.neo.getOverview();
        case 'minio-dr': return await this.minio.getOverview();
        case 'synthetic': return await this.synthetic.getOverview();
      }
    } catch {
      return { error: 'source_failed' };
    }
  }

  async badSections(): Promise<string[]> {
    const pairs = await Promise.all(HEALTH_SECTIONS.map(async (s) => [s, await this.getSection(s)] as const));
    return pairs.filter(([, value]) => hasBadStatus(value)).map(([name]) => name);
  }
}
