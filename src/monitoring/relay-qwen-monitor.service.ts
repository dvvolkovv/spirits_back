import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import axios from 'axios';
import { PgService } from '../common/services/pg.service';
import { sendTelegramPayload } from '../common/telegram-alert';
import { FALLBACK_ORDER, FallbackProvider, PROVIDER_LABELS } from '../common/services/llm-fallback';

/** Запасной провайдер в /health релея. */
export interface RelayProviderHealth {
  enabled: boolean;
  ok: number;
  failed: number;
  downUntil?: number;
}

/**
 * Запасной путь релея из /health: поле fallback (relay-agent/llm-fallback.mjs,
 * stats()), а у релея до выката Kimi — прежнее поле qwen (только Qwen).
 */
export interface RelayFallbackHealth {
  windowMs: number;
  /** Окно Claude открыто до (0 — закрыто; релей сам обнуляет истёкшее). */
  breakerOpenUntil: number;
  /** Когда окно Claude открывалось последний раз (0 — никогда). */
  lastOpenedAt: number;
  /** Когда Claude последний раз ответил; undefined — релей поле не отдаёт (старый). */
  lastClaudeOkAt?: number;
  providers: Partial<Record<FallbackProvider, RelayProviderHealth>>;
}

const num = (v: unknown): number => Number(v) || 0;

/** null — в /health нет ни fallback, ни qwen (релей без запасного пути или не ответил). */
export function readRelayFallback(health: any): RelayFallbackHealth | null {
  const fb = health?.fallback;
  if (fb && typeof fb === 'object') {
    const providers: Partial<Record<FallbackProvider, RelayProviderHealth>> = {};
    for (const n of FALLBACK_ORDER) {
      const p = fb.providers?.[n];
      if (p && typeof p === 'object') {
        providers[n] = { enabled: p.enabled === true, ok: num(p.ok), failed: num(p.failed), downUntil: num(p.downUntil) };
      }
    }
    return {
      windowMs: num(fb.windowMs) || 900_000,
      breakerOpenUntil: num(fb.breakerOpenUntil),
      lastOpenedAt: num(fb.lastOpenedAt),
      lastClaudeOkAt: 'lastClaudeOkAt' in fb ? num(fb.lastClaudeOkAt) : undefined,
      providers,
    };
  }
  const qw = health?.qwen;
  if (qw && typeof qw === 'object') {
    return {
      windowMs: num(qw.windowMs) || 900_000,
      breakerOpenUntil: num(qw.breakerOpenUntil),
      lastOpenedAt: num(qw.lastOpenedAt),
      lastClaudeOkAt: 'lastClaudeOkAt' in qw ? num(qw.lastClaudeOkAt) : undefined,
      providers: { qwen: { enabled: qw.enabled === true, ok: num(qw.ok), failed: num(qw.failed) } },
    };
  }
  return null;
}

function totals(fb: RelayFallbackHealth): { ok: number; failed: number } {
  let ok = 0;
  let failed = 0;
  for (const n of FALLBACK_ORDER) {
    ok += fb.providers[n]?.ok ?? 0;
    failed += fb.providers[n]?.failed ?? 0;
  }
  return { ok, failed };
}

/**
 * active — релей сейчас отвечает через запасных (окно Claude открыто, или были
 * аварийные ходы за окно статистики, или Claude с момента последнего сбоя ни
 * разу не ответил); idle — нет; unknown — /health не ответил или в нём нет
 * запасного пути. Ходы по выбору пользователя релей в эти счётчики не пишет.
 *
 * breakerOpenUntil сравнивается с нулём, а не с часами бэкенда: окно на релее
 * закрывается само через 5 мин, и релей сам обнуляет поле, когда оно истекло.
 * Сверка с часами бэкенда давала ложный отбой: окно истекало раньше, чем Claude
 * успевал ответить хотя бы раз (редкие ходы ночью) — третье условие
 * (lastOpenedAt/lastClaudeOkAt) ловит именно этот случай.
 */
