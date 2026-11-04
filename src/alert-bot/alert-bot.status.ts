import { Injectable } from '@nestjs/common';
import { MonitoringService } from '../monitoring/monitoring.service';
import { SupportService } from '../support/support.service';
import { AlertBotHealthService, withDeadline } from './alert-bot.health';

type PrometheusRow = { metric: Record<string, string>; value: [number, string] };

export const STATUS_BLOCK_TIMEOUT_MS = 2500;

function metricKey(metric: Record<string, string>): string {
  const labels = Object.keys(metric)
    .filter((key) => key !== '__name__' && key !== 'alertstate')
    .sort()
    .map((key) => [key, metric[key]]);
  return JSON.stringify(labels);
}

@Injectable()
export class AlertBotStatusService {
  constructor(
    private readonly monitoring: MonitoringService,
    private readonly health: AlertBotHealthService,
    private readonly support: SupportService,
  ) {}

  async summary(): Promise<string> {
    const [alerts, badSections, tickets] = await Promise.allSettled([
      withDeadline(this.firingAlerts(), STATUS_BLOCK_TIMEOUT_MS),
      withDeadline(this.health.badSections(), STATUS_BLOCK_TIMEOUT_MS),
      withDeadline(this.ticketCounts(), STATUS_BLOCK_TIMEOUT_MS),
    ]);

    const alertLines = alerts.status === 'rejected'
      ? 'Алерты: Prometheus недоступен'
      : alerts.value.length === 0
        ? 'Алерты: горящих нет'
        : ['Алерты:', ...alerts.value].join('\n');
    const healthLine = badSections.status === 'rejected'
      ? 'Тех: данные недоступны'
      : badSections.value.length > 0
        ? `Тех: ${badSections.value.join(', ')}`
        : 'Тех: явных сбоев нет';
    const ticketLine = tickets.status === 'rejected'
      ? 'Тикеты: данные недоступны'
      : `Тикеты: escalated ${tickets.value.active.escalated}, owner_handling ${tickets.value.active.owner_handling}, ai_handling ${tickets.value.active.ai_handling}; просрочено: ${tickets.value.overdue}`;

    return [alertLines, healthLine, ticketLine].join('\n');
  }

  private async firingAlerts(): Promise<string[]> {
    const [alerts, states]: [PrometheusRow[], PrometheusRow[]] = await Promise.all([
      this.monitoring.query('ALERTS{alertstate="firing"}'),
      this.monitoring.query('ALERTS_FOR_STATE'),
    ]);
    const stateByMetric = new Map(states.map((row) => [metricKey(row.metric), row]));
    return alerts.slice(0, 10).map((alert) => {
      const state = stateByMetric.get(metricKey(alert.metric));
      const seconds = Number(state?.value?.[1]);
      const since = Number.isFinite(seconds) ? ` (с ${new Date(seconds * 1000).toISOString()})` : '';
      return `${alert.metric.alertname} — ${alert.metric.instance}${since}`;
    });
  }

  private async ticketCounts() {
    const [active, overdue] = await Promise.all([
      this.support.countActiveTickets(),
      this.support.countOverdueTickets(),
    ]);
    return { active, overdue };
  }
}
