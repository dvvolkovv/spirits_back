import { AlertBotTools } from './alert-bot.tools';
import { HEALTH_SECTIONS } from './alert-bot.health';
import { maskText } from './alert-bot.mask';
import { EconomyWindow } from '../monitoring/product/economy.service';

const CTX = { adminUserId: 'admin', chatId: '1' };
const TICKET = '11111111-1111-4111-8111-111111111111';
const OTHER_TICKET = '22222222-2222-4222-8222-222222222222';
const SECRET = '79012345678 a@example.com 11111111-1111-4111-8111-111111111111';

type Mocks = {
  monitoring: { query: jest.Mock };
  logs: { query: jest.Mock };
  health: { getSection: jest.Mock };
  store: { recentAlerts: jest.Mock };
  economy: { getOverview: jest.Mock };
  funnel: { getFunnel: jest.Mock };
  summary: { getOverview: jest.Mock };
  admin: {
    getPaymentsStats: jest.Mock;
    getTokensSpendStats: jest.Mock;
    getActiveUsersStats: jest.Mock;
  };
  support: {
    adminListTickets: jest.Mock;
    findTicketByPrefix: jest.Mock;
    adminGetTicket: jest.Mock;
  };
};

function makeMocks(): Mocks {
  return {
    monitoring: { query: jest.fn(async () => []) },
    logs: {
      query: jest.fn(async (opts) => ({
        query: opts.query, from: opts.from, to: opts.to, lines: [], generatedAt: '2026-11-05T00:00:00.000Z',
      })),
    },
    health: { getSection: jest.fn(async () => ({})) },
    store: { recentAlerts: jest.fn(async () => []) },
    economy: { getOverview: jest.fn(async () => ({})) },
    funnel: { getFunnel: jest.fn(async () => ({})) },
    summary: { getOverview: jest.fn(async () => ({})) },
    admin: {
      getPaymentsStats: jest.fn(async () => ({})),
      getTokensSpendStats: jest.fn(async () => ({})),
      getActiveUsersStats: jest.fn(async () => ({})),
    },
    support: {
      adminListTickets: jest.fn(async () => []),
      findTicketByPrefix: jest.fn(async () => null),
      adminGetTicket: jest.fn(async () => null),
    },
  };
}

function makeTools(mocks: Mocks): AlertBotTools {
  return new AlertBotTools(
    mocks.monitoring as any,
    mocks.logs as any,
    mocks.health as any,
    mocks.store as any,
    mocks.economy as any,
    mocks.funnel as any,
    mocks.summary as any,
    mocks.admin as any,
    mocks.support as any,
  );
}

async function execute(tools: AlertBotTools, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const text = await tools.execute(name, args, CTX);
  expect(typeof text).toBe('string');
  return JSON.parse(text);
}

function ticketRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TICKET,
    userId: 'user-raw-id',
    userName: 'Имя a@example.com',
    userTokens: 100,
    status: 'escalated',
    urgency: 'high',
    topic: 'тема',
    escalationReason: SECRET,
    notes: 'не отдавать',
    assignedTo: 'owner-raw-id',
    assignedAt: new Date('2026-11-05T00:00:00.000Z'),
    assignedName: 'Владелец',
    firstResponseDueAt: new Date('2026-11-05T00:10:00.000Z'),
    firstOwnerReplyAt: null,
    lastMessage: 'последнее',
    messageCount: 3,
    createdAt: new Date('2026-11-05T00:00:00.000Z'),
    updatedAt: new Date('2026-11-05T00:02:00.000Z'),
    lastMessageAt: new Date('2026-11-05T00:02:00.000Z'),
    ...overrides,
  };
}

