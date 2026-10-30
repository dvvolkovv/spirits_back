import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import axios from 'axios';
import { PgService } from '../common/services/pg.service';
import { sendTelegramPayload } from '../common/telegram-alert';

/** Поле qwen в /health релея (relay-agent/qwen-provider.mjs, stats()). */
export interface RelayQwenHealth {
  enabled: boolean;
  ok: number;
  failed: number;
  windowMs: number;
  breakerOpenUntil: number;
  /** Когда окно предохранителя открывалось последний раз (0 — никогда). */
  lastOpenedAt?: number;
  /** Когда Claude последний раз ответил успешно (0 — никогда). */
  lastClaudeOkAt?: number;
}

/**
 * active — релей сейчас отвечает через запасной Qwen (окно открыто, или были
 * аварийные ходы за окно статистики, или Claude с момента последнего сбоя ни
 * разу не ответил); idle — нет; unknown — /health не ответил или релей старый
 * (поля qwen нет). Принудительные ходы (выбор пользователя) релей в эти
 * счётчики не пишет.
 *
 * breakerOpenUntil сравнивается с нулём, а не с часами бэкенда: окно на
 * релее закрывается само через breakerMs (5 мин), и релей сам обнуляет
 * поле в stats(), когда оно истекло (qwen-provider.mjs). Сверка с `now`
 * бэкенда была причиной ложного отбоя: окно истекало раньше, чем Claude
 * успевал ответить хотя бы раз (редкие ходы ночью) — third условие
 * (lastOpenedAt/lastClaudeOkAt) ловит именно этот случай.
 */
export function relayFallbackVerdict(health: any, now: number = Date.now()): 'active' | 'idle' | 'unknown' {
  const qw = health?.qwen;
  if (!qw || typeof qw !== 'object') return 'unknown';
  const ok = Number(qw.ok) || 0;
  const failed = Number(qw.failed) || 0;
  const breakerOpenUntil = Number(qw.breakerOpenUntil) || 0;
  const lastOpenedAt = Number(qw.lastOpenedAt) || 0;
  const lastClaudeOkAt = Number(qw.lastClaudeOkAt) || 0;
  if (breakerOpenUntil > 0) return 'active';
  if (ok + failed > 0) return 'active';
  // Брейкер в памяти релея пустой и сразу после рестарта процесса — тот же
  // набор нулей, что и у «окно никогда не открывалось, всё тихо»: отличить их
  // нельзя. Различимо от старого релея (который поля lastClaudeOkAt вовсе не
  // отдаёт) — только по наличию самого поля. В обычной работе лишние минуты
  // unknown закрываются первыми пробами/ходами после рестарта.
  if ('lastClaudeOkAt' in qw && lastOpenedAt === 0 && lastClaudeOkAt === 0 && ok === 0 && failed === 0 && breakerOpenUntil === 0) {
    return 'unknown';
  }
  if (lastOpenedAt > 0 && !(lastClaudeOkAt >= lastOpenedAt)) return 'active';
  return 'idle';
}

