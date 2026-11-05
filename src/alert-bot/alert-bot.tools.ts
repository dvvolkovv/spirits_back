import { Injectable } from '@nestjs/common';
import { AdminService } from '../admin/admin.service';
import { LogsService } from '../monitoring/logs.service';
import { MonitoringService } from '../monitoring/monitoring.service';
import { EconomyService, EconomyWindow } from '../monitoring/product/economy.service';
import { FunnelService } from '../monitoring/product/funnel.service';
import { SummaryService } from '../monitoring/product/summary.service';
import { SupportService } from '../support/support.service';
import { AlertBotHealthService, HEALTH_SECTIONS, HealthSection } from './alert-bot.health';
import { maskText, toolText, userLabel } from './alert-bot.mask';
import { throwIfAborted } from '../common/abort';
import { AlertBotStore } from './alert-bot.store';
import { OpsContext, OpsToolHandler } from './alert-bot.types';

const STATS_SECTIONS = ['economy', 'funnel', 'summary', 'payments', 'tokens', 'active'] as const;
const ECONOMY_WINDOWS: EconomyWindow[] = ['24h', '7d', '30d', '90d', 'all'];
const DAY_MS = 24 * 60 * 60 * 1000;

type StatsSection = typeof STATS_SECTIONS[number];
type PromRow = { metric: Record<string, string>; value: [number, string] };

function clip(value: string, max: number): string {
  return Array.from(value).slice(0, max).join('');
}

function intArg(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function metricKey(metric: Record<string, string>): string {
  return JSON.stringify(
    Object.keys(metric)
      .filter((key) => key !== '__name__' && key !== 'alertstate')
      .sort()
      .map((key) => [key, metric[key]]),
  );
}

function maskedClip(value: unknown, max: number): string | null {
  if (value === null || value === undefined) return null;
  return clip(maskText(String(value)), max);
}

function validDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date : null;
}

@Injectable()
export class AlertBotTools implements OpsToolHandler {
  constructor(
    private readonly monitoring: MonitoringService,
    private readonly logsService: LogsService,
    private readonly health: AlertBotHealthService,
    private readonly store: AlertBotStore,
    private readonly economy: EconomyService,
    private readonly funnel: FunnelService,
    private readonly summaryService: SummaryService,
    private readonly admin: AdminService,
    private readonly support: SupportService,
  ) {}

  definitions(): Array<Record<string, unknown>> {
    return [
      {
        name: 'alerts',
        description: 'Текущие и недавние алерты Prometheus и журнал уведомлений.',
        inputSchema: {
          type: 'object',
          properties: {
            hours: { type: 'integer', minimum: 1, maximum: 72, description: 'Окно журнала и истории в часах.' },
          },
        },
      },
      {
        name: 'health',
        description: 'Состояние одного раздела технического здоровья Linkeon.',
        inputSchema: {
          type: 'object',
          required: ['section'],
          properties: { section: { type: 'string', enum: [...HEALTH_SECTIONS] } },
        },
      },
      {
        name: 'logs',
        description: 'Поиск по production-логам linkeon-api за ограниченное окно.',
        inputSchema: {
          type: 'object',
          required: ['query'],
          properties: {
            query: { type: 'string', description: 'Текст для безопасного LogQL line filter.' },
            minutes: { type: 'integer', minimum: 1, maximum: 1440 },
            level: { type: 'string', enum: ['error', 'warn', 'all'] },
            limit: { type: 'integer', minimum: 1, maximum: 100 },
          },
        },
      },
      {
        name: 'stats',
        description: 'Продуктовая статистика: экономика, воронка, сводка, платежи, токены и активность.',
        inputSchema: {
          type: 'object',
          required: ['section'],
          properties: {
            section: { type: 'string', enum: [...STATS_SECTIONS] },
            days: { type: 'integer', minimum: 1, maximum: 365 },
            window: { type: 'string', enum: ECONOMY_WINDOWS },
            bucket: { type: 'string', enum: ['day', 'hour', 'week'] },
            source: { type: 'string' },
          },
        },
      },
      {
        name: 'tickets',
        description: 'Список тикетов поддержки или карточка по короткому идентификатору #1234abcd.',
        inputSchema: {
          type: 'object',
          properties: {
            ticket: { type: 'string', description: 'Короткий идентификатор в формате #8hex.' },
            active: { type: 'boolean', description: 'false включает resolved и closed.' },
            limit: { type: 'integer', minimum: 1, maximum: 20 },
          },
        },
      },
    ];
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    _ctx: OpsContext,
    signal?: AbortSignal,
  ): Promise<string> {
    try {
      throwIfAborted(signal);
      let result: unknown;
      switch (name) {
        case 'alerts': result = await this.alerts(args, signal); break;
        case 'health': result = await this.healthTool(args, signal); break;
        case 'logs': result = await this.logs(args, signal); break;
        case 'stats': result = await this.stats(args, signal); break;
        case 'tickets': result = await this.tickets(args, signal); break;
        default: result = { error: 'unknown_tool' };
      }
      return toolText(result);
    } catch {
      throwIfAborted(signal);
      return toolText({ error: 'source_failed' });
    }
  }