export function relayFallbackVerdict(health: any, _now: number = Date.now()): 'active' | 'idle' | 'unknown' {
  const fb = readRelayFallback(health);
  if (!fb) return 'unknown';
  const { ok, failed } = totals(fb);
  if (fb.breakerOpenUntil > 0) return 'active';
  if (ok + failed > 0) return 'active';
  // Состояние в памяти релея пустое и сразу после рестарта процесса — тот же
  // набор нулей, что у «окно никогда не открывалось»: отличить нельзя. От
  // старого релея (поля lastClaudeOkAt нет вовсе) — только по наличию поля.
  if (fb.lastClaudeOkAt !== undefined && fb.lastOpenedAt === 0 && fb.lastClaudeOkAt === 0) return 'unknown';
  if (fb.lastOpenedAt > 0 && !((fb.lastClaudeOkAt ?? 0) >= fb.lastOpenedAt)) return 'active';
  return 'idle';
}

/** «Qwen: ответов N, ошибок M · Kimi: не настроен». */
function providersLine(fb: RelayFallbackHealth): string {
  return FALLBACK_ORDER.map((n) => {
    const p = fb.providers[n];
    return p?.enabled ? `${PROVIDER_LABELS[n]}: ответов ${p.ok}, ошибок ${p.failed}` : `${PROVIDER_LABELS[n]}: не настроен`;
  }).join(' · ');
}

export function relayFallbackAlertText(fb: RelayFallbackHealth): string {
  const mins = Math.round(fb.windowMs / 60_000);
  // <code>, не обратные кавычки: Telegram в parse_mode: 'HTML' их не раскрывает.
  const fixLine = 'Починка: на релее <code>claude</code> → /login, либо ждать сброса лимита подписки.';
  const { ok, failed } = totals(fb);
  // Активность только по «Claude молчит с момента сбоя»: ходов не было ни на
  // Claude, ни на запасных, окно само истекло — счётчики были бы шумом.
  if (ok === 0 && failed === 0 && fb.breakerOpenUntil === 0 && fb.lastOpenedAt > 0 && !((fb.lastClaudeOkAt ?? 0) >= fb.lastOpenedAt)) {
    return `<b>🟠 Релей: Claude не отвечал с момента сбоя — запасные за ${mins} мин не понадобились</b>\n${fixLine}`;
  }
  // Ответов ноль, ошибки есть: молчат все пути — «отвечают через запасные» было бы неправдой.
  const allDown = ok === 0 && failed > 0;
  const title = allDown
    ? '🔴 Релей: Claude недоступен, запасные тоже не отвечают'
    : '🟠 Релей: Claude недоступен — ассистенты отвечают через запасные';
  return `<b>${title}</b>\n${providersLine(fb)} за ${mins} мин.\n${fixLine}`;
}

const COMPONENT = 'relay_qwen_fallback';

/**
 * Запасные на релее не должны прятать сбой Claude: раз в 15 минут читаем
 * /health релея и шлём алерт в начале аварийного режима и отбой в конце
 * (spec 2026-10-30-llm-provider-switch, 2026-10-31-kimi-provider-design).
 * Антиповтор — та же таблица monitor_alert_state, что у алерта CLI; имена
 * компонента и выключателя прежние.
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
      await this.send(relayFallbackAlertText(readRelayFallback(health)!));
      await this.setAlerted(true);
      this.log.error('relay: Claude недоступен, ходы идут через запасных — алерт отправлен');
    } else if (verdict === 'idle' && alerted) {
      await this.send('<b>🟢 Релей: Claude снова отвечает</b>\nЗапасные за последние 15 мин не понадобились.');
      await this.setAlerted(false);
      this.log.warn('relay: запасные больше не нужны — отбой отправлен');
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
    if (!TG_TOKEN || !TG_CHAT) { this.log.warn(`relay fallback alert (no Telegram creds): ${text.replace(/<[^>]+>/g, '')}`); return; }
    try {
      await sendTelegramPayload({ chat_id: TG_CHAT, parse_mode: 'HTML', text }, { timeout: 8000 });
    } catch (e: any) {
      this.log.error(`relay fallback Telegram alert failed: ${e?.message || 'unknown'}`);
    }
  }
}
