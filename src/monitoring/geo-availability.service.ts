import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import axios from 'axios';
import { PgService } from '../common/services/pg.service';
import { sendTelegramPayload, telegramConfigured } from '../common/telegram-alert';

/**
 * Гео-доступность лендинга linkeon.io из РАЗНЫХ локаций (в первую очередь RU).
 *
 * Зачем: наш Prometheus/synthetic бьёт из своей инфры — одна точка обзора, и не
 * поймает «у пользователя в регионе X лендинг не открывается» (блок РКН, кривой
 * маршрут провайдера, DNS-фильтр). А такой юзер невидим в воронке (нет даже
 * landing_view) — мы просто теряем платный трафик молча.
 *
 * Как: каждые 15 мин дёргаем бесплатный Globalping (api.globalping.io) — HTTP-
 * проверку linkeon.io из нескольких RU-точек + 1 зарубежной (baseline). Если из
 * ≥2 RU-точек сайт недоступен, А baseline жив (значит origin в порядке, проблема
 * RU-сторонняя) — алертим в Telegram с авто-диагностикой (traceroute+DNS из тех
 * же точек). Анти-флейк: K подряд провалов; состояние алерта в monitor_alert_state.
 */
const GP_API = 'https://api.globalping.io/v1';
const TARGET = 'linkeon.io';
const RU_LIMIT = 5;                 // сколько RU-точек запрашиваем
const MIN_RU_FAILS = 2;             // ≥ этого числа упавших RU-точек = «недоступно из RU»
const ALERT_AFTER_FAILS = 2;        // K подряд провалов до алерта (анти-флейк блипов)
const COMPONENT = 'geo_linkeon';

interface ProbeOutcome {
  country: string | null;
  city: string | null;
  network: string | null;
  asn: number | null;
  ok: boolean;
  statusCode: number | null;
  reason: string | null;
}

@Injectable()
export class GeoAvailabilityService implements OnModuleInit {
  private readonly log = new Logger(GeoAvailabilityService.name);
  private consecutiveFails = 0;
  private last: any = null;

  constructor(private readonly pg: PgService) {}

  async onModuleInit() {
    try {
      await this.pg.query(
        `CREATE TABLE IF NOT EXISTS geo_availability_checks (
           id          bigserial PRIMARY KEY,
           checked_at  timestamptz NOT NULL DEFAULT now(),
           target      text NOT NULL,
           ru_total    int NOT NULL,
           ru_ok       int NOT NULL,
           ru_failed   int NOT NULL,
           baseline_ok boolean,
           region_down boolean NOT NULL,
           probes      jsonb NOT NULL
         )`,
      );
    } catch (e: any) {
      this.log.error(`geo_availability_checks migration failed: ${e.message}`);
    }
  }

  private gpHeaders() {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (process.env.GLOBALPING_TOKEN) h.Authorization = `Bearer ${process.env.GLOBALPING_TOKEN}`;
    return h;
  }

