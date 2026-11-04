jest.mock('@napi-rs/canvas', () => ({
  createCanvas: jest.fn(),
  loadImage: jest.fn(),
  GlobalFonts: { register: jest.fn() },
}));

import { AlertBotHealthService, HEALTH_SECTIONS, HealthSection } from './alert-bot.health';

type Stub = Record<string, jest.Mock>;

const generatedAt = '2026-11-04T12:00:00.000Z';
const sectionCases: Array<[HealthSection, number, string]> = [
  ['databases', 0, 'getDatabases'],
  ['sms', 2, 'getOverview'],
  ['nanobanana', 3, 'getOverview'],
  ['tg-bot', 4, 'getOverview'],
  ['payments', 5, 'getOverview'],
  ['quality', 6, 'getOverview'],
  ['claude', 7, 'getOverview'],
  ['geo', 8, 'getLatest'],
  ['backups', 9, 'getOverview'],
  ['models', 10, 'getOverview'],
  ['jobs', 11, 'getOverview'],
  ['replication', 12, 'getOverview'],
  ['neo4j-dr', 13, 'getOverview'],
  ['minio-dr', 14, 'getOverview'],
  ['synthetic', 1, 'getOverview'],
];

// Формы ответов повторяют интерфейсы getOverview/getLatest соответствующих
// monitoring-сервисов. Общего поля status у этих контрактов нет.
const healthy: Record<HealthSection, any> = {
  overview: {
    nodes: [{ instance: 'prod', host: 'prod', up: true, load1: 0.2, cpuPct: 10, memPct: 40, diskPct: 50, uptimeSec: 1000 }],
    probes: [{ target: 'https://my.linkeon.io', success: true, httpStatus: 200, latencySec: 0.1, tlsSecLeft: 86400 }],
    generatedAt,
  },
  databases: {
    postgres: [{ instance: 'pg', up: true, dbSizeBytes: 100, connections: 2, tps: 3, cacheHitRatio: 0.99, deadlocks: 0 }],
    redis: [{ instance: 'redis', up: true, memoryUsedBytes: 100, connectedClients: 2, opsPerSec: 3, keyspaceHitRatio: 0.99, evictedKeys: 0 }],
    minio: [{ instance: 'minio', up: true, buckets: 2, objects: 10, usedBytes: 100, freeBytes: 900, totalBytes: 1000 }],
    nginx: [{ instance: 'nginx', up: true, activeConnections: 2, reqPerSec: 3, acceptedTotal: 10, handledTotal: 10, reading: 0, writing: 1, waiting: 1 }],
    neo4j: [{ instance: 'neo', up: true, heapUsedBytes: 100, heapMaxBytes: 200, heapUsedPct: 50, threads: 5, gcTimeSecTotal: 1, nodes: 10, relationships: 20 }],
    generatedAt,
  },
  sms: {
    generatedAt,
    balance: { rub: 1000, fetchedAt: generatedAt, error: null },
    alertThresholdRub: 500,
    success24h: 10,
    failure24h: 0,
    failureRatePct24h: 0,
    lastFailureAt: null,
    lastFailureReason: null,
    topFailureReasons: [],
  },
  nanobanana: { generatedAt, configured: true, model: 'gemini-image', healthy: true, latencyMs: 100, checkedAt: generatedAt, error: null, consecutiveFailures: 0 },
  'tg-bot': {
    generatedAt,
    configured: true,
    webhook: { healthy: true, url: 'https://my.linkeon.io/webhook/telegram', pendingUpdateCount: 0, lastErrorMessage: null, lastErrorAt: null, checkedAt: generatedAt, error: null, consecutiveFailures: 0 },
    unanswered: { thresholdMinutes: 30, stuckChats: 0, checkedAt: generatedAt, chats: [] },
  },
  payments: {
    generatedAt,
    shop: { configured: true, healthy: true, status: 'enabled', accountId: 'shop', checkedAt: generatedAt, error: null, consecutiveFailures: 0 },
    attempts: { failStreak: 0, threshold: 3, lastError: null, lastFailureAt: null, checkedAt: generatedAt },
    funnel: { windowHours: 24, created: 5, succeeded: 4, healthy: true, checkedAt: generatedAt },
  },
  quality: {
    generatedAt,
    providerFailures: { window_min: 120, count: 0, sample: null },
    videoFailureRate: { window_min: 120, failed: 0, total: 5, pct: 0 },
    chat: { window_min: 120, responses: 20, empty: 0, emptyPct: 0, langMismatch: 0, leakPct: 0, deduped: 0 },
    refunds: { window_min: 120, count: 0, tokens: 0 },
    alerts: [],
  },
  claude: {
    generatedAt,
    usage: {
      cost24hUsd: 1, cost30dUsd: 10, calls24h: 2, calls30d: 20, topModels30d: [],
      subscriptionType: 'max', subscriptionExpiresAt: null, apiKeyValid: true, apiKeyError: null,
      llmStatus: 'ok', llmOutageKind: null, llmError: null, llmCheckedAt: generatedAt, llmLatencyMs: 100, fetchedAt: generatedAt,
    },
    alertThreshold30dUsd: 100,
    configured: { apiKey: true, cliCredentials: true },
  },
  geo: {
    checked_at: generatedAt, target: 'https://linkeon.io', ru_total: 3, ru_ok: 3, ru_failed: 0,
    baseline_ok: true, region_down: false,
    probes: [{ city: 'Moscow', network: 'ISP', asn: 1, ok: true, statusCode: 200, reason: null }],
  },
  backups: {
    generatedAt, backupRoot: '/backups', freshHours: 30,
    latest: {
      dir: 'daily', ts: generatedAt, ageHours: 1, totalBytes: 100,
      artifacts: [{ name: 'postgres', expected: true, present: true, sizeBytes: 100, integrityOk: true, error: null }],
      fresh: true, complete: true, healthy: true,
    },
    weekTotalGB: 1, weekSnapshotCount: 7, error: null,
  },
  models: {
    generatedAt,
    expected: [{ provider: 'anthropic', model: 'claude', kind: 'chat', purpose: 'chat', caller: 'chat', via: 'relay', calls_30d: 2, cost_usd_30d: 1, calls_24h: 1, last_seen: generatedAt }],
    unexpected: [],
    totals: { by_provider: [{ provider: 'anthropic', calls_30d: 2, cost_usd_30d: 1 }], by_kind: [{ kind: 'chat', calls_30d: 2, cost_usd_30d: 1 }] },
  },
  jobs: {
    generatedAt,
    video: { status_counts: { completed: 2 }, pending_total: 0, oldest_pending_age_min: null, stuck: false, threshold_min: 30 },
    tokens: { status_counts: { completed: 2 }, pending_total: 0, oldest_pending_age_sec: null, stuck: false, threshold_sec: 60 },
    vpm_recent: [{ id: 'run', trigger: 'cron', cost_usd: 1, duration_ms: 100, ok: true, rec_count: 2, created_at: generatedAt }],
    compaction: { schedule_human: 'Daily 04:00 UTC', next_run_in_h: 2, last_run_at: generatedAt, active_profiles: 3 },
  },
  replication: {
    generatedAt,
    standbys: [{ pid: 1, client_addr: '10.10.0.3', application_name: 'node3', state: 'streaming', sync_state: 'async', write_lag_sec: 0, flush_lag_sec: 0, replay_lag_sec: 0, sent_lsn: '0/1', replay_lsn: '0/1', reply_time: generatedAt }],
    slots: [{ slot_name: 'node3_dr', slot_type: 'physical', active: true, active_pid: 1, wal_status: 'reserved', restart_lsn: '0/1', safe_wal_size_bytes: 100 }],
    standby: {
      configured: true, reachable: true, inRecovery: true, replayPaused: false, receiveLsn: '0/1', replayLsn: '0/1', applyBacklogBytes: 0, lastXactReplayAgeSec: 1,
      receiver: { status: 'streaming', senderHost: '10.10.0.1', senderPort: 5432, slotName: 'node3_dr', writtenLsn: '0/1', flushedLsn: '0/1', latestEndLsn: '0/1', lastMsgReceiptTime: generatedAt, sinceLastMsgSec: 1 },
      healthy: true, error: null,
    },
    healthy: true, maxReplayLagSec: 0, thresholdSec: 60, error: null,
  },
  'neo4j-dr': {
    generatedAt, configured: true, reachable: true, host: 'node-3', dir: '/backups/neo',
    files: [{ name: 'neo4j.dump', localPresent: true, localSizeBytes: 100, localMtime: generatedAt, localMd5: 'a', remotePresent: true, remoteSizeBytes: 100, remoteMtime: generatedAt, remoteMd5: 'a', inSync: true, remoteAgeHours: 1 }],
    dumpSizeBytes: 100, prevDumpSizeBytes: 90, freshHours: 30, healthy: true, error: null,
  },
  'minio-dr': {
    generatedAt, configured: true, statusPresent: true, lastRunAt: generatedAt, ageMin: 1, durationSec: 2, drEndpoint: 'node-3',
    buckets: [{ bucket: 'media', srcObjects: 2, srcBytes: 100, dstObjects: 2, dstBytes: 100, inSync: true }],
    totalSrcObjects: 2, totalDstObjects: 2, totalSrcBytes: 100, totalDstBytes: 100,
    errors: [], freshMin: 60, healthy: true, error: null,
  },
  synthetic: {
    generatedAt,
    stale: false,
    scenarios: [{ scenario: 'site_reachable', latestSuccess: true, latestTs: generatedAt, latestDurationMs: 100, latestMessage: null, runs24h: 4, successes24h: 4, successRate24hPct: 100 }],
  },
};

