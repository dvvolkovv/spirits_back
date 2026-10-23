import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
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
 * по WireGuard и сообщает своим каналом (TELEGRAM_CHAT_ID), если порвано звено
 * цепочки Prometheus → Alertmanager → Telegram. В сообщение кладём горящие
 * page-алерты, чтобы суть дошла и тогда, когда основной канал молчит.
 *
 * Обратное направление прикрывает сам Prometheus: если ляжет прод, придут его
 * NodeDown и BlackboxProbeFailed. Общая точка отказа остаётся одна — бот
 * @linkeon_alert_bot: его токеном шлют оба пути.
 *
 * Нужны скрейп-джобы `alertmanager` и `prometheus` (собственные метрики) в
 * prometheus.yml на node-3 — без них up/discovered пустые, и это алерт.
 */

// Неудачная отправка Alertmanager — это сообщение, потерянное после всех его
// повторов, поэтому сообщаем даже об одной: она видна в окне 15 минут, то есть
// на трёх проверках подряд. Ошибки Prometheus → Alertmanager — другое дело:
// Prometheus сам переотправляет горящие алерты каждую минуту, и разовый блип
// (рестарт контейнера) ничего не теряет. Для них окно 5 минут — вместе с
// правилом двух проверок подряд это значит «ошибки идут дольше 5 минут».
const AM_WINDOW_MIN = 15;
const PROM_WINDOW_MIN = 5;
// Две проверки подряд (10 минут), чтобы блип WireGuard не будил людей.
const ALERT_AFTER_CHECKS = Number(process.env.ALERT_DELIVERY_ALERT_AFTER || 2);
const REALERT_HOURS = Number(process.env.ALERT_DELIVERY_REALERT_H || 3);
// Состояние «уже сообщили» лежит в monitor_alert_state, чтобы рестарт во время
// длящегося сбоя не присылал алерт заново.
const COMPONENT = 'prom_alert_delivery';
// Отдельная отметка: среди сломанного была доставка в Telegram. Отсутствие
// отказов её не чинит — Alertmanager может просто не иметь, что отправлять.
// Снимаем только когда в окне есть успешная отправка.
const TG_PROOF = `${COMPONENT}:tg`;

type Sample = { metric: Record<string, string>; value: [number, string] };
type AlertState = { alerted: boolean; updatedAt: Date | null };

export interface DeliveryInspection {
  problems: string[];
  firing: string[];
  tgFailing: boolean;
  delivered: number; // успешных отправок Alertmanager в Telegram за окно
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const num = (samples: Sample[]) => (samples.length ? Number(samples[0].value[1]) : null);

@Injectable()
export class AlertDeliveryService implements OnModuleInit {
  private readonly log = new Logger(AlertDeliveryService.name);
  private consecutiveBad = 0;

  constructor(
    private readonly monitoring: MonitoringService,
    private readonly pg: PgService,
  ) {}

