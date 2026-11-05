import { Injectable, Logger } from '@nestjs/common';
import { SupportService } from '../support/support.service';
import { AlertBotAccess } from './alert-bot.access';
import { AlertBotCommands } from './alert-bot.commands';
import { alertBotAllowedChat } from './alert-bot.config';
import { AlertBotDrafts } from './alert-bot.drafts';
import { AlertBotStore } from './alert-bot.store';
import { AlertBotTelegram } from './alert-bot.telegram';
import { AlertBotTurns } from './alert-bot.turns';
import { TgMessage } from './alert-bot.types';

const REFUSAL_EVERY_MS = 60 * 60 * 1000;
const ASK_HINT = 'Напишите вопрос после команды, например: /ask Почему горит алерт?';
const CLOSE_HINT = 'Укажите тикет: /close #1234abcd или ответьте /close на сообщение эскалации.';

interface TelegramCallback {
  id: string;
  data?: string;
  from?: TgMessage['from'];
  message?: TgMessage;
}

interface TelegramUpdate {
  update_id?: number;
  message?: TgMessage;
  callback_query?: TelegramCallback;
}

interface Identity {
  tgUserId: string;
  adminUserId: string;
}

interface ParsedCommand {
  name: 'ask' | 'status' | 'close' | 'start';
  username?: string;
  args: string;
}

function safeErrorKind(error: unknown): string {
  const candidate = (error as { kind?: unknown; code?: unknown })?.kind
    || (error as { code?: unknown })?.code;
  return typeof candidate === 'string' && /^[a-z][a-z0-9_.-]{0,40}$/i.test(candidate)
    ? candidate
    : 'error';
}

function parseCommand(text: string): ParsedCommand | null {
  const match = text.match(/^\/(ask|status|close|start)(?:@([A-Za-z0-9_]+))?(?:\s+|$)/i);
  if (!match) return null;
  return {
    name: match[1].toLowerCase() as ParsedCommand['name'],
    username: match[2],
    args: text.slice(match[0].length).trim(),
  };
}

function ticketPrefix(text: string): string | null {
  const full = text.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i);
  if (full) return full[0].toLowerCase();
  const short = text.match(/#([0-9a-f]{8})\b/i);
  return short ? short[1].toLowerCase() : null;
}

function isAmbiguousTicket(error: unknown): boolean {
  return (error as { name?: unknown })?.name === 'TicketPrefixAmbiguousError';
}

function replyText(message?: TgMessage): string | undefined {
  const text = message?.text || message?.caption;
  return text ? String(text) : undefined;
}

@Injectable()
export class AlertBotService {
  private readonly logger = new Logger(AlertBotService.name);
  private readonly refusalSentAt = new Map<string, number>();
  private readonly activeUpdates = new Set<number>();
  private me: Promise<{ id: number; username: string }> | null = null;

  constructor(
    private readonly access: AlertBotAccess,
    private readonly telegram: AlertBotTelegram,
    private readonly store: AlertBotStore,
    private readonly commands: AlertBotCommands,
    private readonly drafts: AlertBotDrafts,
    private readonly turns: AlertBotTurns,
    private readonly support: SupportService,
  ) {}

  async claimUpdate(update: unknown): Promise<boolean> {
    const updateId = (update as TelegramUpdate)?.update_id;
    if (!Number.isSafeInteger(updateId)) return false;
    return this.store.claimUpdate(Number(updateId), update);
  }

  async handleUpdate(update: unknown, alreadyClaimed = false): Promise<void> {
    const candidate = update as TelegramUpdate;
    if (!Number.isSafeInteger(candidate?.update_id)) return;
    const updateId = Number(candidate.update_id);
    if (this.activeUpdates.has(updateId)) return;
    this.activeUpdates.add(updateId);
    let claimed = alreadyClaimed;
    try {
      if (!claimed) {
        claimed = await this.store.claimUpdate(updateId, candidate);
        if (!claimed) return;
      }
      if (candidate.callback_query) {
        await this.handleCallback(updateId, candidate.callback_query);
      } else if (candidate.message) {
        await this.handleMessage(updateId, candidate.message);
      }
      await this.store.completeUpdate(updateId);
    } catch (error) {
      const kind = safeErrorKind(error);
      this.logger.error(`alert-bot update failed kind=${kind}`);
      if (!claimed) return;
      let final = false;
      try {
        final = await this.store.failUpdate(updateId, kind);
      } catch (failureError) {
        // Строка остаётся processing только до periodic lease sweep.
        this.logger.error(`alert-bot retry state failed kind=${safeErrorKind(failureError)}`);
        return;
      }
      if (final) await this.sendFinalFailure(candidate);
    } finally {
      this.activeUpdates.delete(updateId);
    }
  }