const incidentCases: Array<[HealthSection, any]> = [
  ['overview', { ...healthy.overview, nodes: [{ ...healthy.overview.nodes[0], up: false }] }],
  ['databases', { ...healthy.databases, postgres: [{ ...healthy.databases.postgres[0], up: false }] }],
  ['sms', { ...healthy.sms, balance: { ...healthy.sms.balance, rub: 100 } }],
  ['nanobanana', { ...healthy.nanobanana, healthy: false, error: 'probe failed', consecutiveFailures: 2 }],
  ['tg-bot', { ...healthy['tg-bot'], unanswered: { ...healthy['tg-bot'].unanswered, stuckChats: 1, chats: [{ chatId: '1', title: 'chat', waitingMinutes: 45 }] } }],
  ['payments', { ...healthy.payments, attempts: { ...healthy.payments.attempts, failStreak: 3 } }],
  ['quality', { ...healthy.quality, alerts: ['video_failrate: 50%'] }],
  ['claude', { ...healthy.claude, usage: { ...healthy.claude.usage, llmStatus: 'down', llmError: 'probe failed' } }],
  ['geo', { ...healthy.geo, ru_ok: 0, ru_failed: 3, region_down: true, probes: [{ ...healthy.geo.probes[0], ok: false, statusCode: null, reason: 'timeout' }] }],
  ['backups', { ...healthy.backups, latest: { ...healthy.backups.latest, fresh: false, healthy: false } }],
  ['models', { ...healthy.models, unexpected: [{ model: 'unknown', source: 'relay', calls_30d: 1, last_seen: generatedAt }] }],
  ['jobs', { ...healthy.jobs, video: { ...healthy.jobs.video, pending_total: 1, oldest_pending_age_min: 45, stuck: true } }],
  ['replication', { ...healthy.replication, healthy: false, maxReplayLagSec: 120 }],
  ['neo4j-dr', { ...healthy['neo4j-dr'], healthy: false, files: [{ ...healthy['neo4j-dr'].files[0], inSync: false }] }],
  ['minio-dr', { ...healthy['minio-dr'], healthy: false, errors: ['mirror failed'] }],
  ['synthetic', { ...healthy.synthetic, scenarios: [{ ...healthy.synthetic.scenarios[0], latestSuccess: false, latestMessage: 'HTTP 500', successes24h: 3, successRate24hPct: 75 }] }],
  ['synthetic', { ...healthy.synthetic, stale: true, scenarios: [{ ...healthy.synthetic.scenarios[0], latestTs: '2026-11-04T10:00:00.000Z' }] }],
  ['tg-bot', { ...healthy['tg-bot'], configured: false, webhook: { ...healthy['tg-bot'].webhook, healthy: null }, unanswered: { ...healthy['tg-bot'].unanswered, stuckChats: 1 } }],
  ['payments', { ...healthy.payments, shop: { ...healthy.payments.shop, configured: false, healthy: null }, attempts: { ...healthy.payments.attempts, failStreak: 3 } }],
  ['payments', { ...healthy.payments, shop: { ...healthy.payments.shop, configured: false, healthy: null }, funnel: { ...healthy.payments.funnel, healthy: false } }],
];