  async onModuleInit() {
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
  async inspect(): Promise<DeliveryInspection> {
    let amUp: Sample[], amFailed: Sample[], amTotal: Sample[], amDiscovered: Sample[], promErrors: Sample[], alerts: Sample[];
    try {
      [amUp, amFailed, amTotal, amDiscovered, promErrors, alerts] = await Promise.all([
        this.monitoring.query('up{job="alertmanager"}'),
        this.monitoring.query(`sum(increase(alertmanager_notifications_failed_total[${AM_WINDOW_MIN}m]))`),
        this.monitoring.query(`sum(increase(alertmanager_notifications_total[${AM_WINDOW_MIN}m]))`),
        this.monitoring.query('min(prometheus_notifications_alertmanagers_discovered)'),
        this.monitoring.query(`sum(increase(prometheus_notifications_errors_total[${PROM_WINDOW_MIN}m]))`),
        this.monitoring.query('ALERTS{alertstate="firing",severity="page"}'),
      ]);
    } catch (e: any) {
      return {
        problems: [`Prometheus на node-3 не отвечает: ${esc(String(e?.message || e))}. Инфраструктурные алерты сейчас не работают — проверь node-3 и WireGuard (<code>wg show</code> на проде).`],
        firing: [],
        tgFailing: false,
        delivered: 0,
      };
    }

    const problems: string[] = [];
    if (num(amUp) !== 1) {
      problems.push('Alertmanager недоступен для Prometheus (<code>up{job="alertmanager"}</code> ≠ 1) — алерты некому отправлять.');
    }
    const failed = num(amFailed) ?? 0;
    if (failed > 0) {
      problems.push(`Alertmanager не может отправить алерты в Telegram: неудачных отправок за ${AM_WINDOW_MIN} мин — ${Math.round(failed) || 1}. Причина — в <code>docker logs alertmanager</code> на node-3.`);
    }
    if ((num(amDiscovered) ?? 0) < 1) {
      problems.push('Prometheus не видит Alertmanager — алерты не уходят дальше Prometheus.');
    }
    if ((num(promErrors) ?? 0) > 0) {
      problems.push('Prometheus не может передать алерты в Alertmanager (растёт <code>prometheus_notifications_errors_total</code>).');
    }
    const firing = alerts.map((a) => `${a.metric.alertname || '?'}${a.metric.instance ? ` — ${a.metric.instance}` : ''}`);
    return { problems, firing, tgFailing: failed > 0, delivered: (num(amTotal) ?? 0) - failed };
  }

  async check(): Promise<void> {
    // На test-стенде Telegram для алертов не настроен — и опрашивать незачем.
    if (!telegramConfigured()) return;

    const { problems, firing, tgFailing, delivered } = await this.inspect();
    this.consecutiveBad = problems.length ? this.consecutiveBad + 1 : 0;
    // Не прочитали состояние — не знаем, сообщали ли уже. Без него кулдаун не
    // работает и алерт уходил бы каждые 5 минут, поэтому тик пропускаем.
    const state = await this.getState(COMPONENT);
    if (!state) return;

    if (problems.length && this.consecutiveBad >= ALERT_AFTER_CHECKS) {
      const cooled = !state.updatedAt || Date.now() - state.updatedAt.getTime() >= REALERT_HOURS * 3600_000;
      if (state.alerted && !cooled) return;
      await sendTelegramAlert(
        `🔕 <b>Алерты инфраструктуры не доходят</b>\n` +
        problems.map((p) => `• ${p}`).join('\n') +
        (firing.length ? `\n\nСейчас горят: ${firing.map(esc).join('; ')}` : '') +
        `\n\nЭто запасной путь — сообщение отправил бэкенд прода в обход Alertmanager.`,
      );
      await this.setAlerted(COMPONENT, true);
      if (tgFailing) await this.setAlerted(TG_PROOF, true);
      this.log.warn(`alert delivery broken: ${problems.join(' | ')}`);
    } else if (!problems.length && state.alerted) {
      const proof = await this.getState(TG_PROOF);
      if (!proof) return;
      // Доставка в Telegram была сломана — ждём настоящей успешной отправки.
      if (proof.alerted && !(delivered > 0.5)) return;
      await sendTelegramAlert(
        `🔔 <b>Алерты инфраструктуры снова доходят</b>\n` +
        (proof.alerted
          ? 'Alertmanager снова успешно отправляет в Telegram.'
          : 'Prometheus и Alertmanager снова в порядке.'),
      );
      await this.setAlerted(COMPONENT, false);
      if (proof.alerted) await this.setAlerted(TG_PROOF, false);
      this.log.log('alert delivery recovered');
    }
  }

  /** null — состояние прочитать не удалось. */
  private async getState(component: string): Promise<AlertState | null> {
    try {
      const r = await this.pg.query(`SELECT alerted, updated_at FROM monitor_alert_state WHERE component=$1`, [component]);
      const row = r.rows[0];
      return { alerted: row?.alerted === true, updatedAt: row?.updated_at ? new Date(row.updated_at) : null };
    } catch (e: any) {
      this.log.error(`getState(${component}) failed: ${e.message}`);
      return null;
    }
  }

  private async setAlerted(component: string, alerted: boolean): Promise<void> {
    try {
      await this.pg.query(
        `INSERT INTO monitor_alert_state (component, alerted, updated_at) VALUES ($1,$2,now())
         ON CONFLICT (component) DO UPDATE SET alerted=$2, updated_at=now()`,
        [component, alerted],
      );
    } catch (e: any) { this.log.error(`setAlerted(${component}) failed: ${e.message}`); }
  }
}
