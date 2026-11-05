import { Injectable, Logger } from '@nestjs/common';
import { ChatService } from '../chat/chat.service';
import { ClaudeCliCallError } from '../common/services/claude-cli.service';
import type { LlmOutageKind } from '../common/llm-error';
import { SupportService } from '../support/support.service';
import { AlertBotAi, AlertBotAiInput } from './alert-bot.ai';
import { alertBotRatePerHour } from './alert-bot.config';
import { AlertBotStatusService } from './alert-bot.status';
import { AlertBotStore, AlertBotTurnStatus, DraftReservation } from './alert-bot.store';
import { AlertBotTelegram } from './alert-bot.telegram';
import { TurnInput } from './alert-bot.types';

const MAX_PENDING_PER_CHAT = 3;
const BUSY_TEXT = 'Занят, спросите через минуту';
const RATE_LIMITED_TEXT = 'Лимит вопросов в час исчерпан';
const GENERIC_ERROR_TEXT = 'Не получилось ответить, попробуйте ещё раз';
const PARTIAL_DELIVERY_TEXT = 'Ответ доставлен не полностью, попробуйте ещё раз';
export type AlertBotAdmission = 'accepted' | 'busy' | 'rate_limited' | 'stale';
const MODEL_FAILURE_KINDS: ReadonlySet<LlmOutageKind> = new Set([
  'auth', 'rate_limit', 'weekly_limit', 'overloaded', 'timeout',
]);

function safeErrorKind(error: unknown, fallback = 'error'): string {
  const kind = (error as { kind?: unknown })?.kind;
  return typeof kind === 'string' && /^[a-z][a-z0-9_.-]{0,40}$/i.test(kind) ? kind : fallback;
}

@Injectable()
export class AlertBotTurns {
  private readonly logger = new Logger(AlertBotTurns.name);
  private readonly chains = new Map<string, Promise<void>>();
  private readonly pending = new Map<string, number>();

  constructor(
    private readonly store: AlertBotStore,
    private readonly telegram: AlertBotTelegram,
    private readonly ai: AlertBotAi,
    private readonly status: AlertBotStatusService,
    private readonly chat: ChatService,
    private readonly support: SupportService,
  ) {}

  enqueue(input: TurnInput, reservation?: DraftReservation): Promise<AlertBotAdmission> {
    const key = String(input.chatId);
    const pending = this.pending.get(key) || 0;
    this.chat.beginStream();
    if (pending >= MAX_PENDING_PER_CHAT) {
      return this.rejectBusy(input)
        .then(() => 'busy' as const)
        .finally(() => this.chat.endStream());
    }

    this.pending.set(key, pending + 1);
    const previous = this.chains.get(key) || Promise.resolve();
    const run = previous
      .then(() => this.execute(input, reservation))
      .finally(() => this.chat.endStream());
    let tracked: Promise<void>;
    tracked = run.then(() => undefined, () => undefined).finally(() => {
      const left = (this.pending.get(key) || 1) - 1;
      if (left > 0) this.pending.set(key, left);
      else this.pending.delete(key);
      if (this.chains.get(key) === tracked) this.chains.delete(key);
    });
    this.chains.set(key, tracked);
    return run;
  }

  async idle(): Promise<void> {
    await Promise.all(Array.from(this.chains.values()));
  }