const optionalUnconfiguredCases: Array<[HealthSection, any]> = [
  ['sms', { ...healthy.sms, balance: { rub: null, fetchedAt: generatedAt, error: 'SMSAERO_LOGIN/API_KEY not set' } }],
  ['nanobanana', { ...healthy.nanobanana, configured: false, healthy: null, checkedAt: null, error: 'GOOGLE_AI_API_KEY not set' }],
  ['tg-bot', { ...healthy['tg-bot'], configured: false, webhook: { ...healthy['tg-bot'].webhook, healthy: null, error: 'TG_BOT_TOKEN not set' } }],
  ['payments', { ...healthy.payments, shop: { ...healthy.payments.shop, configured: false, healthy: null, error: 'YOOKASSA keys not set' }, funnel: { ...healthy.payments.funnel, healthy: null } }],
  ['replication', { ...healthy.replication, standby: { ...healthy.replication.standby, configured: false, reachable: false, healthy: false } }],
  ['neo4j-dr', { ...healthy['neo4j-dr'], configured: false, reachable: false, healthy: false, files: [] }],
  ['minio-dr', { ...healthy['minio-dr'], configured: false, statusPresent: false, healthy: false, buckets: [] }],
];

const unknownCases: Array<[HealthSection, any]> = [
  ['nanobanana', { ...healthy.nanobanana, healthy: null, checkedAt: null }],
  ['claude', { ...healthy.claude, usage: { ...healthy.claude.usage, llmStatus: null, llmCheckedAt: null } }],
  ['claude', { ...healthy.claude, usage: { ...healthy.claude.usage, apiKeyValid: null, apiKeyError: 'probe failed' } }],
  ['geo', null],
  ['backups', { ...healthy.backups, latest: null, error: 'inspection failed' }],
  ['synthetic', { ...healthy.synthetic, scenarios: [{ ...healthy.synthetic.scenarios[0], latestSuccess: null, latestTs: null }] }],
];

