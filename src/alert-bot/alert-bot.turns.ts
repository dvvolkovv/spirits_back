import { Injectable, Logger } from '@nestjs/common';
import { ChatService } from '../chat/chat.service';
import type { LlmOutageKind } from '../common/llm-error';
import { SupportService } from '../support/support.service';
import { AlertBotAi, AlertBotAiInput } from './alert-bot.ai';
import { alertBotRatePerHour } from './alert-bot.config';
import { AlertBotStatusService } from './alert-bot.status';
import { AlertBotStore, AlertBotTurnStatus } from './alert-bot.store';
import { AlertBotTelegram } from './alert-bot.telegram';
import { TurnInput } from './alert-bot.types';

const MAX_PENDING_PER_CHAT = 3;
const BUSY_TEXT = 'Занят, спросите через минуту';
const RATE_LIMITED_TEXT = 'Лимит вопросов в час исчерпан';
const GENERIC_ERROR_TEXT = 'Не получилось ответить, попробуйте ещё раз';
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

  enqueue(input: TurnInput): Promise<void> {
    const key = String(input.chatId);
    const pending = this.pending.get(key) || 0;
    if (pending >= MAX_PENDING_PER_CHAT) return this.rejectBusy(input);

    this.pending.set(key, pending + 1);
    const previous = this.chains.get(key) || Promise.resolve();
    const run = previous.then(() => this.execute(input));
    let tracked: Promise<void>;
    tracked = run.finally(() => {
      const left = (this.pending.get(key) || 1) - 1;
      if (left > 0) this.pending.set(key, left);
      else this.pending.delete(key);
      if (this.chains.get(key) === tracked) this.chains.delete(key);
    });
    this.chains.set(key, tracked);
    return tracked;
  }

  async idle(): Promise<void> {
    await Promise.all(Array.from(this.chains.values()));
  }

  private async execute(input: TurnInput): Promise<void> {
    const startedAt = Date.now();
    let turnId: string | null = null;
    let placeholderId: number | null = null;
    let streamOpen = false;
    let finishAttempted = false;

    try {
      turnId = await this.store.tryCreateTurn(input, alertBotRatePerHour());
      if (!turnId) {
        await this.rejectRateLimited(input);
        return;
      }

      const placeholder = await this.telegram.sendMessage(input.chatId, '🔎 Смотрю…', input.questionMessageId);
      placeholderId = placeholder.message_id;
      await this.store.attachAnswerMessages(turnId, [placeholderId]);

      this.chat.beginStream();
      streamOpen = true;
      const history = await this.history(input);
      let answer: { text: string; costUsd: number; tools: string[] };
      try {
        answer = await this.ai.answer({ ...input, history });
      } catch (error) {
        const kind = safeErrorKind(error, 'unknown');
        if (!MODEL_FAILURE_KINDS.has(kind as LlmOutageKind)) throw error;
        const turnStatus: AlertBotTurnStatus = kind === 'timeout' ? 'timeout' : 'model_down';
        const summary = await this.status.summary();
        const fallback = `Модель недоступна: ${kind}.\n\n${summary}`;
        this.log(turnId, turnStatus, kind);
        await this.replacePlaceholder(input, placeholderId, fallback);
        finishAttempted = true;
        await this.store.finishTurn(turnId, {
          status: turnStatus,
          answer: fallback,
          errorKind: kind,
          durationMs: Date.now() - startedAt,
        });
        return;
      }

      const replyMarkup = await this.ticketButtons(answer.text);
      const answerMessageIds = await this.telegram.sendChunks(
        input.chatId,
        answer.text,
        placeholderId,
        input.questionMessageId,
        replyMarkup,
      );
      await this.store.attachAnswerMessages(turnId, answerMessageIds);
      finishAttempted = true;
      await this.store.finishTurn(turnId, {
        status: 'ok',
        answer: answer.text,
        tools: answer.tools,
        durationMs: Date.now() - startedAt,
        costUsd: answer.costUsd,
      });
      this.log(turnId, 'ok', 'done');
    } catch (error) {
      const kind = safeErrorKind(error);
      this.log(turnId, 'error', kind);
      try {
        await this.replacePlaceholder(input, placeholderId, GENERIC_ERROR_TEXT);
      } catch (sendError) {
        this.log(turnId, 'error', safeErrorKind(sendError, 'send_failed'));
      }
      if (turnId && !finishAttempted) {
        finishAttempted = true;
        try {
          await this.store.finishTurn(turnId, {
            status: 'error',
            errorKind: kind,
            durationMs: Date.now() - startedAt,
          });
        } catch (finishError) {
          this.log(turnId, 'error', safeErrorKind(finishError, 'finish_failed'));
        }
      }
    } finally {
      if (streamOpen) this.chat.endStream();
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
    for (const prefix of prefixes) {
      const ticket = await this.support.findTicketByPrefix(prefix);
      if (!ticket) continue;
      const origin = (process.env.ADMIN_ORIGIN || 'https://my.linkeon.io').replace(/\/+$/, '');
      buttons.push([{
        text: `Открыть #${prefix}`,
        url: `${origin}/admin?tab=support&ticket=${encodeURIComponent(ticket.id)}`,
      }]);
      if (buttons.length === 3) break;
    }
    return buttons.length ? { inline_keyboard: buttons } : undefined;
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

  private log(turnId: string | null, status: AlertBotTurnStatus, kind: string): void {
    this.logger.error(`alert-bot turn=${turnId || 'none'} status=${status} kind=${kind}`);
  }
}