  private async execute(input: TurnInput, reservation?: DraftReservation): Promise<AlertBotAdmission> {
    const startedAt = Date.now();
    // Draft finalize входит в ту же транзакцию, что и создание хода: после commit
    // повторный callback видит asked ещё до начала работы модели.
    let turnId: string;
    if (reservation) {
      const admitted = await this.store.admitDraftQuestion({
        ...reservation,
        input,
        maxPerHour: alertBotRatePerHour(),
      });
      if (admitted.status === 'stale') return 'stale';
      if (admitted.status === 'rate_limited') {
        await this.rejectRateLimited(input);
        return 'rate_limited';
      }
      if (admitted.status === 'existing') return 'accepted';
      turnId = admitted.turnId;
    } else {
      // Admission отделён от выполнения: до turnId сбой должен попасть в service.
      const admitted = await this.store.admitTurn(input, alertBotRatePerHour());
      if (admitted.status === 'rate_limited') {
        await this.rejectRateLimited(input);
        return 'rate_limited';
      }
      if (admitted.status === 'existing') return 'accepted';
      turnId = admitted.turnId;
    }

    let placeholderId: number | null = null;
    let finishAttempted = false;
    let deliveredIds: number[] = [];
    let deliveryComplete = false;

    try {
      const placeholder = await this.telegram.sendMessage(input.chatId, '🔎 Смотрю…', input.questionMessageId);
      placeholderId = placeholder.message_id;
      await this.store.attachAnswerMessages(turnId, [placeholderId]);

      const history = await this.history(input);
      let answer: { text: string; costUsd: number; tools: string[] };
      try {
        answer = await this.ai.answer({ ...input, history });
      } catch (error) {
        const kind = safeErrorKind(error, 'unknown');
        if (!(error instanceof ClaudeCliCallError) && !MODEL_FAILURE_KINDS.has(kind as LlmOutageKind)) throw error;
        const turnStatus: AlertBotTurnStatus = kind === 'timeout' ? 'timeout' : 'model_down';
        const summary = await this.status.summary();
        const fallback = `Модель недоступна: ${kind}.\n\n${summary}`;
        this.log(turnId, turnStatus, kind);
        await this.replacePlaceholder(input, placeholderId, fallback);
        deliveredIds = placeholderId === null ? [] : [placeholderId];
        deliveryComplete = true;
        await this.store.finishTurn(turnId, {
          status: turnStatus,
          answer: fallback,
          errorKind: kind,
          durationMs: Date.now() - startedAt,
        });
        finishAttempted = true;
        return 'accepted';
      }

      const replyMarkup = await this.ticketButtons(answer.text);
      const answerMessageIds = await this.telegram.sendChunks(
        input.chatId,
        answer.text,
        placeholderId,
        input.questionMessageId,
        replyMarkup,
        async (ids) => {
          deliveredIds = [...ids];
          await this.persistAnswerMessages(turnId, ids);
        },
      );
      deliveredIds = [...answerMessageIds];
      deliveryComplete = true;
      await this.persistAnswerMessages(turnId, answerMessageIds);
      const finished = await this.store.finishTurn(turnId, {
        status: 'ok',
        answer: answer.text,
        tools: answer.tools,
        durationMs: Date.now() - startedAt,
        costUsd: answer.costUsd,
      });
      finishAttempted = true;
      if (finished) this.log(turnId, 'ok', 'done');
      else this.log(turnId, 'ignored', 'fenced');
    } catch (error) {
      const kind = safeErrorKind(error);
      this.log(turnId, 'error', kind);
      if (!deliveredIds.length) {
        try {
          await this.replacePlaceholder(input, placeholderId, GENERIC_ERROR_TEXT);
        } catch (sendError) {
          this.log(turnId, 'error', safeErrorKind(sendError, 'send_failed'));
        }
      } else if (!deliveryComplete) {
        try {
          await this.telegram.sendMessage(input.chatId, PARTIAL_DELIVERY_TEXT, input.questionMessageId);
        } catch (sendError) {
          this.log(turnId, 'error', safeErrorKind(sendError, 'send_failed'));
        }
      }
      if (!finishAttempted) {
        try {
          await this.store.finishTurn(turnId, {
            status: 'error',
            errorKind: kind,
            durationMs: Date.now() - startedAt,
          });
          finishAttempted = true;
        } catch (finishError) {
          this.log(turnId, 'error', safeErrorKind(finishError, 'finish_failed'));
        }
      }
    }
    return 'accepted';
  }

