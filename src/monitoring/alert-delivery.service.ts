import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PgService } from '../common/services/pg.service';
import { sendTelegramAlert, telegramConfigured } from '../common/telegram-alert';
import { MonitoringService } from './monitoring.service';

/**
 * Страховка доставки алертов Prometheus.
 *
 * Инцидент 2026-10-23: Selectel заблокировал прокси my.linkeon.io за неуплату,
 * сайт лежал 22 минуты. Prometheus на node-3 поймал это за 3 минуты
 * (BlackboxProbeFailed), но Alertmanager слал в единственный чат — личку, где
 * бота заблокировали ещё 09.08. Telegram отвечал 403, и за 2,5 месяца не дошёл
 * ни один алерт инфраструктуры. Канал оповещения сломался молча, а проверять
 * его было некому.
 *
 * Это второй, независимый путь. Бэкенд прода раз в 5 минут опрашивает Prometheus
 * по WireGuard и сообщает своим каналом (TELEGRAM_CHAT_ID), если порвано любое
 * звено цепочки Prometheus → Alertmanager → Telegram. В сообщение кладём горящие
 * page-алерты, чтобы суть дошла и тогда, когда основной канал молчит.
 *
 * Обратное направление прикрывает сам Prometheus: если ляжет прод, придут его
 * NodeDown и BlackboxProbeFailed. Общая точка отказа остаётся одна — бот
 * @linkeon_alert_bot: его токеном шлют оба пути.
 */

// Счётчики отказов смотрим за окно: одна потерянная отправка видна 15 минут.
const FAIL_WINDOW_MIN = 15;
const FAIL_WINDOW = `${FAIL_WINDOW_MIN}m`;
// Две проверки подряд (10 минут), чтобы блип WireGuard не будил людей.
const ALERT_AFTER_CHECKS = Number(process.env.ALERT_DELIVERY_ALERT_AFTER || 2);
const REALERT_HOURS = Number(process.env.ALERT_DELIVERY_REALERT_H || 3);
// Состояние «уже сообщили» лежит в monitor_alert_state, чтобы рестарт во время
// длящегося сбоя не присылал алерт заново.
const COMPONENT = 'prom_alert_delivery';

type Sample = { metric: Record<string, string>; value: [number, string] };

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const num = (samples: Sample[]) => (samples.length ? Number(samples[0].value[1]) : null);

@Injectable()
export class AlertDeliveryService implements OnModuleInit {
  private readonly log = new Logger(AlertDeliveryService.name);
  private consecutiveBad = 0;

  constructor(
    private readonly monitoring: MonitoringService,
    @Optional() private readonly pg?: PgService,
  ) {}

  async onModuleInit() {
    if (!this.pg) return;
    try {
      await this.pg.query(
        `CREATE TABLE IF NOT EXISTS monitor_alert_state (
           component   text PRIMARY KEY,
           alerted     boolean NOT NULL DEFAULT false,
           updated_at  timestamptz NOT NULL DEFAULT now()
         )`,
      );
    } catch (e: any) {
      this.log.error(`monitor_alert_state migration failed: ${e.message}`);
    }
  }

  @Cron('40 */5 * * * *')
  async tick() {
    await this.check().catch((e) => this.log.error(`alert delivery check failed: ${e.message}`));
  }

