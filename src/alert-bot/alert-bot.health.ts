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
import { abortReason } from '../common/abort';

export const HEALTH_SECTIONS = [
  'overview', 'databases', 'sms', 'nanobanana', 'tg-bot', 'payments', 'quality', 'claude',
  'geo', 'backups', 'models', 'jobs', 'replication', 'neo4j-dr', 'minio-dr', 'synthetic',
] as const;
export type HealthSection = typeof HEALTH_SECTIONS[number];

export const HEALTH_SOURCE_TIMEOUT_MS = 2000;

/** Ограничивает источник linked AbortController: срабатывает более ранний внешний abort или timeout. */
export function withDeadline<T>(
  start: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      const error = abortReason(signal!);
      controller.abort(error);
      cleanup();
      reject(error);
    };
    const timer = setTimeout(() => {
      const error = new Error('source_timeout');
      controller.abort(error);
      cleanup();
      reject(error);
    }, timeoutMs);
    timer.unref();
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    let operation: Promise<T>;
    try {
      operation = start(controller.signal);
    } catch (error) {
      cleanup();
      reject(error);
      return;
    }
    operation.then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); },
    );
  });
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyRowsUp(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0
    && value.every((row) => isRecord(row) && row.up === true);
}

function queueNotStuck(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return value.stuck === false || value.stuck === 0;
}

/** Необязательный не настроенный источник — не инцидент, unknown/source_failed — не healthy. */
function isSectionHealthy(section: HealthSection, value: unknown): boolean {
  if (!isRecord(value) || value.error === 'source_failed') {
    // geo законно возвращает null, если проверки ещё не было: это unknown, а не «всё хорошо».
    if (section === 'sms' && isRecord(value)
      && value.balance?.error === 'SMSAERO_LOGIN/API_KEY not set') return true;
    return false;
  }

  // Эти источники необязательны; их собственные getOverview явно помечают configured:false.
  if (value.configured === false
    && ['nanobanana', 'neo4j-dr', 'minio-dr'].includes(section)) return true;

  switch (section) {
    case 'overview':
      return nonEmptyRowsUp(value.nodes)
        && Array.isArray(value.probes) && value.probes.length > 0
        && value.probes.every((row: any) => isRecord(row) && row.success === true);
    case 'databases':
      return ['postgres', 'redis', 'minio', 'nginx']
        .every((key) => nonEmptyRowsUp(value[key]))
        && nonEmptyRowsUp(value.neo4j)
        && value.neo4j.every((row: any) => row.error === null);
    case 'sms':
      if (value.balance?.error === 'SMSAERO_LOGIN/API_KEY not set') return true;
      return isRecord(value.balance) && value.balance.error === null
        && typeof value.balance.rub === 'number' && Number.isFinite(value.balance.rub)
        && typeof value.alertThresholdRub === 'number'
        && value.balance.rub > value.alertThresholdRub;
    case 'nanobanana':
      return value.configured === true && value.healthy === true;
    case 'tg-bot':
      return (value.configured === false
          || (value.configured === true && value.webhook?.healthy === true))
        && value.unanswered?.stuckChats === 0
        && value.unanswered?.error === null;
    case 'payments': {
      const shopKnown = value.shop?.configured === false
        || (value.shop?.configured === true && value.shop?.healthy === true);
      return shopKnown
        && typeof value.attempts?.failStreak === 'number'
        && typeof value.attempts?.threshold === 'number'
        && value.attempts.failStreak < value.attempts.threshold
        && value.attempts.error === null
        && isRecord(value.funnel) && value.funnel.healthy !== false
        && value.funnel.error === null;
    }
    case 'quality':
      return Array.isArray(value.alerts) && value.alerts.length === 0;
    case 'claude': {
      const apiKeyOk = value.configured?.apiKey === true
        ? value.usage?.apiKeyValid === true
        : value.configured?.apiKey === false && value.usage?.apiKeyValid !== false;
      return value.usage?.llmStatus === 'ok' && apiKeyOk;
    }
    case 'geo':
      return value.region_down === false && value.stale === false && value.error === null;
    case 'backups':
      return value.error === null && value.latest?.healthy === true;
    case 'models':
      return Array.isArray(value.unexpected) && value.unexpected.length === 0;
    case 'jobs':
      return queueNotStuck(value.video) && queueNotStuck(value.tokens)
        && Array.isArray(value.vpm_recent)
        && value.vpm_recent.every((run: any) => isRecord(run) && run.ok === true);
    case 'replication':
      return value.healthy === true && value.error === null;
    case 'neo4j-dr':
      return value.configured === true && value.healthy === true;
    case 'minio-dr':
      return value.configured === true && value.statusPresent === true
        && value.healthy === true && Array.isArray(value.errors) && value.errors.length === 0;
    case 'synthetic':
      return value.stale === false
        && Array.isArray(value.scenarios) && value.scenarios.length > 0
        && value.scenarios.every((scenario: any) => isRecord(scenario) && scenario.latestSuccess === true);
    default:
      return false;
  }
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

  async getSection(section: HealthSection, signal?: AbortSignal): Promise<unknown> {
    try {
      return await withDeadline((deadlineSignal) => this.readSection(section, deadlineSignal), HEALTH_SOURCE_TIMEOUT_MS, signal);
    } catch {
      return { error: 'source_failed' };
    }
  }

  private async readSection(section: HealthSection, signal?: AbortSignal): Promise<unknown> {
    switch (section) {
      case 'overview': {
        const [nodes, probes] = await Promise.all([this.monitoring.getNodeOverview(signal), this.monitoring.getProbes(signal)]);
        return { nodes, probes, generatedAt: new Date().toISOString() };
      }
      case 'databases': return await this.monitoring.getDatabases(signal);
      case 'sms': return await this.sms.getOverview(signal);
      case 'nanobanana': return await this.nano.getOverview(signal);
      case 'tg-bot': return await this.tg.getOverview(signal);
      case 'payments': return await this.payments.getOverview(signal);
      case 'quality': return await this.quality.getOverview(signal);
      case 'claude': return await this.claude.getOverview(signal);
      case 'geo': return await this.geo.getLatest(signal);
      case 'backups': return await this.backups.getOverview(signal);
      case 'models': return await this.models.getOverview(signal);
      case 'jobs': return await this.jobs.getOverview(signal);
      case 'replication': return await this.replication.getOverview(signal);
      case 'neo4j-dr': return await this.neo.getOverview(signal);
      case 'minio-dr': return await this.minio.getOverview(signal);
      case 'synthetic': return await this.synthetic.getOverview(signal);
    }
  }

  async badSections(signal?: AbortSignal): Promise<string[]> {
    const pairs = await Promise.all(HEALTH_SECTIONS.map(async (s) => [s, await this.getSection(s, signal)] as const));
    return pairs.filter(([section, value]) => !isSectionHealthy(section, value)).map(([name]) => name);
  }
}