  private async alerts(args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const hours = intArg(args.hours, 1, 72, 24);
    const [firingResult, stateResult, historyResult, journalResult] = await Promise.allSettled([
      this.monitoring.query('ALERTS{alertstate="firing"}', signal),
      this.monitoring.query('ALERTS_FOR_STATE', signal),
      this.monitoring.query(`max_over_time(ALERTS{alertstate="firing"}[${hours}h])`, signal),
      this.store.recentAlerts(hours, 50, signal),
    ]);

    throwIfAborted(signal);
    const prometheusFailed = [firingResult, stateResult, historyResult]
      .some((result) => result.status === 'rejected');
    const firingRows = firingResult.status === 'fulfilled' ? firingResult.value : [];
    const stateRows = stateResult.status === 'fulfilled' ? stateResult.value : [];
    const historyRows = historyResult.status === 'fulfilled' ? historyResult.value : [];
    const stateByMetric = new Map(stateRows.map((row) => [metricKey(row.metric), row]));

    const firing = firingRows.map((row: PromRow) => {
      const state = stateByMetric.get(metricKey(row.metric));
      const sinceSeconds = state ? Number(state.value[1]) : Number.NaN;
      const since = Number.isFinite(sinceSeconds)
        ? new Date(sinceSeconds * 1000).toISOString()
        : null;
      return { metric: row.metric, ts: row.value[0], value: row.value[1], since };
    });
    const journal = journalResult.status === 'fulfilled'
      ? journalResult.value
      : { error: 'source_failed' };

    return {
      hours,
      prometheus: {
        ...(prometheusFailed ? { error: 'source_failed' } : {}),
        firing,
        history: historyRows.map((row: PromRow) => ({
          metric: row.metric,
          ts: row.value[0],
          value: row.value[1],
        })),
      },
      journal,
    };
  }

  private async healthTool(args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const section = args.section;
    if (typeof section !== 'string' || !HEALTH_SECTIONS.includes(section as HealthSection)) {
      return { error: 'invalid_params' };
    }
    return { section, data: await this.health.getSection(section as HealthSection, signal) };
  }

