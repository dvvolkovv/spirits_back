import { createHash } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { sendTelegramAlert, telegramConfigured } from '../common/telegram-alert';
import { failureSignature, isUserSideToolError } from './problem-classify';
import {
  clip, FALLBACK_NAME, formatAssistantCapNotice, formatAssistantReport, formatToolCapNotice, formatToolFailure, head,
  isKnownTool, oneLine, ProblemChannel, ProblemKind, Repeats,
} from './problem-format';

/** Подсказка ассистенту в результате инструмента, когда команда уже знает о сбое. */
export const SUPPORT_NOTE =
  'Команда Linkeon уже получила сообщение об этом сбое. Скажи пользователю простыми словами, ' +
  'что не получилось и что команда в курсе. Срок починки не обещай.';

/** Поле say в ответе report_problem — что сказать пользователю (как у инструмента продуктов). */
export const REPORTED_SAY =
  'Передано команде Linkeon. Скажи пользователю, что передал(а) проблему команде; срок починки не обещай.';
export const BAD_INPUT_SAY =
  'Опиши проблему в summary (1–3 предложения) и укажи kind: my_failure или user_report.';
export const TOO_LONG_SAY =
  'Слишком длинно: опиши проблему в summary короче — 1–3 предложения, до 500 символов.';

/** Куда направить человека, если передать не вышло: на сайте — вкладка, в Telegram её нет. */
function supportHint(channel: ProblemChannel): string {
  return channel === 'telegram' ? 'написать в поддержку Linkeon на support@linkeon.io' : 'написать во вкладку «Поддержка»';
}
export const rateLimitedSay = (c: ProblemChannel) => `Сообщений в поддержку сейчас слишком много. Предложи пользователю ${supportHint(c)}.`;
export const notConfiguredSay = (c: ProblemChannel) => `Передать команде сейчас нечем. Предложи пользователю ${supportHint(c)}.`;
export const failedSay = (c: ProblemChannel) => `Передать команде сейчас не получилось. Предложи пользователю ${supportHint(c)}.`;

export type AssistantReportResult =
  | { ok: true; reported: true; say: string }
  | { ok: false; error: 'bad_input' | 'not_configured' | 'rate_limited' | 'failed'; say: string };

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Сколько разных пользователей помнить в одном сбое: счётчику хватит, памяти — нет. */
const MAX_USERS_PER_INCIDENT = 1000;
const MAX_ID = 64;
const MAX_ERROR = 300;
/** Имя из аргумента модели — до 40 символов, как в заголовке сообщения. */
const MAX_NAME = 40;
/** Пересказ длиннее — отказ сразу: форматтер оставит 500, а огромный текст не должен ни обрабатываться, ни держаться в памяти. */
const MAX_SUMMARY_INPUT = 2000;

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
 * Короткая КОПИЯ чужой строки: одна строка, не длиннее max. Не .slice: в V8
 * (Node 20/22) срез держит в памяти всю исходную строку, а tool и userId на
 * /mcp пишет вызывающий — до 50 МБ на запрос.
 */
function short(s: unknown, max: number): string {
  return clip(oneLine(head(String(s ?? ''), max)), max);
}

/** Ключ склейки фиксированной длины: подпись может оказаться срезом огромной ошибки. */
function incidentKey(tool: string, error: string): string {
  return createHash('sha1').update(failureSignature(tool, error)).digest('base64url');
}

