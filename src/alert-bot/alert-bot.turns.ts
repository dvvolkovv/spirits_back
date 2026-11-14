import { Injectable, Logger } from '@nestjs/common';
import { ChatService } from '../chat/chat.service';
import { ClaudeCliCallError } from '../common/services/claude-cli.service';
import type { LlmOutageKind } from '../common/llm-error';
import { SupportService } from '../support/support.service';
import { AlertBotAi, AlertBotAiInput } from './alert-bot.ai';
import { alertBotRatePerHour } from './alert-bot.config';
import { AlertBotStatusService } from './alert-bot.status';
import { AlertBotRepairService } from './alert-bot.repair.service';
import { AlertBotRetryableError } from './alert-bot.errors';
import { AlertBotStore, AlertBotTurn, AlertBotTurnStatus, DraftReservation } from './alert-bot.store';
import { AlertBotTelegram, unknownTelegramOutcome } from './alert-bot.telegram';
import { TurnInput } from './alert-bot.types';

const MAX_PENDING_PER_CHAT = 3;
const BUSY_TEXT = 'Занят, спросите через минуту';
const RATE_LIMITED_TEXT = 'Лимит вопросов в час исчерпан';
export type AlertBotAdmission = 'accepted' | 'queued' | 'busy' | 'rate_limited' | 'stale';
export interface AlertBotTurnEnqueueOptions {
  onAdmission?: (status: AlertBotAdmission) => void | Promise<void>;
}
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
  private accepting = true;

  constructor(
    private readonly store: AlertBotStore,
    private readonly telegram: AlertBotTelegram,
    private readonly ai: AlertBotAi,
    private readonly status: AlertBotStatusService,
    private readonly chat: ChatService,
    private readonly support: SupportService,
    private readonly repairs: AlertBotRepairService,
  ) {}

  stopAdmission(): void {
    this.accepting = false;
  }

  enqueue(
    input: TurnInput,
    reservation?: DraftReservation,
    options: AlertBotTurnEnqueueOptions = {},
  ): Promise<AlertBotAdmission> {
    if (!this.accepting) return Promise.reject(new AlertBotRetryableError('stopped'));
    const key = String(input.chatId);
    const pending = this.pending.get(key) || 0;
    // Проверка и beginStream синхронны: stopAdmission не может вклиниться между ними.
    this.chat.beginStream();
    if (pending >= MAX_PENDING_PER_CHAT) {
      return this.rejectBusy(input)
        .then((status) => this.acknowledgeAdmission(status, options))
        .finally(() => this.chat.endStream());
    }

    this.pending.set(key, pending + 1);
    const queued = pending > 0;
    const executionOptions = queued ? { ...options, onAdmission: undefined } : options;
    if (queued) {
      // Слот уже зарезервирован: callback ack не ждёт предыдущий ход.
      // Дальше accepted не дублируем, даже если фактический admission завершится ошибкой.
      void this.acknowledgeAdmission('queued', options);
    }
    const previous = this.chains.get(key) || Promise.resolve();
    const run = previous
      .then(() => this.execute(input, reservation, executionOptions))
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

  private async acknowledgeAdmission<T extends AlertBotAdmission>(
    status: T,
    options: AlertBotTurnEnqueueOptions,
  ): Promise<T> {
    try {
      await options.onAdmission?.(status);
    } catch {
      // Ack косметический; durable turn уже имеет однозначный admission result.
    }
    return status;
  }

  private async execute(
    input: TurnInput,
    reservation?: DraftReservation,
    options: AlertBotTurnEnqueueOptions = {},
  ): Promise<AlertBotAdmission> {
    if (!this.accepting) throw new AlertBotRetryableError('stopped');
    if (input.recoverRepair) {
      const repair = await this.repairs.findRepairByUpdate(input.updateId);
      input = {
        ...input,
        recoverRepair: undefined,
        ...(repair ? { mode: 'repair' as const, repairId: repair.id } : {}),
      };
    }
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
      if (admitted.status === 'stale') return this.acknowledgeAdmission('stale', options);
      if (admitted.status === 'rate_limited') {
        const status = await this.rejectRateLimited(input);
        return this.acknowledgeAdmission(status, options);
      }
      if (admitted.status === 'existing') return this.resumeTurn(admitted.turn, input, options);
      turnId = admitted.turnId;
    } else {
      // Admission отделён от выполнения: до turnId сбой должен попасть в service.
      const admitted = await this.store.admitTurn(input, alertBotRatePerHour());
      if (admitted.status === 'rate_limited') {
        const status = await this.rejectRateLimited(input);
        return this.acknowledgeAdmission(status, options);
      }
      if (admitted.status === 'existing') return this.resumeTurn(admitted.turn, input, options);
      turnId = admitted.turnId;
    }
    await this.acknowledgeAdmission('accepted', options);
    return this.runTurn(turnId, input, startedAt);
  }

  resumeExisting(turn: AlertBotTurn, options: AlertBotTurnEnqueueOptions = {}): Promise<AlertBotAdmission> {
    // Публичный recovery входит в ту же chat queue и проходит accepting checks.
    return this.enqueue({
      updateId: turn.updateId,
      chatId: turn.chatId,
      tgUserId: turn.tgUserId,
      adminUserId: turn.adminUserId,
      questionMessageId: turn.questionMessageId,
      question: turn.question,
      replyText: turn.replyText ?? undefined,
      parentTurnId: turn.parentTurnId,
      privateChat: turn.privateChat,
      recoverRepair: true,
    }, undefined, options);
  }

  private async resumeTurn(
    turn: AlertBotTurn,
    input: TurnInput,
    options: AlertBotTurnEnqueueOptions = {},
  ): Promise<AlertBotAdmission> {
    if (turn.status === 'busy' || turn.status === 'rate_limited') {
      const status = await this.notifySystem(turn.id, turn.status, input, turn);
      return this.acknowledgeAdmission(status, options);
    }
    if (turn.answer !== null && turn.deliveryCompletedAt) {
      return this.acknowledgeAdmission('accepted', options);
    }
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
    await this.acknowledgeAdmission('accepted', options);
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
          placeholder = await this.telegram.sendMessage(
            input.chatId,
            input.mode === 'repair' ? '🛠 Исправляю…' : '🔎 Смотрю…',
            input.questionMessageId,
          );
        } catch (error) {
          if (unknownTelegramOutcome(error)) {
            // Timeout после remote success: marker остаётся, retry только defer/dead-letter.
            throw new AlertBotRetryableError('placeholder_in_flight');
          }
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
        if (input.mode === 'repair') {
          const repairId = input.repairId;
          if (!repairId) throw new AlertBotRetryableError('repair_not_requested');
          const repaired = await this.repairs.run(repairId, turnId, input, history);
          answer = repaired.text;
          turnStatus = repaired.turnStatus;
          const finished = await this.store.finishTurn(turnId, {
            status: turnStatus,
            answer,
            tools: repaired.tools,
            durationMs: Date.now() - startedAt,
            costUsd: repaired.costUsd,
          });
          if (!finished) throw new AlertBotRetryableError('turn_fenced');
        } else {
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
        if (unknownTelegramOutcome(error)) {
          // Continuation/edit мог быть виден. Не очищаем delivery_started_at и не
          // повторяем запрос: следующий recovery упрётся в delivery_in_flight.
          throw new AlertBotRetryableError('delivery_in_flight');
        }
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

  private async notifySystem<T extends 'busy' | 'rate_limited'>(
    turnId: string,
    status: T,
    input: TurnInput,
    existing?: AlertBotTurn,
  ): Promise<T> {
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
      if (unknownTelegramOutcome(error)) {
        throw new AlertBotRetryableError('notification_in_flight');
      }
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
