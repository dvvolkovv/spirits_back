import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import axios from 'axios';
import { sendTelegramPayload } from '../common/telegram-alert';
import * as fs from 'fs';
import * as path from 'path';
import { PgService } from '../common/services/pg.service';

// Критичные сценарии: их падение = деградация продукта, алертим немедленно.
// chat_streaming бьёт по /webhook/soulmate/chat (r.linkeon.io) — это и есть
// AI-путь пользователей, который «молча» лёг при недельном лимите подписки.
// Ключ авторизации — `refresh_jwt`, именно его шлёт раннер. До 2026-08-21 здесь
// стоял `auth_refresh`, которого в synthetic_runs не существовало никогда: сбой
// авторизации не алертился напрямую, только рикошетом через chat_streaming.
// site_reachable — главная my.linkeon.io через прокси Selectel, то есть то, что
// видит пользователь. 23.10.2026 прокси заблокировали за неуплату, и без этого
// сценария падение сайта пришло бы алертом про refresh_jwt.
const CRITICAL_SCENARIOS = (process.env.SYNTHETIC_CRITICAL_SCENARIOS || 'site_reachable,chat_streaming,refresh_jwt')
  .split(',').map((s) => s.trim()).filter(Boolean);
// Если раннер (node-3 cron) перестал слать результаты дольше этого — мониторинг
// «ослеп», тоже алертим.
const STALE_MINUTES = Number(process.env.SYNTHETIC_STALE_MINUTES || 40);
const REALERT_HOURS = Number(process.env.SYNTHETIC_REALERT_H || 3);
// Сценарии, которые шлёт внешний раннер (scripts/synthetic-runner.js на node-3).
// Свежесть «жив ли раннер» считается только по ним. Раньше было наоборот — «всё,
// кроме того, что пишет сам бэкенд», — и в список исключений забыли
// chat_quality_probe (QualityMonitorService, каждые 30 минут): с 13.08.2026
// свежесть ни разу не превышала порог, детектор был мёртв. Положительный список
// ломается безопасно: новый in-process сценарий ничего не маскирует, а сценарий
// раннера, не внесённый сюда, просто не участвует в подсчёте. Совпадение с
// раннером проверяет synthetic.stale.spec.ts.
export const RUNNER_SCENARIOS: readonly string[] = [
  'refresh_jwt',
  'site_reachable',
  'agents_endpoint',
  'profile_with_jwt',
  'tokens_balance',
  'chat_streaming',
  'agent_avatar',
];

// Алерт уходит с parse_mode HTML: незнакомый тег в тексте ошибки — 400 от
// Telegram, и алерт пропадает до следующего кулдауна.
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Synthetic E2E results.
 *
 * Cron job on node-3 runs ./scripts/synthetic-runner.js every N minutes,
 * exercising critical paths against my.linkeon.io. Each scenario result
 * is POSTed back to /webhook/monitoring/synthetic/push with the
 * shared SYNTHETIC_PUSH_TOKEN — over WireGuard, not through the proxy it checks.
 *
 * Per-scenario overview takes the latest run + a 24h aggregate so the UI
 * can show: current status, last run time, last error, recent reliability.
 */

export interface ScenarioStatus {
  scenario: string;
  latestSuccess: boolean | null;
  latestTs: string | null;
  latestDurationMs: number | null;
  latestMessage: string | null;
  runs24h: number;
  successes24h: number;
  successRate24hPct: number | null;
}

export interface SyntheticOverview {
  generatedAt: string;
  scenarios: ScenarioStatus[];
}

@Injectable()
export class SyntheticService implements OnModuleInit {
  private readonly log = new Logger(SyntheticService.name);
  // Состояние алертов: статус и время последнего алерта по сценарию + по протуханию.
  private lastStatus = new Map<string, boolean>();
  private lastAlertAt = new Map<string, Date>();
  private lastStaleAlertAt: Date | null = null;

  constructor(@Optional() private readonly pg?: PgService) {}

