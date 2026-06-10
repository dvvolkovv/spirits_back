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
const CRITICAL_SCENARIOS = (process.env.SYNTHETIC_CRITICAL_SCENARIOS || 'chat_streaming,auth_refresh')
  .split(',').map((s) => s.trim()).filter(Boolean);
// Если раннер (node-3 cron) перестал слать результаты дольше этого — мониторинг
// «ослеп», тоже алертим.
const STALE_MINUTES = Number(process.env.SYNTHETIC_STALE_MINUTES || 40);
const REALERT_HOURS = Number(process.env.SYNTHETIC_REALERT_H || 3);

/**
 * Synthetic E2E results.
 *
 * Cron job on node-3 runs ./scripts/synthetic-runner.js every N minutes,
 * exercising critical paths against my.linkeon.io. Each scenario result
 * is POSTed back to /webhook/admin/monitoring/synthetic/push with the
 * shared SYNTHETIC_PUSH_TOKEN.
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
  @Cron('0 */15 * * * *')
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
    const newest = overview.scenarios
      .map((s) => (s.latestTs ? new Date(s.latestTs).getTime() : 0))
      .reduce((a, b) => Math.max(a, b), 0);
    const ageMin = newest ? (now.getTime() - newest) / 60000 : Infinity;
    if (ageMin > STALE_MINUTES) {
      const staleCooled = !this.lastStaleAlertAt || (now.getTime() - this.lastStaleAlertAt.getTime()) >= REALERT_HOURS * 3600_000;
      if (staleCooled) {
        await send(`<b>🟠 Синтетический мониторинг «ослеп»</b>\nНет результатов уже ${Math.round(ageMin)} мин (порог ${STALE_MINUTES}). Раннер на node-3, возможно, не работает — продуктовые сбои сейчас можно не заметить.`);
        this.lastStaleAlertAt = now;
      }
    } else {
      this.lastStaleAlertAt = null;
    }

    // 2. Критичные сценарии: падение → алерт, восстановление → отбой.
    for (const s of overview.scenarios) {
      if (!CRITICAL_SCENARIOS.includes(s.scenario)) continue;
      const ok = s.latestSuccess === true;
      const prev = this.lastStatus.get(s.scenario);
      if (!ok && (prev !== false || cooled(s.scenario))) {
        const label = s.scenario === 'chat_streaming' ? 'AI-чат (r.linkeon.io)' : s.scenario;
        await send(
          `<b>🔴 Synthetic: критичный сценарий упал</b>\n` +
          `Сценарий: <b>${label}</b>\n` +
          `Ошибка: ${s.latestMessage ? String(s.latestMessage).slice(0, 160) : '—'}\n` +
          `Успех за 24ч: ${s.successRate24hPct != null ? s.successRate24hPct.toFixed(0) + '%' : '—'} · проверка: ${s.latestTs || '—'}`,
        );
        this.lastAlertAt.set(s.scenario, now);
      } else if (ok && prev === false) {
        await send(`<b>🟢 Synthetic: «${s.scenario}» восстановлен</b>\nСнова отвечает (проверка: ${s.latestTs || '—'}).`);
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