describe('AlertBotTools', () => {
  let mocks: Mocks;
  let tools: AlertBotTools;

  beforeEach(() => {
    process.env.RELAY_FS_SALT = 'alert-bot-tools-spec-salt';
    mocks = makeMocks();
    tools = makeTools(mocks);
    jest.spyOn(Date, 'now').mockReturnValue(new Date('2026-11-05T01:00:00.000Z').getTime());
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    delete process.env.RELAY_FS_SALT;
  });

  it('возвращает ровно пять определений с inputSchema', () => {
    const definitions = tools.definitions() as any[];
    expect(definitions.map((tool) => tool.name)).toEqual(['alerts', 'health', 'logs', 'stats', 'tickets']);
    expect(definitions).toHaveLength(5);
    for (const definition of definitions) {
      expect(definition.description).toEqual(expect.any(String));
      expect(definition.description.length).toBeGreaterThan(0);
      expect(definition.inputSchema).toMatchObject({ type: 'object', properties: expect.any(Object) });
    }
    const byName = Object.fromEntries(definitions.map((tool) => [tool.name, tool.inputSchema]));
    expect(byName.alerts.properties.hours).toMatchObject({ type: 'integer', minimum: 1, maximum: 72 });
    expect(byName.health).toMatchObject({ required: ['section'], properties: { section: { enum: [...HEALTH_SECTIONS] } } });
    expect(byName.logs).toMatchObject({
      required: ['query'],
      properties: {
        query: { type: 'string' },
        minutes: { type: 'integer', minimum: 1, maximum: 1440 },
        level: { enum: ['error', 'warn', 'all'] },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
    });
    expect(byName.stats).toMatchObject({
      required: ['section'],
      properties: {
        section: { enum: ['economy', 'funnel', 'summary', 'payments', 'tokens', 'active'] },
        days: { type: 'integer', minimum: 1, maximum: 365 },
        window: { enum: ['24h', '7d', '30d', '90d', 'all'] },
        bucket: { enum: ['day', 'hour', 'week'] },
        source: { type: 'string' },
      },
    });
    expect(byName.tickets.properties).toMatchObject({
      ticket: { type: 'string' },
      active: { type: 'boolean' },
      limit: { type: 'integer', minimum: 1, maximum: 20 },
    });
  });

  it.each([
    ['alerts', {}, (m: Mocks) => {
      m.monitoring.query.mockResolvedValue([{ metric: { detail: SECRET }, value: [1, '1'] }]);
      m.store.recentAlerts.mockResolvedValue([{ id: 1, text: SECRET, createdAt: new Date() }]);
    }],
    ['health', { section: 'claude' }, (m: Mocks) => m.health.getSection.mockResolvedValue({ detail: SECRET })],
    ['logs', { query: 'ошибка' }, (m: Mocks) => m.logs.query.mockResolvedValue({
      query: SECRET, from: '1', to: '2', generatedAt: new Date().toISOString(),
      lines: [{ ts: 1, stream: { detail: SECRET }, line: SECRET }],
    })],
    ['stats', { section: 'economy' }, (m: Mocks) => m.economy.getOverview.mockResolvedValue({ detail: SECRET })],
    ['tickets', {}, (m: Mocks) => m.support.adminListTickets.mockResolvedValue([ticketRow()])],
  ])('%s: ответ полностью маскируется', async (name, args, prepare) => {
    prepare(mocks);
    const text = await tools.execute(name as string, args as Record<string, unknown>, CTX);
    expect(text).not.toContain('79012345678');
    expect(text).not.toContain('a@example.com');
    expect(text).not.toContain(TICKET);
    expect(text).toContain('a***@example.com');
  });

  it('alerts ограничивает окно, переживает сбой Prometheus и не раскрывает ошибку', async () => {
    mocks.monitoring.query.mockRejectedValue(new Error(`raw ${SECRET}`));
    mocks.store.recentAlerts.mockResolvedValue([{ id: 7, text: 'journal remains', createdAt: new Date() }]);

    const result = await execute(tools, 'alerts', { hours: 999 });

    expect(mocks.store.recentAlerts).toHaveBeenCalledWith(72, 50);
    expect(mocks.monitoring.query).toHaveBeenCalledTimes(3);
    expect(result.prometheus).toMatchObject({ error: 'source_failed' });
    expect(result.journal).toEqual([expect.objectContaining({ text: 'journal remains' })]);
    expect(JSON.stringify(result)).not.toContain('raw');
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('alerts запрашивает firing, длительность и историю и связывает since по метрике', async () => {
    const metric = { alertname: 'ApiDown', instance: 'prod' };
    mocks.monitoring.query.mockImplementation(async (query: string) => {
      if (query.startsWith('ALERTS_FOR_STATE')) return [{ metric, value: [1_800_000_000, '120'] }];
      if (query.startsWith('max_over_time')) return [{ metric, value: [1_800_000_000, '1'] }];
      return [{ metric, value: [1_800_000_000, '1'] }];
    });

    const result = await execute(tools, 'alerts', { hours: 6 });

    expect(mocks.monitoring.query.mock.calls.map(([query]) => query)).toEqual([
      'ALERTS{alertstate="firing"}',
      'ALERTS_FOR_STATE{alertstate="firing"}',
      'max_over_time(ALERTS{alertstate="firing"}[6h])',
    ]);
    expect(result.prometheus.firing[0]).toMatchObject({
      metric,
      since: new Date((1_800_000_000 - 120) * 1000).toISOString(),
    });
    expect(result.prometheus.history[0].metric).toEqual(metric);
  });

  it('health принимает claude и отклоняет неизвестный раздел', async () => {
    mocks.health.getSection.mockResolvedValue({ llmStatus: 'ok' });
    await expect(execute(tools, 'health', { section: 'claude' })).resolves.toMatchObject({
      section: 'claude', data: { llmStatus: 'ok' },
    });
    expect(mocks.health.getSection).toHaveBeenCalledWith('claude');

    await expect(execute(tools, 'health', { section: 'other' })).resolves.toEqual({ error: 'invalid_params' });
    expect(mocks.health.getSection).toHaveBeenCalledTimes(1);
  });

  it('logs сам строит prod LogQL, экранирует query и ограничивает limit', async () => {
    const rawLine = `${'x'.repeat(295)}a@example.com${'я'.repeat(400)}`;
    mocks.logs.query.mockImplementation(async (opts) => ({
      query: opts.query, from: opts.from, to: opts.to, generatedAt: new Date().toISOString(),
      lines: [{ ts: 1, stream: { job: 'linkeon-api' }, line: rawLine }],
    }));

    const result = await execute(tools, 'logs', {
      query: 'ошибка"\\', minutes: 60, level: 'error', limit: 500,
      from: '/home/dv/', to: '/home/dv/', job: '/home/dv/',
    });

    expect(mocks.logs.query).toHaveBeenCalledTimes(1);
    const opts = mocks.logs.query.mock.calls[0][0];
    expect(opts.limit).toBe(100);
    expect(opts.query).toBe(String.raw`{job="linkeon-api", filename=~"/pm2_logs/linkeon-api-.*[.]log", level="ERROR"} |= "ошибка\"\\"`);
    expect(opts.query).not.toContain('/home/dv/');
    expect(BigInt(opts.to) - BigInt(opts.from)).toBe(60n * 60n * 1_000_000_000n);
    expect(Object.keys(opts).sort()).toEqual(['from', 'limit', 'query', 'to']);
    const expected = Array.from(maskText(rawLine)).slice(0, 300).join('');
    expect(result.lines[0].line).toBe(expected);
    expect(Array.from(result.lines[0].line)).toHaveLength(300);
    expect(result.lines[0].line).toContain('a***@');
    expect(JSON.stringify(result)).not.toContain('a@example.com');
    expect(JSON.stringify(result)).not.toContain('/home/dv/');
  });

  it('logs нормализует level=all и дефолтные минуты/limit', async () => {
    await execute(tools, 'logs', { query: '  ping  ', level: 'all', minutes: 9999 });
    const opts = mocks.logs.query.mock.calls[0][0];
    expect(opts.limit).toBe(100);
    expect(opts.query).toBe(String.raw`{job="linkeon-api", filename=~"/pm2_logs/linkeon-api-.*[.]log"} |= "ping"`);
    expect(BigInt(opts.to) - BigInt(opts.from)).toBe(1440n * 60n * 1_000_000_000n);
  });

  it.each([
    ['payments', 'getPaymentsStats', { days: 7, includeTest: false }],
    ['tokens', 'getTokensSpendStats', { days: 7, bucket: 'day' }],
    ['active', 'getActiveUsersStats', { days: 7, bucket: 'day' }],
  ])('stats %s делегирует в AdminService', async (section, method, expected) => {
    mocks.admin[method].mockResolvedValue({ section });
    const result = await execute(tools, 'stats', { section });
    expect(mocks.admin[method]).toHaveBeenCalledWith(expected);
    expect(result).toMatchObject({ section, data: { section } });
  });

  it.each([
    ['economy', '24h'],
    ['economy', '7d'],
    ['economy', '30d'],
    ['economy', '90d'],
    ['economy', 'all'],
  ])('stats economy принимает окно %s', async (section, window) => {
    mocks.economy.getOverview.mockResolvedValue({ ok: true });
    await execute(tools, 'stats', { section, window });
    expect(mocks.economy.getOverview).toHaveBeenCalledWith(window as EconomyWindow);
  });

  it('stats funnel передаёт from/to/source, summary не требует параметров', async () => {
    await execute(tools, 'stats', { section: 'funnel', days: 7, source: 'ads' });
    expect(mocks.funnel.getFunnel).toHaveBeenCalledTimes(1);
    const [from, to, source] = mocks.funnel.getFunnel.mock.calls[0];
    expect(new Date(to).getTime() - new Date(from).getTime()).toBe(7 * 24 * 60 * 60 * 1000);
    expect(source).toBe('ads');

    await execute(tools, 'stats', { section: 'funnel' });
    expect(mocks.funnel.getFunnel.mock.calls[1][2]).toBeNull();

    mocks.summary.getOverview.mockResolvedValue({ indicators: [] });
    await expect(execute(tools, 'stats', { section: 'summary' })).resolves.toMatchObject({ data: { indicators: [] } });
    expect(mocks.summary.getOverview).toHaveBeenCalledWith();
  });

  it('tickets list скрывает терминальные, ограничивает выдачу и маскирует поля', async () => {
    mocks.support.adminListTickets.mockResolvedValue([
      ticketRow(),
      ticketRow({ id: OTHER_TICKET, status: 'resolved', assignedTo: null, assignedName: null }),
    ]);

    const result = await execute(tools, 'tickets', { limit: 500 });

    expect(mocks.support.adminListTickets).toHaveBeenCalledWith({ limit: 200 });
    expect(result.tickets).toHaveLength(1);
    const item = result.tickets[0];
    expect(item).toMatchObject({
      id: '#11111111', status: 'escalated', urgency: 'high', ageMinutes: 60,
      user: { user: expect.stringMatching(/^u:[0-9a-f]{6}$/), name: expect.any(String) },
      assigned: { user: expect.stringMatching(/^u:[0-9a-f]{6}$/), name: 'Владелец' },
      sla: {
        dueAt: '2026-11-05T00:10:00.000Z', firstReplyAt: null, overdue: true,
      },
    });
    expect(item.reason).toBe(Array.from(maskText(SECRET)).slice(0, 300).join(''));
    expect(item).not.toHaveProperty('userId');
    expect(item).not.toHaveProperty('assignedTo');
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain(TICKET);
  });

  it('tickets active=false включает resolved/closed и применяет limit=20 по умолчанию', async () => {
    mocks.support.adminListTickets.mockResolvedValue(Array.from({ length: 25 }, (_, index) => ticketRow({
      id: `${String(index + 1).padStart(8, '0')}-1111-4111-8111-111111111111`,
      status: index % 2 ? 'resolved' : 'closed',
      firstOwnerReplyAt: new Date('2026-11-05T00:05:00.000Z'),
    })));
    const result = await execute(tools, 'tickets', { active: false });
    expect(result.tickets).toHaveLength(20);
    expect(result.tickets.every((ticket: any) => ticket.sla.overdue === false)).toBe(true);
  });

  it('ticket card принимает только #8hex и отдаёт последние 10 сообщений без events/sender_id', async () => {
    mocks.support.findTicketByPrefix.mockResolvedValue({ id: TICKET });
    mocks.support.adminGetTicket.mockResolvedValue({
      ticket: {
        ...ticketRow(),
        user_id: 'user-raw-id', assigned_to: 'owner-raw-id', escalation_reason: SECRET,
        first_response_due_at: new Date('2026-11-05T00:10:00.000Z'),
        first_owner_reply_at: null, created_at: new Date('2026-11-05T00:00:00.000Z'),
      },
      messages: Array.from({ length: 11 }, (_, index) => ({
        id: `message-${index}`, sender_id: 'raw-sender-id', sender_type: index % 2 ? 'ai' : 'user',
        content: `m${index} ${SECRET} ${'z'.repeat(600)}`, created_at: new Date('2026-11-05T00:00:00.000Z'),
      })),
      events: [{ payload: SECRET }],
      user: { email: 'a@example.com' },
    });

    const result = await execute(tools, 'tickets', { ticket: '#11111111' });

    expect(mocks.support.findTicketByPrefix).toHaveBeenCalledWith('11111111');
    expect(mocks.support.adminGetTicket).toHaveBeenCalledWith(TICKET);
    expect(result.ticket.id).toBe('#11111111');
    expect(result.messages).toHaveLength(10);
    expect(result.messages[0].content.startsWith('m1 ')).toBe(true);
    expect(Array.from(result.messages[0].content)).toHaveLength(500);
    expect(result.messages[0].content).toBe(Array.from(maskText(`m1 ${SECRET} ${'z'.repeat(600)}`)).slice(0, 500).join(''));
    expect(JSON.stringify(result)).not.toContain('events');
    expect(JSON.stringify(result)).not.toContain('sender_id');
    expect(JSON.stringify(result)).not.toContain('raw-sender-id');
    expect(JSON.stringify(result)).not.toContain(TICKET);

    for (const ticket of [TICKET, '11111111', '#123', '#xyzxyzxy', '#11111111 extra']) {
      await expect(execute(tools, 'tickets', { ticket })).resolves.toEqual({ error: 'invalid_params' });
    }
    expect(mocks.support.findTicketByPrefix).toHaveBeenCalledTimes(1);
  });

  it('unknown_tool, invalid_params и source_failed безопасны', async () => {
    await expect(execute(tools, 'missing')).resolves.toEqual({ error: 'unknown_tool' });
    await expect(execute(tools, 'logs', { query: '' })).resolves.toEqual({ error: 'invalid_params' });
    await expect(execute(tools, 'stats', { section: 'unknown' })).resolves.toEqual({ error: 'invalid_params' });
    mocks.economy.getOverview.mockRejectedValue(new Error(`RAW-SECRET ${SECRET}`));
    const result = await execute(tools, 'stats', { section: 'economy' });
    expect(result).toEqual({ error: 'source_failed' });
    expect(JSON.stringify(result)).not.toContain('RAW-SECRET');
  });
});
