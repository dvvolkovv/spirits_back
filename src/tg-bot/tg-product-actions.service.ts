import { Injectable, Logger } from '@nestjs/common';
import { ProductActionsService } from '../products/product-actions.service';
import { ProductLifecycleService, DELETE_GRACE_DAYS } from '../products/product-lifecycle.service';
import { TgGrammyClient } from './tg-grammy.client';
import { TgIdentityService } from './tg-identity.service';
import { formatTgDate, tgText } from './tg-i18n';

const TMA_URL = process.env.TMA_URL || 'https://my.linkeon.io/tma/';
const CABINET = (process.env.BACKEND_URL || 'https://my.linkeon.io').replace(/\/$/, '');
const CALLBACK_RE = /^pa:(ok|no):([0-9a-f-]{36})$/i;

export function shouldRouteToProductActions(data: string): boolean {
  return typeof data === 'string' && data.startsWith('pa:');
}

/**
 * Карточки продуктов в Telegram. Удаление — кнопками под отдельным
 * сообщением: нажатие засчитывается, только если нажал привязанный Telegram
 * владельца действия. Ключи бота — только формой мини-приложения (в группе
 * кнопка мини-приложения недоступна — там ссылка на кабинет): в переписку
 * ключи не идут никогда.
 */
@Injectable()
export class TgProductActionsService {
  private readonly logger = new Logger(TgProductActionsService.name);

  constructor(
    private readonly actions: ProductActionsService,
    private readonly lifecycle: ProductLifecycleService,
    private readonly grammy: TgGrammyClient,
    private readonly identity: TgIdentityService,
  ) {}

  async sendForTurn(i: { userId: string; turn: string; since: Date; chatId: number; isPrivate: boolean; lang: string }): Promise<void> {
    const taken = await this.actions.takeForTurn(i.userId, i.turn, i.since, 'telegram');
    for (const a of taken) {
      const name = String(a.payload?.name ?? '');
      let text: string;
      let reply_markup: any;
      if (a.kind === 'delete') {
        const date = formatTgDate(i.lang, new Date(Date.now() + DELETE_GRACE_DAYS * 86_400_000));
        text = tgText(i.lang, 'pa_delete_prompt', { name, date });
        reply_markup = { inline_keyboard: [[
          { text: tgText(i.lang, 'pa_delete_btn'), callback_data: `pa:ok:${a.id}` },
          { text: tgText(i.lang, 'pa_cancel_btn'), callback_data: `pa:no:${a.id}` },
        ]] };
      } else {
        text = tgText(i.lang, 'pa_create_bot_prompt', { name });
        reply_markup = { inline_keyboard: [[
          i.isPrivate
            ? { text: tgText(i.lang, 'pa_create_bot_btn'), web_app: { url: `${TMA_URL}#pa=${a.id}` } }
            : { text: tgText(i.lang, 'pa_open_cabinet_btn'), url: `${CABINET}/studio?tab=products&action=${a.id}` },
        ]] };
      }
      const sent: any = await this.grammy.sendMessage(i.chatId, text, { reply_markup });
      if (sent?.message_id) await this.actions.setTelegramMessage(a.id, i.chatId, sent.message_id);
    }
  }

  async handleCallback(cb: any): Promise<void> {
    const m = CALLBACK_RE.exec(String(cb?.data ?? ''));
    await this.grammy.answerCallbackQuery(cb.id, {}).catch(() => undefined);
    if (!m) return;
    const [, verb, id] = m;
    const action = await this.actions.getById(id);
    if (!action) return;
    const owner = await this.identity.getIdentityByLinkeonId(action.user_id);
    if (!owner || Number(owner.tgUserId) !== Number(cb?.from?.id)) return;
    const lang = cb?.from?.language_code ?? null;
    const chatId = cb?.message?.chat?.id;
    const messageId = cb?.message?.message_id;
    const name = String(action.product_name ?? action.payload?.name ?? '');
    let text: string;
    if (verb === 'no') {
      text = (await this.actions.cancel(action.user_id, id)) ? tgText(lang, 'pa_cancelled') : tgText(lang, 'pa_closed');
    } else if (action.kind === 'delete') {
      const r = await this.lifecycle.completeDelete({ userId: action.user_id, actionId: id, via: 'telegram' });
      // Сравнение с литералом, а не по истинности: без strictNullChecks TypeScript
      // не сужает объединение через `r.ok ? …` и `!r.ok`.
      text = r.ok === true
        ? tgText(lang, 'pa_deleted', { name, date: formatTgDate(lang, r.restoreUntil) })
        : r.reason === 'not_pending' ? tgText(lang, 'pa_closed') : tgText(lang, 'pa_failed', { reason: r.message });
    } else {
      return;
    }
    if (chatId && messageId) {
      await this.grammy.editMessageText(chatId, messageId, text, { reply_markup: { inline_keyboard: [] } })
        .catch((e: any) => this.logger.warn(`карточка продукта: сообщение не поправлено: ${e?.message}`));
    }
  }
}