  /** Что сейчас сломано в цепочке доставки + какие page-алерты горят. */
  async inspect(): Promise<{ problems: string[]; firing: string[] }> {
    let amUp: Sample[], amFailed: Sample[], amDiscovered: Sample[], promErrors: Sample[], alerts: Sample[];
    try {
      [amUp, amFailed, amDiscovered, promErrors, alerts] = await Promise.all([
        this.monitoring.query('up{job="alertmanager"}'),
        this.monitoring.query(`sum(increase(alertmanager_notifications_failed_total[${FAIL_WINDOW}]))`),
        this.monitoring.query('min(prometheus_notifications_alertmanagers_discovered)'),
        this.monitoring.query(`sum(increase(prometheus_notifications_errors_total[${FAIL_WINDOW}]))`),
        this.monitoring.query('ALERTS{alertstate="firing",severity="page"}'),
      ]);
    } catch (e: any) {
      return {
        problems: [`Prometheus на node-3 не отвечает: ${esc(String(e?.message || e))}. Инфраструктурные алерты сейчас не работают — проверь node-3 и WireGuard (<code>wg show</code> на проде).`],
        firing: [],
      };
    }

    const problems: string[] = [];
    if (num(amUp) !== 1) {
      problems.push('Alertmanager недоступен для Prometheus (<code>up{job="alertmanager"}</code> ≠ 1) — алерты некому отправлять.');
    }
    const failed = num(amFailed) ?? 0;
    if (failed > 0) {
      problems.push(`Alertmanager не может отправить алерты в Telegram: неудачных отправок за ${FAIL_WINDOW_MIN} мин — ${Math.round(failed) || 1}. Причина — в <code>docker logs alertmanager</code> на node-3.`);
    }
    if ((num(amDiscovered) ?? 0) < 1) {
      problems.push('Prometheus не видит Alertmanager — алерты не уходят дальше Prometheus.');
    }
    if ((num(promErrors) ?? 0) > 0) {
      problems.push('Prometheus не может передать алерты в Alertmanager (растёт <code>prometheus_notifications_errors_total</code>).');
    }
    const firing = alerts.map((a) => `${a.metric.alertname || '?'}${a.metric.instance ? ` — ${a.metric.instance}` : ''}`);
    return { problems, firing };
  }

  async check(): Promise<void> {
    // На test-стенде Telegram для алертов не настроен — и опрашивать незачем.
    if (!telegramConfigured()) return;

    const { problems, firing } = await this.inspect();
    this.consecutiveBad = problems.length ? this.consecutiveBad + 1 : 0;
    const state = await this.getState();

    if (problems.length && this.consecutiveBad >= ALERT_AFTER_CHECKS) {
      const cooled = !state.updatedAt || Date.now() - state.updatedAt.getTime() >= REALERT_HOURS * 3600_000;
      if (state.alerted && !cooled) return;
      await sendTelegramAlert(
        `🔕 <b>Алерты инфраструктуры не доходят</b>\n` +
        problems.map((p) => `• ${p}`).join('\n') +
        (firing.length ? `\n\nСейчас горят: ${firing.map(esc).join('; ')}` : '') +
        `\n\nЭто запасной путь — сообщение отправил бэкенд прода в обход Alertmanager.`,
      );
      await this.setAlerted(true);
      this.log.warn(`alert delivery broken: ${problems.join(' | ')}`);
    } else if (!problems.length && state.alerted) {
      await sendTelegramAlert(`🔔 <b>Алерты инфраструктуры снова доходят</b>\nPrometheus, Alertmanager и отправка в Telegram в порядке.`);
      await this.setAlerted(false);
      this.log.log('alert delivery recovered');
    }
  }

  private async getState(): Promise<{ alerted: boolean; updatedAt: Date | null }> {
    if (!this.pg) return { alerted: false, updatedAt: null };
    try {
      const r = await this.pg.query(`SELECT alerted, updated_at FROM monitor_alert_state WHERE component=$1`, [COMPONENT]);
      const row = r.rows[0];
      return { alerted: row?.alerted === true, updatedAt: row?.updated_at ? new Date(row.updated_at) : null };
    } catch { return { alerted: false, updatedAt: null }; }
  }

  private async setAlerted(alerted: boolean): Promise<void> {
    if (!this.pg) return;
    try {
      await this.pg.query(
        `INSERT INTO monitor_alert_state (component, alerted, updated_at) VALUES ($1,$2,now())
         ON CONFLICT (component) DO UPDATE SET alerted=$2, updated_at=now()`,
        [COMPONENT, alerted],
      );
    } catch (e: any) { this.log.error(`setAlerted(${COMPONENT}) failed: ${e.message}`); }
  }
}