  private async persistAnswerMessages(turnId: string, ids: number[]): Promise<void> {
    try {
      await this.store.attachAnswerMessages(turnId, ids);
    } catch (error) {
      // Видимые сообщения важнее журнала: retry attach не должен обрывать chunks
      // или приводить к overwrite уже доставленного ответа.
      this.log(turnId, 'error', safeErrorKind(error, 'attach_failed'));
    }
  }

  private async history(input: TurnInput): Promise<AlertBotAiInput['history']> {
    if (input.parentTurnId) {
      const chain = await this.store.turnChain(input.parentTurnId, 3);
      return chain.map((turn) => ({ question: turn.question, answer: turn.answer || '' }));
    }
    if (!input.privateChat) return [];
    const recent = await this.store.recentTurns(input.chatId, 3, 30);
    return recent.map((turn) => ({ question: turn.question, answer: turn.answer || '' }));
  }

  private async ticketButtons(answer: string): Promise<unknown> {
    const prefixes = Array.from(new Set(
      Array.from(answer.matchAll(/#([0-9a-f]{8})\b/gi), (match) => match[1].toLowerCase()),
    ));
    const buttons: Array<Array<{ text: string; url: string }>> = [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      for (const prefix of prefixes.slice(0, 10)) {
        let ticket: Awaited<ReturnType<SupportService['findTicketByPrefix']>>;
        try {
          ticket = await this.lookupTicket(prefix, controller.signal);
        } catch (error) {
          if ((error as { name?: unknown })?.name === 'TicketPrefixAmbiguousError') continue;
          if (controller.signal.aborted) break;
          this.logger.warn(`alert-bot ticket button failed kind=${safeErrorKind(error)}`);
          continue;
        }
        if (!ticket) continue;
        const origin = (process.env.ADMIN_ORIGIN || 'https://my.linkeon.io').replace(/\/+$/, '');
        buttons.push([{
          text: `Открыть #${prefix}`,
          url: `${origin}/admin?tab=support&ticket=${encodeURIComponent(ticket.id)}`,
        }]);
        if (buttons.length === 3) break;
      }
    } finally {
      clearTimeout(timer);
    }
    return buttons.length ? { inline_keyboard: buttons } : undefined;
  }

  private async lookupTicket(prefix: string, signal: AbortSignal) {
    if (signal.aborted) throw signal.reason || new Error('aborted');
    let onAbort: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason || new Error('aborted'));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return await Promise.race([this.support.findTicketByPrefix(prefix, signal), cancelled]);
    } finally {
      signal.removeEventListener('abort', onAbort!);
    }
  }

  private async replacePlaceholder(input: TurnInput, placeholderId: number | null, text: string): Promise<void> {
    if (placeholderId !== null) {
      await this.telegram.editMessageText(input.chatId, placeholderId, text);
      return;
    }
    await this.telegram.sendMessage(input.chatId, text, input.questionMessageId);
  }

  private async rejectRateLimited(input: TurnInput): Promise<void> {
    const turnId = await this.store.recordSystemTurn(input, 'rate_limited');
    this.log(turnId, 'rate_limited', 'rate_limited');
    await this.telegram.sendMessage(input.chatId, RATE_LIMITED_TEXT, input.questionMessageId);
  }

  private async rejectBusy(input: TurnInput): Promise<void> {
    let turnId: string | null = null;
    try {
      turnId = await this.store.recordSystemTurn(input, 'busy');
      this.log(turnId, 'busy', 'busy');
      await this.telegram.sendMessage(input.chatId, BUSY_TEXT, input.questionMessageId);
    } catch (error) {
      this.log(turnId, 'busy', safeErrorKind(error));
    }
  }

  private log(turnId: string | null, status: AlertBotTurnStatus | 'ignored', kind: string): void {
    const line = `alert-bot turn=${turnId || 'none'} status=${status} kind=${kind}`;
    if (status === 'ok') this.logger.log(line);
    else if (status === 'ignored') this.logger.debug(line);
    else this.logger.error(line);
  }
}