  async retryFailedUpdates(): Promise<void> {
    await this.store.requeueProcessingUpdates(60);
    const due = await this.store.dueUpdates();
    for (const item of due) await this.handleUpdate(item.payload);
  }

  private async sendFinalFailure(update: TelegramUpdate): Promise<void> {
    const message = update.message || update.callback_query?.message;
    if (!message) return;
    try {
      await this.telegram.sendMessage(
        String(message.chat.id),
        'Не удалось обработать запрос. Попробуйте ещё раз позже.',
        message.message_id,
      );
    } catch (error) {
      this.logger.error(`alert-bot final failure notice failed kind=${safeErrorKind(error)}`);
    }
  }

  private async handleCallback(updateId: number, callback: TelegramCallback): Promise<void> {
    const match = String(callback.data || '').match(
      /^draft:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(send|ask|cancel)$/i,
    );
    if (!match) {
      await this.telegram.answerCallbackQuery(callback.id, 'Неизвестное действие');
      return;
    }

    const message = callback.message;
    if (!message || !alertBotAllowedChat(String(message.chat.id), message.chat.type)) {
      await this.telegram.answerCallbackQuery(callback.id, 'Действие недоступно в этом чате');
      return;
    }
    if (!callback.from?.id) {
      await this.telegram.answerCallbackQuery(callback.id, 'Действие недоступно');
      return;
    }

    const identity = await this.access.resolveTelegram(callback.from.id);
    if (!identity.isAdmin || !identity.userId) {
      await this.telegram.answerCallbackQuery(callback.id, 'Доступ только для администраторов');
      return;
    }

    const tgUserId = String(callback.from.id);
    const result = await this.drafts.handleCallback({
      callbackId: callback.id,
      chatId: String(message.chat.id),
      tgUserId,
      adminUserId: identity.userId,
      draftId: match[1],
      action: match[2].toLowerCase() as 'send' | 'ask' | 'cancel',
      messageId: message.message_id,
    });
    if (result.question) {
      const reserved = result.draftId !== undefined
        && result.claimVersion !== undefined
        && result.guardToken !== undefined;
      let admission: Awaited<ReturnType<AlertBotTurns['enqueue']>>;
      try {
        admission = await this.turns.enqueue({
          updateId,
          chatId: String(message.chat.id),
          tgUserId,
          adminUserId: identity.userId,
          questionMessageId: message.message_id,
          question: result.question,
          privateChat: message.chat.type === 'private',
          ticketId: result.ticketId || null,
        }, reserved ? { draftId: result.draftId!, claimVersion: result.claimVersion! } : undefined);
        if (reserved && admission !== 'accepted') {
          // Сначала все попытки fenced release в БД; локальный guard снимает
          // только outer finally с owner token этой reservation.
          await this.drafts.releaseAsk(result.draftId!, result.claimVersion!);
        }
      } catch (error) {
        if (reserved) {
          try {
            await this.drafts.releaseAsk(result.draftId!, result.claimVersion!);
          } catch (releaseError) {
            this.logger.error(`alert-bot draft release failed kind=${safeErrorKind(releaseError)}`);
          }
        }
        throw error;
      } finally {
        if (reserved) this.drafts.finishAsk(result.draftId!, result.guardToken!);
      }
      const ackText = admission === 'accepted'
        ? 'Вопрос принят'
        : admission === 'busy'
          ? 'Занят, спросите через минуту'
          : admission === 'rate_limited'
            ? 'Лимит вопросов в час исчерпан'
            : 'Черновик устарел';
      try {
        await this.telegram.answerCallbackQuery(callback.id, ackText);
      } catch {
        // Admission уже известен; косметический ack не повторяет update или модель.
      }
    }
  }