export function relayFallbackAlertText(qw: RelayQwenHealth): string {
  const mins = Math.round((Number(qw.windowMs) || 900_000) / 60_000);
  // <code>, не обратные кавычки: Telegram в parse_mode: 'HTML' их не раскрывает,
  // буквальные `claude` уходили бы читателю как есть.
  const fixLine = 'Починка: на релее <code>claude</code> → /login, либо ждать сброса лимита подписки.';
  const ok = Number(qw.ok) || 0;
  const failed = Number(qw.failed) || 0;
  const breakerOpenUntil = Number(qw.breakerOpenUntil) || 0;
  const lastOpenedAt = Number(qw.lastOpenedAt) || 0;
  const lastClaudeOkAt = Number(qw.lastClaudeOkAt) || 0;
  // Активность определена только третьим условием verdict'а: ходов не было
  // ни на Claude (lastClaudeOkAt < lastOpenedAt), ни на Qwen (ok=failed=0), а
  // окно само истекло (breakerOpenUntil=0) — «ответов 0, ошибок 0» в этом
  // случае бессмысленный шум, важно само «Claude молчит с момента сбоя».
  if (ok === 0 && failed === 0 && breakerOpenUntil === 0 && lastOpenedAt > 0 && !(lastClaudeOkAt >= lastOpenedAt)) {
    return `<b>🟠 Релей: Claude не отвечал с момента сбоя — запасной Qwen за ${mins} мин не понадобился</b>\n${fixLine}`;
  }
  // ok === 0 && failed > 0: Qwen сам не отвечает — «отвечают через Qwen» было
  // бы неверно, людям важно знать, что молчат оба пути.
  const bothDown = ok === 0 && failed > 0;
  const title = bothDown
    ? '🔴 Релей: Claude недоступен, запасной Qwen тоже не отвечает'
    : '🟠 Релей: Claude недоступен — ассистенты отвечают через запасной Qwen';
  return `<b>${title}</b>\n` +
    `Qwen за ${mins} мин: ответов ${qw.ok}, ошибок ${qw.failed}.\n` +
    fixLine;
}

const COMPONENT = 'relay_qwen_fallback';

/**
 * Запасной Qwen на релее не должен прятать сбой Claude: раз в 15 минут читаем
 * /health релея и шлём алерт в начале аварийного режима и отбой в конце
 * (spec 2026-10-30-llm-provider-switch, «Мониторинг»). Антиповтор — та же
 * таблица monitor_alert_state, что у алерта CLI.
 */
@Injectable()
export class RelayQwenMonitorService {
  private readonly log = new Logger(RelayQwenMonitorService.name);

  constructor(private readonly pg: PgService) {}

  @Cron('30 */15 * * * *')
  async tick(): Promise<void> {
    await this.check();
  }

  async check(now: number = Date.now()): Promise<'active' | 'idle' | 'unknown'> {
    // test.linkeon.io: AGENT_URL там указывает на боевой релей (нет своего
    // стенда) — без выключателя test дублировал бы алерты прода.
    if ((process.env.RELAY_QWEN_MONITOR || '').toLowerCase() === 'off') return 'unknown';
    const base = (process.env.AGENT_URL || 'https://r.linkeon.io').replace(/\/+$/, '');
    let health: any = null;
    try {
      health = (await axios.get(`${base}/health`, { timeout: 10_000 })).data;
    } catch (e: any) {
      this.log.warn(`relay /health недоступен: ${e?.message}`);
    }
    const verdict = relayFallbackVerdict(health, now);
    if (verdict === 'unknown') return verdict;
    const alerted = await this.getAlerted();
    if (verdict === 'active' && !alerted) {
      await this.send(relayFallbackAlertText(health.qwen));
      await this.setAlerted(true);
      this.log.error('relay: Claude недоступен, ходы идут через запасной Qwen — алерт отправлен');
    } else if (verdict === 'idle' && alerted) {
      await this.send('<b>🟢 Релей: Claude снова отвечает</b>\nЗапасной Qwen за последние 15 мин не понадобился.');
      await this.setAlerted(false);
      this.log.warn('relay: запасной Qwen больше не нужен — отбой отправлен');
    }
    return verdict;
  }

  private async getAlerted(): Promise<boolean> {
    try {
      const r = await this.pg.query('SELECT alerted FROM monitor_alert_state WHERE component=$1', [COMPONENT]);
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
    } catch (e: any) { this.log.error(`setAlerted(${COMPONENT}) failed: ${e.message}`); }
  }

  private async send(text: string): Promise<void> {
    const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
    const TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';
    if (!TG_TOKEN || !TG_CHAT) { this.log.warn(`relay qwen alert (no Telegram creds): ${text.replace(/<[^>]+>/g, '')}`); return; }
    try {
      await sendTelegramPayload({ chat_id: TG_CHAT, parse_mode: 'HTML', text }, { timeout: 8000 });
    } catch (e: any) {
      this.log.error(`relay qwen Telegram alert failed: ${e?.message || 'unknown'}`);
    }
  }
}
