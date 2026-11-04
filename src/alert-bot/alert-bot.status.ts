import { Injectable } from '@nestjs/common';
import { MonitoringService } from '../monitoring/monitoring.service';
import { SupportService } from '../support/support.service';
import { AlertBotHealthService } from './alert-bot.health';

type PrometheusRow = { metric: Record<string, string>; value: [number, string] };

@Injectable()
export class AlertBotStatusService {
  constructor(
    private readonly monitoring: MonitoringService,
    private readonly health: AlertBotHealthService,
    private readonly support: SupportService,
  ) {}

  async summary(): Promise<string> {
    const [alerts, badSections, tickets] = await Promise.allSettled([
      this.firingAlerts(),
      this.health.badSections(),
      this.ticketCounts(),
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
      this.monitoring.query('ALERTS_FOR_STATE{alertstate="firing"}'),
    ]);
    const stateByMetric = new Map(states.map((row) => [JSON.stringify(row.metric), row]));
    return alerts.slice(0, 10).map((alert) => {
      const state = stateByMetric.get(JSON.stringify(alert.metric));
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
