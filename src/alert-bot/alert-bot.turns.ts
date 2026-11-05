import { Injectable, Logger } from '@nestjs/common';
import { ChatService } from '../chat/chat.service';
import { ClaudeCliCallError } from '../common/services/claude-cli.service';
import type { LlmOutageKind } from '../common/llm-error';
import { SupportService } from '../support/support.service';
import { AlertBotAi, AlertBotAiInput } from './alert-bot.ai';
import { alertBotRatePerHour } from './alert-bot.config';
import { AlertBotStatusService } from './alert-bot.status';
import { AlertBotRetryableError } from './alert-bot.errors';
import { AlertBotStore, AlertBotTurn, AlertBotTurnStatus, DraftReservation } from './alert-bot.store';
import { AlertBotTelegram } from './alert-bot.telegram';
import { TurnInput } from './alert-bot.types';

const MAX_PENDING_PER_CHAT = 3;
const BUSY_TEXT = 'Занят, спросите через минуту';
const RATE_LIMITED_TEXT = 'Лимит вопросов в час исчерпан';
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
    let turnId: string;
    if (reservation) {
      // Draft finalize входит в ту же транзакцию, что и создание хода: после commit
      // повторный callback видит asked ещё до начала работы модели.
      const admitted = await this.store.admitDraftQuestion({
        ...reservation,
        input,
        maxPerHour: alertBotRatePerHour(),
      });
      if (admitted.status === 'stale') return 'stale';
      if (admitted.status === 'rate_limited') return this.rejectRateLimited(input);
      if (admitted.status === 'existing') return this.resumeExisting(admitted.turn, input);
      turnId = admitted.turnId;
    } else {
      // Admission отделён от выполнения: до turnId сбой должен попасть в service.
      const admitted = await this.store.admitTurn(input, alertBotRatePerHour());
      if (admitted.status === 'rate_limited') return this.rejectRateLimited(input);
      if (admitted.status === 'existing') return this.resumeExisting(admitted.turn, input);
      turnId = admitted.turnId;
    }
    return this.runTurn(turnId, input, startedAt);
  }

  private async resumeExisting(turn: AlertBotTurn, input: TurnInput): Promise<AlertBotAdmission> {
    if (turn.status === 'busy' || turn.status === 'rate_limited') {
      return this.notifySystem(turn.id, turn.status, input, turn);
    }
    if (turn.answer !== null && turn.deliveryCompletedAt) return 'accepted';
    // После начала модели отсутствие сохранённого ответа — неизвестный исход.
    // Единственное безопасное восстановление — defer, а не второй Claude.
    if (turn.modelStartedAt && turn.answer === null) {
      throw new AlertBotRetryableError('model_in_flight');
    }
    // Старые error/interrupted turns не имеют model_started_at. Их исход тоже
    // нельзя угадывать повторным запуском модели.
    if (turn.status !== 'in_progress' && turn.answer === null) {
      throw new AlertBotRetryableError('model_state_unknown');
    }
    return this.runTurn(turn.id, input, Date.now(), turn);
  }

  private async runTurn(
    turnId: string,
    input: TurnInput,
    startedAt: number,
    existing?: AlertBotTurn,
  ): Promise<AlertBotAdmission> {
    let deliveredIds = [...(existing?.answerMessageIds || [])];
    let placeholderId = existing?.placeholderMessageId ?? deliveredIds[0] ?? null;
    let answer = existing?.answer ?? null;
    let turnStatus: AlertBotTurnStatus = existing?.status || 'in_progress';

    try {
      if (placeholderId === null) {
        if (existing?.placeholderStartedAt) {
          throw new AlertBotRetryableError('placeholder_in_flight');
        }
        await this.store.markPlaceholderStarted(turnId);
        let placeholder: { message_id: number };
        try {
          placeholder = await this.telegram.sendMessage(input.chatId, '🔎 Смотрю…', input.questionMessageId);
        } catch (error) {
          await this.store.deferPlaceholder(turnId).catch(() => undefined);
          throw error;
        }
        placeholderId = placeholder.message_id;
        // Если journal не сохранился, placeholder_started_at остаётся установленным:
        // retry отложится вместо возможного второго видимого placeholder.
        await this.store.attachPlaceholder(turnId, placeholderId);
      }

      if (answer === null) {
        const history = await this.history(input);
        await this.store.markModelStarted(turnId);
        let generated: { text: string; costUsd: number; tools: string[] };
        try {
          generated = await this.ai.answer({ ...input, history });
        } catch (error) {
          const kind = safeErrorKind(error, 'unknown');
          if (!(error instanceof ClaudeCliCallError) && !MODEL_FAILURE_KINDS.has(kind as LlmOutageKind)) {
            throw new AlertBotRetryableError('model_outcome_unknown');
          }
          turnStatus = kind === 'timeout' ? 'timeout' : 'model_down';
          const summary = await this.status.summary();
          answer = `Модель недоступна: ${kind}.\n\n${summary}`;
          const finished = await this.store.finishTurn(turnId, {
            status: turnStatus,
            answer,
            errorKind: kind,
            durationMs: Date.now() - startedAt,
          });
          if (!finished) throw new AlertBotRetryableError('turn_fenced');
          generated = { text: answer, costUsd: 0, tools: [] };
        }
        if (turnStatus !== 'model_down' && turnStatus !== 'timeout') {
          answer = generated.text;
          turnStatus = 'ok';
          // Ответ и стоимость фиксируются ДО первой попытки delivery.
          const finished = await this.store.finishTurn(turnId, {
            status: 'ok',
            answer,
            tools: generated.tools,
            durationMs: Date.now() - startedAt,
            costUsd: generated.costUsd,
          });
          if (!finished) throw new AlertBotRetryableError('turn_fenced');
        }
      }

      if (existing?.deliveryCompletedAt) return 'accepted';
      if (existing?.deliveryStartedAt) {
        // Процесс мог оборваться между Telegram и journal. Не перезаписываем
        // возможный видимый ответ и не дублируем continuation.
        throw new AlertBotRetryableError('delivery_in_flight');
      }

      const replyMarkup = await this.ticketButtons(answer);
      await this.store.markDeliveryStarted(turnId);
      let journalFailure = false;
      let completing = false;
      try {
        const answerMessageIds = await this.telegram.sendChunks(
          input.chatId,
          answer,
          placeholderId,
          input.questionMessageId,
          replyMarkup,
          async (ids) => {
            deliveredIds = [...ids];
            try {
              await this.store.attachAnswerMessages(turnId, ids);
            } catch {
              journalFailure = true;
              throw new AlertBotRetryableError('answer_journal_failed');
            }
          },
          deliveredIds,
        );
        completing = true;
        await this.store.completeDelivery(turnId, answerMessageIds);
        deliveredIds = [...answerMessageIds];
      } catch (error) {
        // Обычный отказ Telegram до/между chunks безопасно повторяется с
        // сохранённого deliveredIds. Сбой journal после видимого результата —
        // неизвестное состояние, поэтому delivery_started_at не очищается.
        if (!journalFailure && !completing) {
          await this.store.deferDelivery(turnId).catch(() => undefined);
        }
        throw error;
      }
      this.log(turnId, turnStatus, turnStatus === 'ok' ? 'done' : safeErrorKind(existing?.errorKind));
      return 'accepted';
    } catch (error) {
      const kind = safeErrorKind(error);
      this.log(turnId, 'error', kind);
      if (error instanceof AlertBotRetryableError) throw error;
      throw new AlertBotRetryableError(kind);
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

  private async rejectRateLimited(input: TurnInput): Promise<'rate_limited'> {
    const turnId = await this.store.recordSystemTurn(input, 'rate_limited');
    return this.notifySystem(turnId, 'rate_limited', input);
  }

  private async rejectBusy(input: TurnInput): Promise<'busy'> {
    const turnId = await this.store.recordSystemTurn(input, 'busy');
    return this.notifySystem(turnId, 'busy', input);
  }

  private async notifySystem(
    turnId: string,
    status: 'busy' | 'rate_limited',
    input: TurnInput,
    existing?: AlertBotTurn,
  ): Promise<'busy' | 'rate_limited'> {
    if (existing && (existing.answerMessageId !== null || existing.answerMessageIds.length)) return status;
    if (existing?.placeholderStartedAt) throw new AlertBotRetryableError('notification_in_flight');
    await this.store.markPlaceholderStarted(turnId);
    let notification: { message_id: number };
    try {
      notification = await this.telegram.sendMessage(
        input.chatId,
        status === 'busy' ? BUSY_TEXT : RATE_LIMITED_TEXT,
        input.questionMessageId,
      );
    } catch (error) {
      await this.store.deferPlaceholder(turnId).catch(() => undefined);
      throw error;
    }
    // Как и с answer delivery, сбой journal оставляет started marker и ведёт
    // к defer вместо повторного пользовательского уведомления.
    await this.store.completeDelivery(turnId, [notification.message_id]);
    this.log(turnId, status, status);
    return status;
  }

  private log(turnId: string | null, status: AlertBotTurnStatus | 'ignored', kind: string): void {
    const line = `alert-bot turn=${turnId || 'none'} status=${status} kind=${kind}`;
    if (status === 'ok') this.logger.log(line);
    else if (status === 'ignored') this.logger.debug(line);
    else this.logger.error(line);
  }
}
