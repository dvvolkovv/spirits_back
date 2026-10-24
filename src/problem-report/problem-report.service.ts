import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { sendTelegramAlert, telegramConfigured } from '../common/telegram-alert';
import { failureSignature, isUserSideToolError } from './problem-classify';
import {
  clip, FALLBACK_NAME, formatToolCapNotice, formatToolFailure, head, oneLine, Repeats,
} from './problem-format';

/** Подсказка ассистенту в результате инструмента, когда команда уже знает о сбое. */
export const SUPPORT_NOTE =
  'Команда Linkeon уже получила сообщение об этом сбое. Скажи пользователю простыми словами, ' +
  'что не получилось и что команда в курсе. Срок починки не обещай.';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

interface Incident {
  lastSentAt: number;
  lastSeenAt: number;
  repeats: number;
  users: Set<string>;
}

/** Положительное число из .env или значение по умолчанию. */
function envNumber(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Сообщения о сбоях ассистентов в группу «Поддержка linkeon».
 * Спека: docs/superpowers/specs/2026-10-24-assistant-problem-reports-design.md.
 *
 * Состояние (склейка, счётчики, лимиты) — в памяти процесса: linkeon-api —
 * один экземпляр, так же живут QualityMonitorService и activeTurns. Рестарт
 * его обнуляет; худшее последствие — одно лишнее сообщение после выката.
 *
 * Отправка никогда не задерживает и не роняет ответ инструмента: решение
 * синхронное, имя ассистента и Telegram — без ожидания.
 */
@Injectable()
export class ProblemReportService {
  private readonly logger = new Logger(ProblemReportService.name);
  private readonly incidents = new Map<string, Incident>();
  /** Моменты сообщений пути А за последний час — для общего потолка. */
  private toolSent: number[] = [];
  /** Когда ушло уведомление «слишком много сбоев» (не чаще раза в час). */
  private capNoticeAt = 0;

  constructor(private readonly pg: PgService) {}

  private cooldownMs(): number {
    return envNumber('PROBLEM_REPORT_COOLDOWN_MIN', 60) * 60_000;
  }

  /**
   * Путь А: инструмент Linkeon ответил ok:false.
   *
   * supportNotified — сказать ли ассистенту «команда в курсе»: да для любого
   * сбоя (отправленного, склеенного с уже отправленным или упёршегося в общий
   * потолок — о потоке сбоев команда получила уведомление), но только если
   * Telegram настроен — иначе команде сообщить нечем.
   */
  reportToolFailure(p: { userId: string; assistantId: string | null; tool: string; error: string }): { supportNotified: boolean } {
    if (isUserSideToolError(p.error)) return { supportNotified: false };
    try {
      const now = Date.now();
      this.forgetOld(now);
      const sig = failureSignature(p.tool, p.error);
      const inc = this.incidents.get(sig);
      if (inc && now - inc.lastSentAt < this.cooldownMs()) {
        inc.repeats++;
        inc.users.add(p.userId);
        inc.lastSeenAt = now;
      } else if (!this.takeToolSlot(now)) {
        // Сверх общего потолка: команда уже получила уведомление о потоке сбоев,
        // этот — только в лог. Подпись не запоминаем: такой же сбой после окна
        // уйдёт обычным сообщением, без ложного «с прошлого сообщения».
        this.logger.warn(`problem-report: сверх потолка, только в лог: ${p.tool}: ${clip(oneLine(head(p.error, 300)), 300)}`);
      } else {
        const repeats: Repeats | null = inc && inc.repeats > 0 ? { count: inc.repeats, users: inc.users.size } : null;
        this.incidents.set(sig, { lastSentAt: now, lastSeenAt: now, repeats: 0, users: new Set() });
        void this.deliver('tool_failure', async () =>
          formatToolFailure({
            assistant: await this.assistantName(p.assistantId),
            tool: p.tool,
            error: p.error,
            userId: p.userId,
            repeats,
          }),
        );
      }
    } catch (e: any) {
      this.logger.warn(`problem-report: сбой ${p.tool} не обработан: ${e?.message}`);
    }
    return { supportNotified: telegramConfigured() };
  }

  /**
   * Общий потолок сообщений пути А в час (PROBLEM_REPORT_TOOL_HOURLY, по
   * умолчанию 20) на все подписи: разные подписи — в том числе намеренно
   * разные, если кто-то зовёт /mcp напрямую, — не засыплют группу. Сверх
   * потолка — одно уведомление в час.
   */
  private takeToolSlot(now: number): boolean {
    this.toolSent = this.toolSent.filter((t) => now - t < HOUR);
    const cap = envNumber('PROBLEM_REPORT_TOOL_HOURLY', 20);
    if (this.toolSent.length < cap) {
      this.toolSent.push(now);
      return true;
    }
    if (now - this.capNoticeAt >= HOUR) {
      this.capNoticeAt = now;
      void this.deliver('tool_failure', async () => formatToolCapNotice(cap));
    }
    return false;
  }

  /** Имя ассистента: agents по числовому id или по имени, custom_agents — по custom:<uuid>. */
  async assistantName(assistantId: string | null): Promise<string> {
    if (!assistantId || !this.pg) return FALLBACK_NAME;
    try {
      if (assistantId.startsWith('custom:')) {
        const r = await this.pg.query('SELECT name FROM custom_agents WHERE id = $1 LIMIT 1', [assistantId.slice('custom:'.length)]);
        return r.rows[0]?.name || FALLBACK_NAME;
      }
      const r = /^\d+$/.test(assistantId)
        ? await this.pg.query('SELECT display_name, name FROM agents WHERE id = $1 LIMIT 1', [parseInt(assistantId, 10)])
        : await this.pg.query('SELECT display_name, name FROM agents WHERE name = $1 LIMIT 1', [assistantId]);
      return r.rows[0]?.display_name || r.rows[0]?.name || FALLBACK_NAME;
    } catch {
      return FALLBACK_NAME;
    }
  }

  /** Собирает текст и шлёт. Не бросает; без Telegram — пишет текст в лог (так на test). */
  private async deliver(kind: 'tool_failure' | 'assistant_report', build: () => Promise<string>): Promise<void> {
    try {
      const text = await build();
      if (!telegramConfigured()) {
        this.logger.log(`problem-report: ${text.replace(/\n/g, ' | ')}`);
        return;
      }
      await sendTelegramAlert(text, { disable_web_page_preview: true });
      this.logger.log(`problem-report: отправлено (${kind})`);
    } catch (e: any) {
      this.logger.warn(`problem-report: не отправлено (${kind}): ${e?.message}`);
    }
  }

  /** Подписи, по которым ничего не было больше суток, — из памяти. */
  private forgetOld(now: number): void {
    for (const [sig, inc] of this.incidents) {
      if (now - inc.lastSeenAt > DAY) this.incidents.delete(sig);
    }
  }
}