  private async handleMessage(updateId: number, message: TgMessage): Promise<void> {
    const chatId = String(message.chat.id);
    const privateChat = message.chat.type === 'private';
    if (!alertBotAllowedChat(chatId, message.chat.type)) return;

    const text = typeof message.text === 'string' ? message.text.trim() : '';
    if (!text) {
      if (!privateChat || !message.from?.id) return;
      const identity = await this.access.resolveTelegram(message.from.id);
      if (!identity.isAdmin || !identity.userId) {
        await this.refuse(message, String(message.from.id));
        return;
      }
      await this.telegram.sendMessage(chatId, 'Понимаю только текст', message.message_id);
      return;
    }

    const me = await this.botIdentity();
    const command = parseCommand(text);
    if (command?.username && command.username.toLowerCase() !== me.username.toLowerCase()) return;

    const replyToBot = message.reply_to_message?.from?.id !== undefined
      && String(message.reply_to_message.from.id) === String(me.id);
    const mention = new RegExp(`@${escapeRegExp(me.username)}\\b`, 'i');
    const addressed = privateChat || replyToBot || Boolean(command) || mention.test(text);
    if (!addressed || !message.from?.id) return;

    const resolved = await this.access.resolveTelegram(message.from.id);
    const tgUserId = String(message.from.id);
    if (!resolved.isAdmin || !resolved.userId) {
      await this.refuse(message, tgUserId);
      return;
    }
    const identity: Identity = { tgUserId, adminUserId: resolved.userId };

    if (command?.name === 'start' || command?.name === 'status') {
      const result = command.name === 'start'
        ? await this.commands.start()
        : await this.commands.status();
      await this.telegram.sendMessage(chatId, result, message.message_id);
      return;
    }
    if (command?.name === 'close') {
      const repliedPrefix = ticketPrefix(replyText(message.reply_to_message) || '');
      const ref = command.args || (repliedPrefix ? `#${repliedPrefix}` : '');
      if (!ref) {
        await this.telegram.sendMessage(chatId, CLOSE_HINT, message.message_id);
        return;
      }
      const result = await this.commands.close(ref, identity);
      await this.telegram.sendMessage(chatId, result, message.message_id);
      return;
    }

    const question = command?.name === 'ask'
      ? command.args
      : text.replace(new RegExp(`@${escapeRegExp(me.username)}\\b`, 'gi'), '').trim();
    if (!question) {
      await this.telegram.sendMessage(chatId, ASK_HINT, message.message_id);
      return;
    }

    const repliedText = replyText(message.reply_to_message);
    if (replyToBot && message.reply_to_message) {
      const parent = await this.store.findTurnByAnswer(chatId, message.reply_to_message.message_id);
      if (parent) {
        await this.enqueue(updateId, message, identity, question, {
          parentTurnId: parent.id,
          replyText: repliedText,
        });
        return;
      }
    }

    const repliedPrefix = ticketPrefix(repliedText || '');
    if (message.reply_to_message && repliedPrefix && (replyToBot || command?.name === 'ask')) {
      let ticket: Awaited<ReturnType<SupportService['findTicketByPrefix']>>;
      try {
        ticket = await this.support.findTicketByPrefix(repliedPrefix);
      } catch (error) {
        if (!isAmbiguousTicket(error)) throw error;
        await this.telegram.sendMessage(
          chatId,
          'Найдено несколько тикетов с таким префиксом. Укажите полный UUID.',
          message.message_id,
        );
        return;
      }
      if (ticket) {
        if (command?.name === 'ask') {
          await this.enqueue(updateId, message, identity, question, {
            replyText: repliedText,
            ticketId: ticket.id,
          });
        } else {
          const notice = await this.drafts.maybeDraft({
            chatId,
            questionMessageId: message.message_id,
            text: question,
            identity,
            ticket,
          });
          if (notice) await this.telegram.sendMessage(chatId, notice, message.message_id);
        }
        return;
      }
    }

    await this.enqueue(updateId, message, identity, question, { replyText: repliedText });
  }

  private async enqueue(
    updateId: number,
    message: TgMessage,
    identity: Identity,
    question: string,
    extra: { parentTurnId?: string; replyText?: string; ticketId?: string },
  ): Promise<void> {
    await this.turns.enqueue({
      updateId,
      chatId: String(message.chat.id),
      tgUserId: identity.tgUserId,
      adminUserId: identity.adminUserId,
      questionMessageId: message.message_id,
      question,
      privateChat: message.chat.type === 'private',
      ...extra,
    });
  }

  private botIdentity(): Promise<{ id: number; username: string }> {
    if (!this.me) {
      this.me = this.telegram.getMe().catch((error) => {
        this.me = null;
        throw error;
      });
    }
    return this.me;
  }

  private async refuse(message: TgMessage, tgUserId: string): Promise<void> {
    const now = Date.now();
    const previous = this.refusalSentAt.get(tgUserId) || 0;
    if (now - previous < REFUSAL_EVERY_MS) return;
    for (const [key, sentAt] of this.refusalSentAt) {
      if (now - sentAt >= REFUSAL_EVERY_MS) this.refusalSentAt.delete(key);
    }
    await this.telegram.sendMessage(
      String(message.chat.id),
      'Доступ только для администраторов',
      message.message_id,
    );
    this.refusalSentAt.set(tgUserId, now);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