describe('разделы технического здоровья для бота алертов', () => {
  let sources: Stub[];
  let service: AlertBotHealthService;

  beforeEach(() => {
    sources = [
      { getNodeOverview: jest.fn(), getProbes: jest.fn(), getDatabases: jest.fn() },
      { getOverview: jest.fn() }, { getOverview: jest.fn() }, { getOverview: jest.fn() },
      { getOverview: jest.fn() }, { getOverview: jest.fn() }, { getOverview: jest.fn() },
      { getOverview: jest.fn() }, { getLatest: jest.fn() }, { getOverview: jest.fn() },
      { getOverview: jest.fn() }, { getOverview: jest.fn() }, { getOverview: jest.fn() },
      { getOverview: jest.fn() }, { getOverview: jest.fn() }, { getOverview: jest.fn() },
    ];
    for (const source of sources) {
      for (const stub of Object.values(source)) stub.mockResolvedValue({ status: 'healthy' });
    }
    sources[0].getNodeOverview.mockResolvedValue([{ node: 'prod' }]);
    sources[0].getProbes.mockResolvedValue([{ probe: 'api' }]);
    service = new AlertBotHealthService(
      sources[0] as any, sources[1] as any, sources[2] as any, sources[3] as any,
      sources[4] as any, sources[5] as any, sources[6] as any, sources[7] as any,
      sources[8] as any, sources[9] as any, sources[10] as any, sources[11] as any,
      sources[12] as any, sources[13] as any, sources[14] as any, sources[15] as any,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  function mockSections(values: Partial<Record<HealthSection, unknown>>) {
    jest.spyOn(service, 'getSection').mockImplementation(async (section) => values[section] ?? { error: 'source_failed' });
  }

  it('перечисляет все 16 разделов', () => {
    expect(HEALTH_SECTIONS).toHaveLength(16);
    expect(new Set([...HEALTH_SECTIONS, ...sectionCases.map(([section]) => section), 'overview']).size).toBe(16);
    expect(new Set(incidentCases.map(([section]) => section))).toEqual(new Set(HEALTH_SECTIONS));
  });

  it('overview объединяет узлы, пробы и время формирования', async () => {
    const result = await service.getSection('overview') as any;
    expect(result.nodes).toEqual([{ node: 'prod' }]);
    expect(result.probes).toEqual([{ probe: 'api' }]);
    expect(new Date(result.generatedAt).toISOString()).toBe(result.generatedAt);
    expect(sources[0].getNodeOverview).toHaveBeenCalledTimes(1);
    expect(sources[0].getProbes).toHaveBeenCalledTimes(1);
  });

  it.each(sectionCases)('%s вызывает ожидаемый метод', async (section, sourceIndex, method) => {
    const expected = { section };
    sources[sourceIndex][method].mockResolvedValue(expected);
    await expect(service.getSection(section)).resolves.toEqual(expected);
    expect(sources[sourceIndex][method]).toHaveBeenCalledTimes(1);
  });

  it.each(HEALTH_SECTIONS.map((section) => [section, healthy[section]] as [HealthSection, any]))(
    '%s: реальный здоровый ответ не считается сбоем', async (section, value) => {
      mockSections({ [section]: value });
      await expect(service.badSections()).resolves.not.toContain(section);
    },
  );

  it.each(incidentCases)('%s: реальный аварийный ответ попадает в badSections', async (section, value) => {
    mockSections({ [section]: value });
    await expect(service.badSections()).resolves.toContain(section);
  });

  it.each(optionalUnconfiguredCases)('%s: необязательный не настроенный источник не является инцидентом', async (section, value) => {
    mockSections({ [section]: value });
    await expect(service.badSections()).resolves.not.toContain(section);
  });

  it('payments: funnel.healthy=null означает недостаточно попыток, а не инцидент', async () => {
    mockSections({ payments: { ...healthy.payments, funnel: { ...healthy.payments.funnel, healthy: null } } });
    await expect(service.badSections()).resolves.not.toContain('payments');
  });

  it('claude: без API-ключа apiKeyValid=null допустим в OAuth-режиме', async () => {
    mockSections({
      claude: {
        ...healthy.claude,
        configured: { ...healthy.claude.configured, apiKey: false },
        usage: { ...healthy.claude.usage, apiKeyValid: null, apiKeyError: null },
      },
    });
    await expect(service.badSections()).resolves.not.toContain('claude');
  });

  it.each([['models', 10], ['jobs', 11]] as Array<[HealthSection, number]>)('%s: ошибка БД производителя становится сбоем раздела', async (section, sourceIndex) => {
    sources[sourceIndex].getOverview.mockRejectedValue(new Error('db down'));
    await expect(service.badSections()).resolves.toContain(section);
  });

  it.each(unknownCases)('%s: неизвестное состояние не превращается в отсутствие сбоев', async (section, value) => {
    mockSections({ [section]: value });
    await expect(service.badSections()).resolves.toContain(section);
  });

  it('jobs: числовой stuck больше нуля тоже является инцидентом', async () => {
    mockSections({ jobs: { ...healthy.jobs, tokens: { ...healthy.jobs.tokens, stuck: 2 } } });
    await expect(service.badSections()).resolves.toContain('jobs');
  });

  it('сбой одного источника возвращает source_failed и не мешает другим разделам', async () => {
    sources[2].getOverview.mockRejectedValue(new Error('СЕКРЕТ-ИЗ-ОТВЕТА'));
    await expect(service.getSection('sms')).resolves.toEqual({ error: 'source_failed' });
    await expect(service.getSection('tg-bot')).resolves.toEqual({ status: 'healthy' });
  });

  it('явный сбой источника попадает в badSections', async () => {
    sources[2].getOverview.mockRejectedValue(new Error('СЕКРЕТ-ИЗ-ОТВЕТА'));
    await expect(service.badSections()).resolves.toContain('sms');
  });

  it('бесконечный источник завершается source_failed по дедлайну', async () => {
    sources[2].getOverview.mockImplementation(() => new Promise(() => {}));
    const startedAt = Date.now();
    await expect(service.getSection('sms')).resolves.toEqual({ error: 'source_failed' });
    expect(Date.now() - startedAt).toBeLessThan(4000);
  }, 4500);
});
