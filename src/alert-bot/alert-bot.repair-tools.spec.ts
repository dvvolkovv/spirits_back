import { AlertBotRepairAuth } from './alert-bot.repair-auth';
import { AlertBotRepairJobs } from './alert-bot.repair-jobs';
import { AlertBotRepairTools } from './alert-bot.repair-tools';
import { RepairJobRecord, RepairStore } from './alert-bot.repair-store';
import { toolText } from './alert-bot.mask';
import { OpsContext, OpsToolHandler, RepairIdentity } from './alert-bot.types';

const repairCtx: RepairIdentity = {
  scope: 'repair',
  adminUserId: 'tg:123',
  adminTgId: '123',
  chatId: '-1001',
  turnId: 'turn-1',
  repairId: 'repair-1',
};

const jobUuid = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const longHex = '0123456789abcdef0123456789abcdef';
const outputPath = `/tmp/${longHex}/a.docx`;

function terminalJob(overrides: Partial<RepairJobRecord> = {}): RepairJobRecord {
  return {
    id: jobUuid,
    repairId: 'repair-1',
    sequence: 1,
    host: 'prod',
    command: 'libreoffice --headless --convert-to pdf',
    kind: 'exec',
    mutates: true,
    interruptible: true,
    timeoutMs: 120000,
    status: 'succeeded',
    exitCode: 0,
    stdout: `saved ${outputPath}; API_KEY=raw-secret`,
    stderr: '',
    failureKind: null,
    ...overrides,
  };
}

describe('AlertBotRepairAuth', () => {
  const env = { ...process.env };
  let isActiveRepair: jest.Mock;
  let auth: AlertBotRepairAuth;

  beforeEach(() => {
    process.env.ALERT_BOT_REPAIR_ADMIN_TG_IDS = '123,456';
    isActiveRepair = jest.fn().mockResolvedValue(true);
    auth = new AlertBotRepairAuth({ isActiveRepair } as unknown as RepairStore);
  });

  afterEach(() => {
    process.env = { ...env };
    jest.restoreAllMocks();
  });

  it('разрешает только repair-админа с активной repair-записью', async () => {
    await expect(auth.authorize(repairCtx)).resolves.toBe(true);
    expect(isActiveRepair).toHaveBeenCalledWith(repairCtx);
  });

  it('не обращается к store для пользователя вне repair allowlist', async () => {
    await expect(auth.authorize({ ...repairCtx, adminTgId: '999' })).resolves.toBe(false);
    expect(isActiveRepair).not.toHaveBeenCalled();
  });

  it('отклоняет админа, если repair уже неактивен', async () => {
    isActiveRepair.mockResolvedValue(false);
    await expect(auth.authorize(repairCtx)).resolves.toBe(false);
  });
});

