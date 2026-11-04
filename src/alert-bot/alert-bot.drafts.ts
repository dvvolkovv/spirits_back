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
      await this.store.finalizeDraft(id, 'cancelled');
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

  private async finalize(id: string, outcome: AlertBotDraftOutcome): Promise<void> {
    if (!await this.store.finalizeDraft(id, outcome)) throw new Error('draft finalize failed');
  }

  async handleCallback(input: DraftCallbackInput): Promise<DraftCallbackResult> {
    let answer = 'Готово';
    let claimed = false;
    try {
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
      if (claimResult === 'in_progress') {
        answer = 'Черновик уже обрабатывается';
        return {};
      }
      if (claimResult !== 'claimed') {
        answer = 'Черновик устарел';
        return {};
      }
      claimed = true;

      if (input.action === 'ask') {
        await this.finalize(draft.id, 'asked');
        claimed = false;
        answer = 'Вопрос передан боту';
        return { question: draft.text, ticketId: draft.ticketId };
      }

      if (input.action === 'cancel') {
        await this.finalize(draft.id, 'cancelled');
        claimed = false;
        answer = 'Отменено';
        try {
          await this.telegram.editMessageText(input.chatId, input.messageId, 'Отменено');
        } catch {
          // Отмена уже зафиксирована; устаревший prompt — косметическая проблема.
        }
        return {};
      }

      // Между созданием черновика и нажатием кнопки тикет могли закрыть.
      // Но уже опубликованный draftId должен завершить восстановление как sent,
      // даже если закрытие произошло между publish и finalize.
      const current = await this.support.adminGetTicket(draft.ticketId);
      const alreadyPublished = current.messages?.some(
        (message) => message.metadata?.alertBotDraftId === draft.id,
      );
      if (terminal(current.ticket.status) && !alreadyPublished) {
        await this.finalize(draft.id, 'cancelled');
        claimed = false;
        answer = 'Тикет уже закрыт — ответ не отправлен';
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
        );
      } catch (error) {
        if (!terminalPublishError(error)) throw error;
        // Гонку закрытия ловит SupportService под FOR UPDATE. Это не «sent».
        await this.finalize(draft.id, 'cancelled');
        claimed = false;
        answer = 'Тикет уже закрыт — ответ не отправлен';
        return {};
      }

      await this.finalize(draft.id, 'sent');
      claimed = false;
      answer = 'Отправлено';
      try {
        await this.telegram.editMessageText(input.chatId, input.messageId, '✅ Отправлено');
      } catch {
        // Публикация и sent уже завершены. Нельзя освобождать черновик из-за
        // косметического сбоя edit: это спровоцировало бы лишний retry.
      }
      return {};
    } catch {
      if (claimed) {
        // Неожиданный сбой publish/finalize: publish идемпотентен по draftId,
        // поэтому повтор безопасен даже после неопределённого post-commit сбоя.
        await this.store.releaseDraft(input.draftId).catch(() => undefined);
      }
      answer = 'Не удалось обработать черновик';
      return {};
    } finally {
      // Ошибка ack не отменяет уже полученный результат (особенно question у /ask).
      try {
        await this.telegram.answerCallbackQuery(input.callbackId, answer);
      } catch {
        // Ровно одна попытка ack; повторять её опасно для общего обработчика.
      }
    }
  }
}
