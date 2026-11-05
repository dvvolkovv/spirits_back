import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { SupportService } from '../support/support.service';
import { AlertBotDraftClaim, AlertBotDraftOutcome, AlertBotStore } from './alert-bot.store';
import { AlertBotTelegram } from './alert-bot.telegram';

interface AlertBotIdentity {
  tgUserId: string;
  adminUserId: string;
}

interface MaybeDraftInput {
  chatId: string;
  questionMessageId: number;
  text: string;
  identity: AlertBotIdentity;
  ticket: { id: string; status: string };
}

interface DraftCallbackInput {
  callbackId: string;
  chatId: string;
  tgUserId: string;
  adminUserId: string;
  draftId: string;
  action: 'send' | 'ask' | 'cancel';
  messageId: number;
}

export interface DraftCallbackResult {
  question?: string;
  ticketId?: string;
  draftId?: string;
  claimVersion?: number;
  guardToken?: symbol;
}

function terminal(status: string): boolean {
  return status === 'resolved' || status === 'closed';
}

function terminalPublishError(error: unknown): boolean {
  return error instanceof ConflictException && error.message === 'ticket is terminal';
}

@Injectable()
export class AlertBotDrafts {
  private readonly logger = new Logger(AlertBotDrafts.name);
  private readonly activeQuestionDraftIds = new Map<string, symbol>();

  constructor(
    private readonly store: AlertBotStore,
    private readonly support: SupportService,
    private readonly telegram: AlertBotTelegram,
  ) {}

  async maybeDraft(input: MaybeDraftInput): Promise<string | null> {
    if (terminal(input.ticket.status)) return 'Тикет уже закрыт — черновик не создан.';

    const id = await this.store.createDraft({
      chatId: input.chatId,
      tgUserId: input.identity.tgUserId,
      adminUserId: input.identity.adminUserId,
      ticketId: input.ticket.id,
      text: input.text,
    });
    const header = `Черновик ответа в тикет #${input.ticket.id.slice(0, 8)}:\n\n`;
    const preview = input.text.slice(0, Math.max(0, 4096 - header.length));
    let prompt: { message_id: number };
    try {
      prompt = await this.telegram.sendMessage(
        input.chatId,
        `${header}${preview}`,
        input.questionMessageId,
        {
          inline_keyboard: [[
            { text: '✅ Отправить', callback_data: `draft:${id}:send` },
            { text: 'Спросить ИИ', callback_data: `draft:${id}:ask` },
            { text: 'Отменить', callback_data: `draft:${id}:cancel` },
          ]],
        },
      );
    } catch {
      // Без видимого prompt активный черновик был бы недостижим для кнопок.
      await this.store.finalizeDraft(id, null, 'cancelled', 0);
      return 'Не удалось показать черновик — он отменён.';
    }

    try {
      await this.store.attachDraftPrompt(id, prompt.message_id);
    } catch {
      // Prompt уже виден, а callback передаёт messageId сам. Повторная попытка
      // maybeDraft создала бы второй prompt, поэтому здесь только безопасный код.
      this.logger.warn('alert-bot draft prompt attach failed');
    }
    return null;
  }

  private async finalize(
    id: string,
    expectedAction: AlertBotDraftClaim,
    outcome: AlertBotDraftOutcome,
    version: number,
  ): Promise<void> {
    if (!await this.store.finalizeDraft(id, expectedAction, outcome, version)) {
      throw new Error('draft finalize failed');
    }
  }

  async finalizeAsk(id: string, version: number): Promise<void> {
    await this.finalize(id, 'asking', 'asked', version);
  }

  finishAsk(id: string, guardToken: symbol): void {
    if (this.activeQuestionDraftIds.get(id) === guardToken) {
      this.activeQuestionDraftIds.delete(id);
    }
  }

  async releaseAsk(id: string, version: number): Promise<void> {
    await this.store.releaseDraft(id, 'asking', version);
  }