  // Проверка результатов synthetic + Telegram-алерты. Сам раннер крутится на
  // node-3 и пишет сюда; здесь — реакция на его данные (раньше её не было:
  // synthetic копил статусы, но никто не оповещал о падении).
  // Раннер стартует по */15 и даже при зависшем прокси (все повторы по
  // таймауту) укладывается примерно в 2,5 минуты. Проверка в ту же секунду
  // читала прошлый прогон, и алерт опаздывал до 30 минут — поэтому сдвиг.
  @Cron('0 4,19,34,49 * * * *')
  async checkAndAlert(): Promise<void> {
    if (!this.pg) return;
    let overview: SyntheticOverview;
    try {
      overview = await this.getOverview();
    } catch (e: any) {
      this.log.error(`synthetic alert check failed: ${e.message}`);
      return;
    }
    if (!overview.scenarios.length) return; // нет данных вообще — отдельно не шумим

    const now = new Date();
    const send = async (text: string) => {
      const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
      const TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';
      if (!TG_TOKEN || !TG_CHAT) { this.log.warn(`synthetic alert (no Telegram creds): ${text.replace(/<[^>]+>/g, '')}`); return; }
      try {
        await sendTelegramPayload({ chat_id: TG_CHAT, parse_mode: 'HTML', text }, { timeout: 8000 });
      } catch (e: any) {
        this.log.error(`synthetic Telegram alert failed: ${e?.message || 'unknown'}`);
      }
    };
    const cooled = (key: string) => {
      const at = this.lastAlertAt.get(key);
      return !at || (now.getTime() - at.getTime()) >= REALERT_HOURS * 3600_000;
    };

    // 1. Протухание: самый свежий результat среди всех сценариев старше порога →
    // раннер не шлёт данные, мониторинг ослеп.
    // Внешних результатов нет вообще (свежая среда, раннер ещё не заводили) —
    // молчим, как и при полностью пустой таблице.
    const external = overview.scenarios.filter((s) => RUNNER_SCENARIOS.includes(s.scenario));
    const newest = external
      .map((s) => (s.latestTs ? new Date(s.latestTs).getTime() : 0))
      .reduce((a, b) => Math.max(a, b), 0);
    const ageMin = newest ? (now.getTime() - newest) / 60000 : Infinity;
    if (external.length && ageMin > STALE_MINUTES) {
      const staleCooled = !this.lastStaleAlertAt || (now.getTime() - this.lastStaleAlertAt.getTime()) >= REALERT_HOURS * 3600_000;
      if (staleCooled) {
        await send(`<b>🟠 Синтетический мониторинг «ослеп»</b>\nНет результатов уже ${Math.round(ageMin)} мин (порог ${STALE_MINUTES}). Раннер на node-3, возможно, не работает — продуктовые сбои сейчас можно не заметить.`);
        this.lastStaleAlertAt = now;
      }
    } else {
      this.lastStaleAlertAt = null;
    }

    // Без JWT раннер не выполняет chat_streaming вовсе, но помечает его красным
    // (доступ пользователя действительно сломан). Приписывать такое падение
    // релею нельзя: ярлык «AI-чат (r.linkeon.io)» отправляет дежурного чинить
    // r.linkeon.io, который в этот прогон даже не опрашивался. Определяем это
    // по статусу refresh_jwt, а не по тексту сообщения: текст локализуемый и
    // сопоставление по нему тихо развалится при первом же переводе.
    const authDown = overview.scenarios.some(
      (x) => x.scenario === 'refresh_jwt' && x.latestSuccess === false,
    );
    // Сайт не открывается — через прокси не проходит ничего, и остальные
    // сценарии красные рикошетом. Сообщаем о первопричине, а их статус не
    // трогаем: про их падение мы не сообщали, и «восстановлен» по ним потом
    // был бы ответом на незаданный вопрос.
    // Строка старше порога свежести значит, что раннер сценарий больше не шлёт
    // (на node-3 уже бывала старая копия раннера). По такой строке нельзя ни
    // алертить, ни глушить остальных — глушение стало бы вечным.
    const fresh = (x: ScenarioStatus) =>
      !!x.latestTs && now.getTime() - new Date(x.latestTs).getTime() <= STALE_MINUTES * 60_000;
    const siteDown = overview.scenarios.some(
      (x) => x.scenario === 'site_reachable' && x.latestSuccess === false && fresh(x),
    );

    // 2. Критичные сценарии: падение → алерт, восстановление → отбой.
    for (const s of overview.scenarios) {
      if (!CRITICAL_SCENARIOS.includes(s.scenario)) continue;
      if (s.scenario === 'site_reachable' && !fresh(s)) continue;
      if (siteDown && s.scenario !== 'site_reachable') continue;
      const ok = s.latestSuccess === true;
      const prev = this.lastStatus.get(s.scenario);
      if (!ok && (prev !== false || cooled(s.scenario))) {
        const derived = s.scenario === 'chat_streaming' && authDown;
        const label =
          s.scenario === 'site_reachable' ? 'my.linkeon.io не открывается'
            : s.scenario === 'chat_streaming' && !derived ? 'AI-чат (r.linkeon.io)'
              : s.scenario;
        await send(
          `<b>🔴 Synthetic: критичный сценарий упал</b>\n` +
          `Сценарий: <b>${label}</b>\n` +
          `Ошибка: ${s.latestMessage ? esc(String(s.latestMessage).slice(0, 160)) : '—'}\n` +
          (derived ? `⚠️ Причина не в AI: не прошла авторизация (<b>refresh_jwt</b>), сам чат не проверялся.\n` : '') +
          (s.scenario === 'site_reachable'
            ? `⚠️ Остальные сценарии красные рикошетом. Проверь прокси Selectel 92.53.64.147 (в т.ч. баланс) и прод 212.113.106.202.\n`
            : '') +
          `Успех за 24ч: ${s.successRate24hPct != null ? s.successRate24hPct.toFixed(0) + '%' : '—'} · проверка: ${s.latestTs || '—'}`,
        );
        this.lastAlertAt.set(s.scenario, now);
      } else if (ok && prev === false) {
        const name = s.scenario === 'site_reachable' ? 'my.linkeon.io' : s.scenario;
        await send(`<b>🟢 Synthetic: «${name}» восстановлен</b>\nСнова отвечает (проверка: ${s.latestTs || '—'}).`);
        this.lastAlertAt.delete(s.scenario);
      }
      this.lastStatus.set(s.scenario, ok);
    }
  }

