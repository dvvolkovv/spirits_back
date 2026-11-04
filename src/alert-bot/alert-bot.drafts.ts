import { Injectable } from '@nestjs/common';
import { SupportService } from '../support/support.service';
import { AlertBotStore } from './alert-bot.store';
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

@Injectable()
export class AlertBotDrafts {
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
    const prompt = await this.telegram.sendMessage(
      input.chatId,
      `Черновик ответа в тикет #${input.ticket.id.slice(0, 8)}:\n\n${input.text}`,
      input.questionMessageId,
      {
        inline_keyboard: [[
          { text: '✅ Отправить', callback_data: `draft:${id}:send` },
          { text: 'Спросить ИИ', callback_data: `draft:${id}:ask` },
          { text: 'Отменить', callback_data: `draft:${id}:cancel` },
        ]],
      },
    );
    await this.store.attachDraftPrompt(id, prompt.message_id);
    return null;
  }

  async handleCallback(input: DraftCallbackInput): Promise<DraftCallbackResult> {
    let answer = 'Готово';
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

      if (input.action === 'send') {
        const consumed = await this.store.consumeDraft(draft.id, 'sent');
        if (!consumed) {
          answer = 'Черновик устарел';
          return {};
        }
        // Между созданием черновика и нажатием кнопки тикет могли закрыть.
        // Статус читаем повторно после атомарного consume, но до публикации.
        const current = await this.support.adminGetTicket(draft.ticketId);
        if (terminal(current.ticket.status)) {
          answer = 'Тикет уже закрыт — ответ не отправлен';
          return {};
        }
        await this.support.postOwnerReplyFromTelegram(
          draft.ticketId,
          draft.tgUserId,
          draft.adminUserId,
          draft.text,
          true,
          input.adminUserId,
        );
        await this.telegram.editMessageText(input.chatId, input.messageId, '✅ Отправлено');
        answer = 'Отправлено';
        return {};
      }

      if (input.action === 'ask') {
        const consumed = await this.store.consumeDraft(draft.id, 'asked');
        if (!consumed) {
          answer = 'Черновик устарел';
          return {};
        }
        answer = 'Вопрос передан боту';
        return { question: draft.text, ticketId: draft.ticketId };
      }

      if (input.action === 'cancel') {
        const consumed = await this.store.consumeDraft(draft.id, 'cancelled');
        if (!consumed) {
          answer = 'Черновик устарел';
          return {};
        }
        await this.telegram.editMessageText(input.chatId, input.messageId, 'Отменено');
        answer = 'Отменено';
        return {};
      }

      answer = 'Неизвестное действие';
      return {};
    } catch {
      // Текст черновика и сырые ошибки сюда не попадают: callback и журналы не
      // должны стать вторым каналом утечки переписки с пользователем.
      answer = 'Не удалось обработать черновик';
      return {};
    } finally {
      await this.telegram.answerCallbackQuery(input.callbackId, answer);
    }
  }
}