describe('AlertBotRepairTools', () => {
  let base: OpsToolHandler;
  let baseExecute: jest.Mock;
  let start: jest.Mock;
  let wait: jest.Mock;
  let tools: AlertBotRepairTools;

  beforeEach(() => {
    baseExecute = jest.fn().mockResolvedValue('BASE-RESULT');
    base = {
      definitions: () => [{
        name: 'alerts',
        description: 'read only',
        inputSchema: { type: 'object', properties: {} },
      }],
      execute: baseExecute,
    };
    start = jest.fn().mockResolvedValue({ jobId: 'job-1' });
    wait = jest.fn().mockResolvedValue(terminalJob());
    tools = new AlertBotRepairTools(base, { start, wait } as unknown as AlertBotRepairJobs);
  });

  it('добавляет три repair schema к базовым read-only инструментам', () => {
    const definitions = tools.definitions();
    expect(definitions.map((definition) => definition.name)).toEqual([
      'alerts', 'repair_exec', 'repair_job', 'repair_verify',
    ]);

    const exec = definitions.find((definition) => definition.name === 'repair_exec') as any;
    expect(exec.inputSchema).toEqual({
      type: 'object',
      required: ['host', 'command'],
      properties: {
        host: { type: 'string', enum: ['prod', 'relay', 'test'] },
        command: { type: 'string' },
        timeout_ms: { type: 'integer', minimum: 1000, maximum: 1800000 },
        interruptible: { type: 'boolean' },
        mutates: { type: 'boolean' },
      },
    });
    const verify = definitions.find((definition) => definition.name === 'repair_verify') as any;
    expect(verify.inputSchema).toEqual(exec.inputSchema);

    const job = definitions.find((definition) => definition.name === 'repair_job') as any;
    expect(job.inputSchema).toEqual({
      type: 'object',
      required: ['job_id'],
      properties: {
        job_id: { type: 'string' },
        wait_seconds: { type: 'integer', minimum: 0, maximum: 30 },
      },
    });
  });

  it('делегирует read-only вызов базовому handler с исходными ctx и signal', async () => {
    const controller = new AbortController();
    await expect(tools.execute('alerts', { hours: 2 }, repairCtx, controller.signal)).resolves.toBe('BASE-RESULT');
    expect(baseExecute).toHaveBeenCalledWith('alerts', { hours: 2 }, repairCtx, controller.signal);
    expect(start).not.toHaveBeenCalled();
    expect(wait).not.toHaveBeenCalled();
  });

  it('не снимает прежнюю PII-маску с read-only результата', async () => {
    baseExecute.mockResolvedValue(toolText({ id: jobUuid, path: outputPath }));
    const result = await tools.execute('alerts', {}, repairCtx);
    expect(result).toContain('[id]');
    expect(result).toContain('[скрыто]');
    expect(result).not.toContain(jobUuid);
    expect(result).not.toContain(longHex);
  });

  it.each([
    [{ scope: 'ops', adminUserId: 'u', chatId: '1' } as OpsContext],
    [{ ...repairCtx, repairId: undefined } as unknown as OpsContext],
    [{ ...repairCtx, turnId: undefined } as unknown as OpsContext],
    [{ ...repairCtx, adminTgId: undefined } as unknown as OpsContext],
  ])('не exposing repair tool вне полного repair scope: %p', async (ctx) => {
    await expect(tools.execute('repair_exec', { host: 'prod', command: 'true' }, ctx)).resolves.toBe(
      JSON.stringify({ error: 'unknown_tool' }),
    );
    expect(start).not.toHaveBeenCalled();
  });

  it.each(['exec', 'verify'] as const)('запускает repair_%s через jobs.start', async (kind) => {
    const args = { host: 'prod', command: 'systemctl restart example', interruptible: true, mutates: false };
    const result = await tools.execute(`repair_${kind}`, args, repairCtx);
    expect(start).toHaveBeenCalledWith(repairCtx, kind, args);
    expect(JSON.parse(result)).toEqual({ jobId: 'job-1' });
  });

  it('возвращает свежий terminal job без маскировки UUID, long hex и пути', async () => {
    const result = await tools.execute('repair_job', { job_id: jobUuid, wait_seconds: 7 }, repairCtx);
    expect(wait).toHaveBeenCalledWith(repairCtx, jobUuid, 7);
    expect(JSON.parse(result)).toEqual({
      ...terminalJob(),
      stdout: `saved ${outputPath}; API_KEY=[скрыто]`,
    });
    expect(result).toContain(jobUuid);
    expect(result).toContain(outputPath);
    expect(result).not.toContain('raw-secret');
  });

  it('возвращает startError как типизированный результат', async () => {
    start.mockResolvedValue({ jobId: 'job-1', startError: 'spawn_error' });
    const result = await tools.execute('repair_exec', { host: 'prod', command: 'true' }, repairCtx);
    expect(JSON.parse(result)).toEqual({ jobId: 'job-1', startError: 'spawn_error' });
  });

  it.each([
    'unknown_host',
    'invalid_command',
    'repair_inactive',
    'repair_outcome_unknown',
    'remote_not_interruptible',
    'job_already_active',
    'job_not_found',
    'store_unavailable',
    'spawn_error',
  ])('сохраняет только известную ошибку %s', async (code) => {
    start.mockRejectedValue(new Error(code));
    const result = await tools.execute('repair_exec', { host: 'unknown', command: '' }, repairCtx);
    expect(JSON.parse(result)).toEqual({ error: code });
  });

  it('превращает неизвестную ошибку в tool_failed без исходного текста', async () => {
    start.mockRejectedValue(new Error('RAW-REPAIR-SECRET'));
    const result = await tools.execute('repair_exec', { host: 'prod', command: 'true' }, repairCtx);
    expect(JSON.parse(result)).toEqual({ error: 'tool_failed' });
    expect(result).not.toContain('RAW-REPAIR-SECRET');
  });

  it('маскирует секреты в произвольном строковом поле результата', async () => {
    wait.mockResolvedValue(terminalJob({
      stdout: `Bearer raw-token-value\n${outputPath}\n${jobUuid}`,
      stderr: 'password=another-secret',
    }));
    const result = await tools.execute('repair_job', { job_id: jobUuid }, repairCtx);
    expect(wait).toHaveBeenCalledWith(repairCtx, jobUuid, 0);
    expect(result).toContain('Bearer [скрыто]');
    expect(result).toContain('password=[скрыто]');
    expect(result).toContain(outputPath);
    expect(result).toContain(jobUuid);
    expect(result).not.toContain('raw-token-value');
    expect(result).not.toContain('another-secret');
  });

  it('ограничивает repair output 8192 байтами UTF-8', async () => {
    wait.mockResolvedValue(terminalJob({ stdout: 'я'.repeat(9000) }));
    const result = await tools.execute('repair_job', { job_id: jobUuid }, repairCtx);
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(8192);
    expect(result.endsWith('\n…[обрезано]')).toBe(true);
  });

  it('обрезает JSON >150 КБ без O(n²) блокировки event loop', async () => {
    wait.mockResolvedValue(terminalJob({
      command: 'c'.repeat(32 * 1024),
      stdout: 'x'.repeat(64 * 1024),
      stderr: 'y'.repeat(64 * 1024),
    }));
    const startedAt = Date.now();
    const result = await tools.execute('repair_job', { job_id: jobUuid }, repairCtx);
    const elapsed = Date.now() - startedAt;
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(8192);
    expect(result.endsWith('\n…[обрезано]')).toBe(true);
    expect(elapsed).toBeLessThan(1000);
  });
});