  async onModuleInit() {
    if (!this.pg) return;
    const candidates = [
      path.join(__dirname, 'migrations', '001_synthetic.sql'),
      path.join(__dirname, '..', '..', 'src', 'monitoring', 'migrations', '001_synthetic.sql'),
    ];
    const found = candidates.find((p) => fs.existsSync(p));
    if (!found) {
      this.log.warn('synthetic migration sql not found, skipping');
      return;
    }
    const sql = fs.readFileSync(found, 'utf8');
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        await this.pg.query(sql);
        this.log.log(`synthetic migration applied from ${found}`);
        return;
      } catch (e: any) {
        if (attempt === 5) {
          this.log.error(`synthetic migration failed after 5 attempts: ${e.message}`);
        } else {
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    }
  }

  async record(scenario: string, success: boolean, durationMs: number, message: string | null) {
    if (!this.pg || !scenario) return;
    try {
      await this.pg.query(
        `INSERT INTO synthetic_runs (scenario, success, duration_ms, message)
         VALUES ($1, $2, $3, $4)`,
        [scenario, success, Math.round(durationMs || 0), message ? String(message).slice(0, 500) : null],
      );
    } catch (e: any) {
      this.log.error(`synthetic record failed: ${e.message}`);
    }
  }

  async getOverview(): Promise<SyntheticOverview> {
    if (!this.pg) return { generatedAt: new Date().toISOString(), scenarios: [] };

    // For each scenario: latest run row + 24h aggregates.
    const r = await this.pg.query(
      `WITH latest AS (
         SELECT DISTINCT ON (scenario)
                scenario, ts, success, duration_ms, message
         FROM synthetic_runs
         ORDER BY scenario, ts DESC
       ),
       agg AS (
         SELECT scenario,
                COUNT(*)                                 AS runs,
                COUNT(*) FILTER (WHERE success)          AS successes
         FROM synthetic_runs
         WHERE ts >= now() - interval '24 hours'
         GROUP BY scenario
       )
       SELECT l.scenario,
              l.success                AS latest_success,
              l.ts                     AS latest_ts,
              l.duration_ms            AS latest_duration_ms,
              l.message                AS latest_message,
              COALESCE(a.runs, 0)      AS runs_24h,
              COALESCE(a.successes, 0) AS successes_24h
       FROM latest l
       LEFT JOIN agg a ON a.scenario = l.scenario
       ORDER BY l.scenario`,
    );

    const scenarios: ScenarioStatus[] = r.rows.map((row: any) => {
      const runs = Number(row.runs_24h);
      const succ = Number(row.successes_24h);
      return {
        scenario: row.scenario,
        latestSuccess: row.latest_success,
        latestTs: row.latest_ts instanceof Date ? row.latest_ts.toISOString() : String(row.latest_ts),
        latestDurationMs: row.latest_duration_ms,
        latestMessage: row.latest_message,
        runs24h: runs,
        successes24h: succ,
        successRate24hPct: runs > 0 ? (succ / runs) * 100 : null,
      };
    });
    return { generatedAt: new Date().toISOString(), scenarios };
  }
}