/**
 * Сообщения о сбоях ассистентов в группу «Поддержка linkeon».
 * Спека: docs/superpowers/specs/2026-10-24-assistant-problem-reports-design.md.
 *
 * Состояние (склейка, счётчики, лимиты) — в памяти процесса: linkeon-api —
 * один экземпляр, так же живут QualityMonitorService и activeTurns. Рестарт
 * его обнуляет; худшее последствие — одно лишнее сообщение после выката.
 * Всё, что хранится, ограничено по числу и длине: вход /mcp пишет вызывающий.
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
  /** Моменты сообщений пути Б по пользователям и всего — для лимитов (скользящие окна). */
  private readonly userReports = new Map<string, number[]>();
  private globalReports: number[] = [];
  /** Когда ушло уведомление о каждом общем лимите пути Б: за час — не чаще раза в час, за сутки — раза в сутки. */
  private readonly assistantCapNoticeAt: Record<'global_hour' | 'global_day', number> = { global_hour: 0, global_day: 0 };
  /** Когда ушло уведомление «слишком много сбоев» (не чаще раза в час). */
  private capNoticeAt = 0;
  /** Сколько ждать имя ассистента из базы: у пула нет таймаута запроса, а зависший Postgres не должен держать сообщение. */
  nameTimeoutMs = 2000;

  constructor(private readonly pg: PgService) {}

  private cooldownMs(): number {
    return envNumber('PROBLEM_REPORT_COOLDOWN_MIN', 60) * 60_000;
  }

  /**
   * Путь А: инструмент Linkeon ответил ok:false.
   *
   * supportNotified — сказать ли ассистенту «команда в курсе»: да для любого
   * сбоя (поставленного в отправку, склеенного с уже отправленным или
   * упёршегося в общий потолок — о потоке сбоев команда получила
   * уведомление), но только если Telegram настроен. Если что-то сломалось
   * внутри — false: не обещаем того, чего не сделали.
   */
  reportToolFailure(p: { userId: string; assistantId: string | null; tool: string; error: string }): { supportNotified: boolean } {
    try {
      if (isUserSideToolError(p.error)) return { supportNotified: false };
      const now = Date.now();
      const tool = short(p.tool, MAX_ID);
      const userId = short(p.userId, MAX_ID);
      const error = clip(head(String(p.error ?? ''), MAX_ERROR), MAX_ERROR);
      // Незнакомые имена инструментов — один сбой: модель зовёт только то, что
      // есть в списке /mcp, а поток случайных имён (прямые вызовы /mcp) не
      // должен занимать все слоты потолка и прятать настоящие сбои.
      const key = isKnownTool(tool) ? incidentKey(tool, p.error) : incidentKey('<unknown>', 'unknown tool');
      this.forgetOld(now);
      const inc = this.incidents.get(key);
      // now >= lastSentAt: метка «из будущего» (часы шагнули назад) паузу не продлевает.
      if (inc && now >= inc.lastSentAt && now - inc.lastSentAt < this.cooldownMs()) {
        inc.repeats++;
        if (inc.users.size < MAX_USERS_PER_INCIDENT) inc.users.add(userId);
        inc.lastSeenAt = now;
      } else if (!this.takeToolSlot(now)) {
        // Сверх общего потолка: команда уже получила уведомление о потоке сбоев,
        // этот — только в лог. Подпись не запоминаем: такой же сбой после окна
        // уйдёт обычным сообщением, без ложного «с прошлого сообщения».
        this.logger.warn(`problem-report: сверх потолка, только в лог: ${tool}: ${oneLine(error)}`);
      } else {
        const repeats: Repeats | null = inc && inc.repeats > 0 ? { count: inc.repeats, users: inc.users.size } : null;
        this.incidents.set(key, { lastSentAt: now, lastSeenAt: now, repeats: 0, users: new Set() });
        const assistantId = p.assistantId;
        void this.deliver('tool_failure', async () =>
          formatToolFailure({ assistant: await this.assistantNameWithin(assistantId), tool, error, userId, repeats }),
        );
      }
      return { supportNotified: telegramConfigured() };
    } catch (e: any) {
      this.logger.warn(`problem-report: сбой не обработан: ${e?.message}`);
      return { supportNotified: false };
    }
  }

  /**
   * Путь Б: инструмент report_problem — ассистент сообщает сам. userId и
   * channel — из подписанного токена точки продуктов, assistantId — из хода
   * (у TG-бота его нет), остальное пишет модель. Никогда не бросает.
   */
  async reportFromAssistant(p: {
    userId: string;
    channel: ProblemChannel;
    assistantId: string | null;
    assistantArg: unknown;
    kind: unknown;
    summary: unknown;
  }): Promise<AssistantReportResult> {
    try {
      if (typeof p.summary === 'string' && p.summary.length > MAX_SUMMARY_INPUT) {
        return { ok: false, error: 'bad_input', say: TOO_LONG_SAY };
      }
      const summary = typeof p.summary === 'string' ? p.summary.trim() : '';
      const kind: ProblemKind | null = p.kind === 'my_failure' || p.kind === 'user_report' ? p.kind : null;
      if (!summary || !kind) return { ok: false, error: 'bad_input', say: BAD_INPUT_SAY };
      const userId = short(p.userId, MAX_ID);
      const now = Date.now();
      this.forgetOld(now);
      // Лимиты — и без Telegram (как на проде): тогда текст уйдёт в лог, но не больше лимита.
      const limit = this.takeQuota(userId, now);
      if (limit !== 'ok') {
        this.logger.warn(`problem-report: сообщение ассистента сверх лимита (${limit}), только в лог: ${userId}: ${clip(oneLine(summary), 300)}`);
        if (limit === 'global_hour' || limit === 'global_day') this.noteAssistantCap(now, limit);
        return { ok: false, error: 'rate_limited', say: rateLimitedSay(p.channel) };
      }
      // Короткие копии — в замыкание (summary уже ограничен 2000 символами).
      const arg = typeof p.assistantArg === 'string' ? short(p.assistantArg, MAX_NAME) : '';
      const { assistantId, channel } = p;
      void this.deliver('assistant_report', async () => {
        const fromTurn = assistantId ? await this.assistantNameWithin(assistantId) : FALLBACK_NAME;
        const assistant = fromTurn !== FALLBACK_NAME ? fromTurn : arg || FALLBACK_NAME;
        return formatAssistantReport({ assistant, kind, summary, userId, channel });
      });
      // Без Telegram текст ушёл в лог (так на test) — ассистент не должен сказать «передал».
      return telegramConfigured()
        ? { ok: true, reported: true, say: REPORTED_SAY }
        : { ok: false, error: 'not_configured', say: notConfiguredSay(p.channel) };
    } catch (e: any) {
      this.logger.warn(`problem-report: сообщение ассистента не обработано: ${e?.message}`);
      return { ok: false, error: 'failed', say: failedSay(p?.channel) };
    }
  }

  /**
   * Скользящие окна: час и сутки на пользователя, час и сутки на всех. Отказ квоту не
   * тратит. Метки «из будущего» (часы шагнули назад) считаем истёкшими.
   */
  private takeQuota(userId: string, now: number): 'ok' | 'user_hour' | 'user_day' | 'global_hour' | 'global_day' {
    const fresh = (t: number, span: number) => t <= now && now - t < span;
    this.globalReports = this.globalReports.filter((t) => fresh(t, DAY));
    const mine = (this.userReports.get(userId) ?? []).filter((t) => fresh(t, DAY));
    const limit =
      mine.filter((t) => fresh(t, HOUR)).length >= envNumber('PROBLEM_REPORT_USER_HOURLY', 3) ? 'user_hour'
      : mine.length >= envNumber('PROBLEM_REPORT_USER_DAILY', 10) ? 'user_day'
      : this.globalReports.filter((t) => fresh(t, HOUR)).length >= envNumber('PROBLEM_REPORT_GLOBAL_HOURLY', 10) ? 'global_hour'
      : this.globalReports.length >= envNumber('PROBLEM_REPORT_GLOBAL_DAILY', 50) ? 'global_day'
      : 'ok';
    if (limit !== 'ok') {
      if (mine.length) this.userReports.set(userId, mine);
      else this.userReports.delete(userId);
      return limit;
    }
    mine.push(now);
    this.userReports.set(userId, mine);
    this.globalReports.push(now);
    return 'ok';
  }

  /** Общий лимит пути Б сработал: одно уведомление в группу — иначе исчерпание лимита неотличимо от тишины. */
  private noteAssistantCap(now: number, limit: 'global_hour' | 'global_day'): void {
    const every = limit === 'global_day' ? DAY : HOUR;
    if (this.assistantCapNoticeAt[limit] > now) this.assistantCapNoticeAt[limit] = 0;
    if (now - this.assistantCapNoticeAt[limit] < every) return;
    this.assistantCapNoticeAt[limit] = now;
    void this.deliver('assistant_cap', async () => formatAssistantCapNotice(limit === 'global_day' ? 'сутки' : 'час'));
  }

  /**
   * Общий потолок сообщений пути А в час (PROBLEM_REPORT_TOOL_HOURLY, по
   * умолчанию 20) на все подписи: разные подписи не засыплют группу. Сверх
   * потолка — одно уведомление в час. Метки «из будущего» (часы шагнули
   * назад) считаем истёкшими, иначе потолок держался бы лишнее время.
   */
  private takeToolSlot(now: number): boolean {
    this.toolSent = this.toolSent.filter((t) => t <= now && now - t < HOUR);
    if (this.capNoticeAt > now) this.capNoticeAt = 0;
    const cap = envNumber('PROBLEM_REPORT_TOOL_HOURLY', 20);
    if (this.toolSent.length < cap) {
      this.toolSent.push(now);
      return true;
    }
    if (now - this.capNoticeAt >= HOUR) {
      this.capNoticeAt = now;
      void this.deliver('tool_cap', async () => formatToolCapNotice(cap));
    }
    return false;
  }

  /** Имя ассистента, но не дольше nameTimeoutMs — потом «Ассистент». */
  private async assistantNameWithin(assistantId: string | null): Promise<string> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<string>((resolve) => {
      timer = setTimeout(() => {
        this.logger.warn(`problem-report: имя ассистента ${assistantId} не прочитано за ${this.nameTimeoutMs} мс`);
        resolve(FALLBACK_NAME);
      }, this.nameTimeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([this.assistantName(assistantId), timeout]);
    } finally {
      clearTimeout(timer);
    }
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
    } catch (e: any) {
      this.logger.warn(`problem-report: имя ассистента ${assistantId} не прочитано: ${e?.message}`);
      return FALLBACK_NAME;
    }
  }

  /** Собирает текст и шлёт. Не бросает; без Telegram — пишет текст в лог (так на test). */
  private async deliver(kind: 'tool_failure' | 'tool_cap' | 'assistant_report' | 'assistant_cap', build: () => Promise<string>): Promise<void> {
    try {
      const text = await build();
      if (!telegramConfigured()) {
        this.logger.log(`problem-report: ${text.replace(/[\r\n]+/g, ' | ')}`);
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
    for (const [key, inc] of this.incidents) {
      if (now - inc.lastSeenAt > DAY) this.incidents.delete(key);
    }
    for (const [userId, times] of this.userReports) {
      if (!times.some((t) => t <= now && now - t < DAY)) this.userReports.delete(userId);
    }
  }
}