  // Создаёт измерение и поллит результат до завершения (или таймаута).
  private async measure(type: 'http' | 'traceroute' | 'dns', locations: any[], limit: number, opts?: any): Promise<any[]> {
    const body: any = { type, target: TARGET, locations, limit };
    if (opts) body.measurementOptions = opts;
    const created = await axios.post(`${GP_API}/measurements`, body, { headers: this.gpHeaders(), timeout: 15000 });
    const id = created.data?.id;
    if (!id) return [];
    // poll
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const res = await axios.get(`${GP_API}/measurements/${id}`, { headers: this.gpHeaders(), timeout: 15000 });
      if (res.data?.status === 'finished') return res.data.results || [];
    }
    return [];
  }

  private parseHttp(results: any[]): ProbeOutcome[] {
    return results.map((r: any) => {
      const p = r.probe || {};
      const res = r.result || {};
      const code = typeof res.statusCode === 'number' ? res.statusCode : null;
      const ok = res.status === 'finished' && code != null && code >= 200 && code < 400;
      return {
        country: p.country ?? null,
        city: p.city ?? null,
        network: p.network ?? null,
        asn: p.asn ?? null,
        ok,
        statusCode: code,
        reason: ok ? null : (res.status === 'failed' ? 'unreachable/timeout' : (code != null ? `HTTP ${code}` : 'no response')),
      };
    });
  }

  @Cron('30 */15 * * * *')
  async tick() {
    await this.run().catch((e) => this.log.error(`geo check failed: ${e.message}`));
  }

  async run(): Promise<void> {
    // 1. RU-точки + 1 baseline (зарубежная) одним заходом каждый.
    let ruRes: any[] = [];
    let baseRes: any[] = [];
    try {
      ruRes = await this.measure('http', [{ country: 'RU' }], RU_LIMIT, { protocol: 'HTTPS', request: { method: 'HEAD', path: '/' } });
      baseRes = await this.measure('http', [{ country: 'NL' }], 1, { protocol: 'HTTPS', request: { method: 'HEAD', path: '/' } });
    } catch (e: any) {
      this.log.warn(`globalping http measure failed: ${e?.response?.status || ''} ${e.message}`);
      return; // не алертим, если сам globalping недоступен (это не наш сайт)
    }
    const ru = this.parseHttp(ruRes);
    const base = this.parseHttp(baseRes);
    if (ru.length === 0) { this.log.warn('geo check: no RU probes returned'); return; }

    const ruOk = ru.filter((p) => p.ok).length;
    const ruFailed = ru.length - ruOk;
    const baselineOk = base.length > 0 ? base.some((p) => p.ok) : null;
    // «RU недоступен» только если ≥MIN_RU_FAILS RU-точек легли И baseline жив
    // (если baseline тоже лёг — это не RU-специфика: либо origin down [ловит наш
    // мониторинг], либо проблема самого globalping — не наш ложный RU-алерт).
    const regionDown = ruFailed >= MIN_RU_FAILS && baselineOk !== false;

    const summary = {
      checked_at: new Date(Date.now()).toISOString(),
      target: TARGET,
      ru_total: ru.length, ru_ok: ruOk, ru_failed: ruFailed,
      baseline_ok: baselineOk, region_down: regionDown,
      probes: ru.map((p) => ({ city: p.city, network: p.network, asn: p.asn, ok: p.ok, statusCode: p.statusCode, reason: p.reason })),
    };
    this.last = summary;
    try {
      await this.pg.query(
        `INSERT INTO geo_availability_checks (target, ru_total, ru_ok, ru_failed, baseline_ok, region_down, probes)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        [TARGET, ru.length, ruOk, ruFailed, baselineOk, regionDown, JSON.stringify(summary.probes)],
      );
    } catch (e: any) { this.log.warn(`geo check persist failed: ${e.message}`); }

    if (regionDown) this.consecutiveFails++; else this.consecutiveFails = 0;
    await this.maybeAlert(regionDown, ru);
  }

  private async getAlerted(): Promise<boolean> {
    try {
      const r = await this.pg.query(`SELECT alerted FROM monitor_alert_state WHERE component=$1`, [COMPONENT]);
      return r.rows[0]?.alerted === true;
    } catch { return false; }
  }
  private async setAlerted(alerted: boolean): Promise<void> {
    try {
      await this.pg.query(
        `INSERT INTO monitor_alert_state (component, alerted, updated_at) VALUES ($1,$2,now())
         ON CONFLICT (component) DO UPDATE SET alerted=$2, updated_at=now()`,
        [COMPONENT, alerted],
      );
    } catch (e: any) { this.log.error(`geo setAlerted failed: ${e.message}`); }
  }

  private async maybeAlert(regionDown: boolean, ru: ProbeOutcome[]): Promise<void> {
    if (!telegramConfigured()) return;
    const alerted = await this.getAlerted();
    if (regionDown && this.consecutiveFails >= ALERT_AFTER_FAILS && !alerted) {
      const failed = ru.filter((p) => !p.ok);
      const diag = await this.autoDiagnose().catch(() => '');
      const lines = failed.slice(0, 6).map((p) => `• ${p.city || '?'} / ${p.network || 'ASN' + p.asn}: ${p.reason}`);
      const text =
        `🌍🔴 <b>linkeon.io недоступен из России</b>\n` +
        `Из ${ru.length} RU-точек упало ${failed.length} (baseline за рубежом — жив, значит origin в порядке → проблема RU-стороны: блок/маршрут/DNS).\n\n` +
        lines.join('\n') +
        (diag ? `\n\n<b>Авто-диагностика:</b>\n${diag}` : '');
      await sendTelegramPayload({ parse_mode: 'HTML', text }, { timeout: 10000 }).catch(() => {});
      await this.setAlerted(true);
      this.log.warn(`geo ALERT: linkeon.io down from ${failed.length}/${ru.length} RU probes`);
    } else if (!regionDown && alerted) {
      await sendTelegramPayload({ parse_mode: 'HTML', text: `🌍🟢 <b>linkeon.io снова доступен из России</b> (все RU-точки отвечают).` }, { timeout: 8000 }).catch(() => {});
      await this.setAlerted(false);
      this.log.log('geo RECOVERY: linkeon.io reachable from RU again');
    }
  }

  // Авто-диагностика из RU: traceroute (где умирает маршрут) + DNS (резолвится ли домен).
  private async autoDiagnose(): Promise<string> {
    const out: string[] = [];
    try {
      const tr = this.parseTrace(await this.measure('traceroute', [{ country: 'RU' }], 2, { protocol: 'ICMP' }));
      if (tr) out.push(`traceroute: ${tr}`);
    } catch { /* ignore */ }
    try {
      const dns = await this.measure('dns', [{ country: 'RU' }], 2, { request: { type: 'A' } });
      const resolved = dns.map((r: any) => {
        const ans = (r.result?.answers || []).filter((a: any) => a.type === 'A').map((a: any) => a.value);
        return `${r.probe?.city || '?'}: ${ans.length ? ans.join(',') : 'НЕ резолвится'}`;
      });
      if (resolved.length) out.push(`DNS(A): ${resolved.join(' | ')}`);
    } catch { /* ignore */ }
    return out.join('\n');
  }

  private parseTrace(results: any[]): string {
    if (!results.length) return '';
    const r = results[0];
    const hops = r.result?.hops || [];
    const reached = hops.length ? `${hops.length} хопов, последний: ${hops[hops.length - 1]?.resolvedAddress || hops[hops.length - 1]?.resolvedHostname || '?'}` : 'нет хопов';
    return `${r.probe?.city || '?'}: ${reached}`;
  }

  async getLatest(): Promise<any> {
    if (this.last) return this.last;
    try {
      const r = await this.pg.query(`SELECT checked_at, target, ru_total, ru_ok, ru_failed, baseline_ok, region_down, probes FROM geo_availability_checks ORDER BY checked_at DESC LIMIT 1`);
      return r.rows[0] ?? null;
    } catch { return null; }
  }
}