  private async logs(args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (typeof args.query !== 'string' || !args.query.trim()) return { error: 'invalid_params' };
    if (args.level !== undefined && !['error', 'warn', 'all'].includes(String(args.level))) {
      return { error: 'invalid_params' };
    }
    const query = clip(args.query.trim(), 200);
    const minutes = intArg(args.minutes, 1, 1440, 60);
    const limit = intArg(args.limit, 1, 100, 100);
    const level = args.level === 'warn' ? 'WARN' : args.level === 'all' ? null : 'ERROR';
    const escaped = query
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\r/g, '\\r')
      .replace(/\n/g, '\\n');
    const selector = `{job="linkeon-api", filename=~"/pm2_logs/linkeon-api-.*[.]log"${level ? `, level="${level}"` : ''}} |= "${escaped}"`;
    const toMs = Date.now();
    const to = (BigInt(toMs) * 1_000_000n).toString();
    const from = (BigInt(toMs - minutes * 60_000) * 1_000_000n).toString();
    const response = await this.logsService.query({ query: selector, from, to, limit }, signal);
    return {
      query: response.query,
      from: response.from,
      to: response.to,
      generatedAt: response.generatedAt,
      lines: response.lines.map((line) => ({
        ts: line.ts,
        stream: line.stream,
        line: clip(maskText(line.line), 300),
      })),
    };
  }

  private async stats(args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const section = args.section;
    if (typeof section !== 'string' || !STATS_SECTIONS.includes(section as StatsSection)) {
      return { error: 'invalid_params' };
    }
    if (args.window !== undefined && !ECONOMY_WINDOWS.includes(args.window as EconomyWindow)) {
      return { error: 'invalid_params' };
    }
    if (args.bucket !== undefined && !['day', 'hour', 'week'].includes(String(args.bucket))) {
      return { error: 'invalid_params' };
    }
    const days = intArg(args.days, 1, 365, 7);
    const effectiveDays = section === 'tokens' && args.bucket === 'hour' ? Math.min(days, 14) : days;
    const window = (args.window || '30d') as EconomyWindow;
    let data: unknown;
    switch (section as StatsSection) {
      case 'payments':
        data = await this.admin.getPaymentsStats({ days, includeTest: false }, signal);
        break;
      case 'tokens':
        data = await this.admin.getTokensSpendStats({ days: effectiveDays, bucket: args.bucket === 'hour' ? 'hour' : 'day' }, signal);
        break;
      case 'active':
        data = await this.admin.getActiveUsersStats({ days, bucket: args.bucket === 'week' ? 'week' : 'day' }, signal);
        break;
      case 'funnel': {
        const to = new Date(Date.now());
        const from = new Date(to.getTime() - days * DAY_MS);
        const source = typeof args.source === 'string' && args.source.trim() ? args.source.trim() : null;
        data = await this.funnel.getFunnel(from.toISOString(), to.toISOString(), source, signal);
        break;
      }
      case 'summary':
        data = await this.summaryService.getOverview(signal);
        break;
      case 'economy':
        data = await this.economy.getOverview(window, signal);
        break;
    }
    return {
      section,
      days: effectiveDays,
      ...(effectiveDays !== days ? { requestedDays: days } : {}),
      window,
      data,
    };
  }

  private async tickets(args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (args.active !== undefined && typeof args.active !== 'boolean') return { error: 'invalid_params' };
    if (args.ticket !== undefined) {
      if (typeof args.ticket !== 'string' || !/^#[0-9a-f]{8}$/i.test(args.ticket)) {
        return { error: 'invalid_params' };
      }
      const prefix = args.ticket.slice(1).toLowerCase();
      const found = await this.support.findTicketByPrefix(prefix, signal);
      if (!found) return { error: 'not_found' };
      const card = await this.support.adminGetTicket(found.id, signal);
      return {
        ticket: this.ticketSummary(card.ticket, card.user?.profile_data?.name),
        messages: (card.messages || []).slice(-10).map((message: any) => ({
          senderType: message.senderType ?? message.sender_type ?? null,
          content: maskedClip(message.content, 500),
          createdAt: message.createdAt ?? message.created_at ?? null,
        })),
      };
    }

    const limit = intArg(args.limit, 1, 20, 20);
    const active = args.active !== false;
    const rows = await this.support.adminListTickets({ limit, active }, signal);
    const tickets = rows
      .filter((row: any) => !active || !['resolved', 'closed'].includes(row.status))
      .slice(0, limit)
      .map((row: any) => this.ticketSummary(row));
    return { tickets };
  }

  private ticketSummary(row: any, profileName?: string | null): Record<string, unknown> {
    const id = String(row.id);
    const userId = row.userId ?? row.user_id;
    const assignedTo = row.assignedTo ?? row.assigned_to;
    const dueAt = row.firstResponseDueAt ?? row.first_response_due_at ?? null;
    const firstReplyAt = row.firstOwnerReplyAt ?? row.first_owner_reply_at ?? null;
    const createdAt = row.createdAt ?? row.created_at ?? null;
    const createdDate = validDate(createdAt);
    const dueDate = validDate(dueAt);
    const assigned = assignedTo
      ? userLabel(String(assignedTo), row.assignedName ?? row.assigned_name ?? null)
      : undefined;
    return {
      id: `#${id.slice(0, 8)}`,
      status: row.status,
      urgency: row.urgency,
      ageMinutes: createdDate ? Math.max(0, Math.floor((Date.now() - createdDate.getTime()) / 60_000)) : null,
      reason: maskedClip(row.escalationReason ?? row.escalation_reason ?? row.topic, 200),
      user: userLabel(String(userId), profileName ?? row.userName ?? row.user_name ?? null),
      ...(assigned ? { assigned } : {}),
      sla: {
        dueAt,
        firstReplyAt,
        overdue: !firstReplyAt && dueDate !== null && dueDate.getTime() < Date.now(),
      },
    };
  }
}