  async handleCallback(input: DraftCallbackInput): Promise<DraftCallbackResult> {
    let answer = 'Готово';
    let activeClaim: { action: AlertBotDraftClaim; version: number } | null = null;
    let questionGuardToken: symbol | null = null;
    let keepQuestionGuard = false;
    try {
      if (input.action === 'ask') {
        if (this.activeQuestionDraftIds.has(input.draftId)) {
          answer = 'Черновик уже обрабатывается';
          return {};
        }
        // Токен добавляется синхронно, до первого await. Только его владелец
        // может снять guard после завершения reservation.
        questionGuardToken = Symbol();
        this.activeQuestionDraftIds.set(input.draftId, questionGuardToken);
      }
      const draft = await this.store.getDraft(input.draftId);
      if (!draft || String(draft.chatId) !== String(input.chatId)) {
        answer = 'Черновик не найден';
        return {};
      }
      if (String(draft.tgUserId) !== String(input.tgUserId) || draft.adminUserId !== input.adminUserId) {
        answer = 'Это черновик другого админа';
        return {};
      }

      const claim: AlertBotDraftClaim | null = input.action === 'send'
        ? 'sending'
        : input.action === 'ask'
          ? 'asking'
          : input.action === 'cancel'
            ? 'cancelling'
            : null;
      if (!claim) {
        answer = 'Неизвестное действие';
        return {};
      }
      const claimResult = await this.store.claimDraft(draft.id, claim);
      if (claimResult.status === 'in_progress') {
        answer = 'Черновик уже обрабатывается';
        return {};
      }
      if (claimResult.status !== 'claimed') {
        answer = 'Черновик устарел';
        return {};
      }
      activeClaim = { action: claim, version: claimResult.version };

      if (input.action === 'ask' || input.action === 'cancel') {
        // Publish мог успешно закоммититься перед сбоем процесса до finalize.
        // Reclaim по lease не делает такой видимый ответ отменённым или вопросом.
        const published = await this.support.findTelegramDraftPublication(draft.ticketId, draft.id);
        if (published) {
          await this.finalize(draft.id, activeClaim.action, 'sent', activeClaim.version);
          activeClaim = null;
          answer = 'Ответ уже отправлен';
          if (input.action === 'cancel') {
            try {
              await this.telegram.editMessageText(input.chatId, input.messageId, '✅ Отправлено');
            } catch {
              // Публикация и sent уже завершены; prompt редактируется best-effort.
            }
          }
          return {};
        }
      }

      if (input.action === 'ask') {
        // Atomic admission переведёт asking → asked. Локальный ID остаётся
        // активным, пока queued/running ход не завершится в Turns.
        keepQuestionGuard = true;
        answer = 'Вопрос принят';
        return {
          question: draft.text,
          ticketId: draft.ticketId,
          draftId: draft.id,
          claimVersion: activeClaim.version,
          guardToken: questionGuardToken!,
        };
      }

      if (input.action === 'cancel') {
        await this.finalize(draft.id, activeClaim.action, 'cancelled', activeClaim.version);
        activeClaim = null;
        answer = 'Отменено';
        try {
          await this.telegram.editMessageText(input.chatId, input.messageId, 'Отменено');
        } catch {
          // Отмена уже зафиксирована; устаревший prompt — косметическая проблема.
        }
        return {};
      }

      try {
        await this.support.postOwnerReplyFromTelegram(
          draft.ticketId,
          draft.tgUserId,
          draft.adminUserId,
          draft.text,
          true,
          input.adminUserId,
          draft.id,
          activeClaim.version,
        );
      } catch (error) {
        if (!terminalPublishError(error)) throw error;
        // Терминальный статус и retry уже опубликованного draftId различаются
        // только прямым поиском сообщения под ticket+draft FOR UPDATE.
        await this.finalize(draft.id, activeClaim.action, 'cancelled', activeClaim.version);
        activeClaim = null;
        answer = 'Тикет уже закрыт — ответ не отправлен';
        return {};
      }

      await this.finalize(draft.id, activeClaim.action, 'sent', activeClaim.version);
      activeClaim = null;
      answer = 'Отправлено';
      try {
        await this.telegram.editMessageText(input.chatId, input.messageId, '✅ Отправлено');
      } catch {
        // Публикация и sent уже завершены. Нельзя освобождать черновик из-за
        // косметического сбоя edit: это спровоцировало бы лишний retry.
      }
      return {};
    } catch {
      if (activeClaim) {
        // Versioned release не может очистить более новый claim. Повторный publish
        // безопасен: draftId идемпотентен, а stale version отклоняется до insert.
        await this.store.releaseDraft(input.draftId, activeClaim.action, activeClaim.version).catch(() => undefined);
      }
      answer = 'Не удалось обработать черновик';
      return {};
    } finally {
      if (questionGuardToken && !keepQuestionGuard) {
        this.finishAsk(input.draftId, questionGuardToken);
      }
      // Ошибка ack не отменяет уже полученный результат (особенно question у /ask).
      try {
        await this.telegram.answerCallbackQuery(input.callbackId, answer);
      } catch {
        // Ровно одна попытка ack; повторять её опасно для общего обработчика.
      }
    }
  }
}
