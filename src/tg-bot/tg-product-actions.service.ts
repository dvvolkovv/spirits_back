import { Injectable, Logger } from '@nestjs/common';
import { ProductActionsService, ActionRow } from '../products/product-actions.service';
import { ProductLifecycleService, DELETE_GRACE_DAYS } from '../products/product-lifecycle.service';
import { PgService } from '../common/services/pg.service';
import { TgGrammyClient } from './tg-grammy.client';
import { TgIdentityService } from './tg-identity.service';
import { formatTgDate, ownerTgLanguage, tgText } from './tg-i18n';

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
    // Язык результата нажатия: профиль владельца действия, а не язык
    // клиента Telegram того, кто нажал (см. handleCallback) — ровно как
    // везде в боте (ownerTgLanguage).
    private readonly pg: PgService,
  ) {}

  async sendForTurn(i: { userId: string; turn: string; since: Date; chatId: number; isPrivate: boolean; lang: string }): Promise<void> {
    const taken = await this.actions.takeForTurn(i.userId, i.turn, i.since, 'telegram');
    for (const a of taken) {
      // Каждая карточка — в своём try/catch: отказ Telegram на одной (бот
      // заблокирован, сообщение слишком длинное) не должен утащить с собой
      // остальные карточки этого хода — они уже забраны takeForTurn и больше
      // никому не отдадутся.
      try {
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
        } else if (a.kind === 'create_bot') {
          text = tgText(i.lang, 'pa_create_bot_prompt', { name });
          // Строка запроса, а не фрагмент: Telegram дописывает в адрес СВОИ
          // параметры запуска во фрагмент (#tgWebAppData=...), и не каждый
          // клиент гарантированно сохраняет фрагмент, который был в адресе
          // до открытия. Строку запроса Telegram не трогает вовсе — фронт
          // (actionFromLocation) читает её первой, а #pa= держит запасным
          // путём.
          const sep = TMA_URL.includes('?') ? '&' : '?';
          reply_markup = { inline_keyboard: [[
            i.isPrivate
              ? { text: tgText(i.lang, 'pa_create_bot_btn'), web_app: { url: `${TMA_URL}${sep}pa=${a.id}` } }
              : { text: tgText(i.lang, 'pa_open_cabinet_btn'), url: `${CABINET}/studio?tab=products&action=${a.id}` },
          ]] };
        } else {
          // keys (очередь 2) и прочие виды карточек сюда ещё не доведены —
          // карточка уже attached_at, молча теряться она не должна, но и
          // слать по ней нечего.
          this.logger.warn(`карточка продукта неизвестного вида "${a.kind}" пропущена (action ${a.id})`);
          continue;
        }
        const sent: any = await this.grammy.sendMessage(i.chatId, text, { reply_markup });
        if (sent?.message_id) await this.actions.setTelegramMessage(a.id, i.chatId, sent.message_id);
      } catch (e: any) {
        this.logger.warn(`карточка продукта не отправлена в чат ${i.chatId} (action ${a.id}): ${e?.message}`);
      }
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
    // Язык результата — язык профиля владельца действия, а не язык клиента
    // Telegram того, кто нажал: это тот же человек почти всегда, но не
    // обязательно (может нажать с другого устройства/языка интерфейса), и
    // результат должен звучать так же, как кабинет и остальной бот.
    const lang = await ownerTgLanguage(this.pg, action.user_id, cb?.from?.language_code ?? null);
    const chatId = cb?.message?.chat?.id;
    const messageId = cb?.message?.message_id;
    const name = String(action.product_name ?? action.payload?.name ?? '');
    let text: string;
    if (verb === 'no') {
      text = (await this.actions.cancel(action.user_id, id))
        ? tgText(lang, 'pa_cancelled')
        : await this.textForClosedAction(id, lang, name);
    } else if (action.kind === 'delete') {
      const r = await this.lifecycle.completeDelete({ userId: action.user_id, actionId: id, via: 'telegram' });
      // Сравнение с литералом, а не по истинности: без strictNullChecks TypeScript
      // не сужает объединение через `r.ok ? …` и `!r.ok`.
      if (r.ok === true) {
        text = tgText(lang, 'pa_deleted', { name, date: formatTgDate(lang, r.restoreUntil) });
      } else if (r.reason === 'not_pending') {
        // Повторное нажатие или нажатие после того, как действие закрылось
        // где-то ещё (кабинет, другая реплика карточки) — показываем текст по
        // тому, что действие на самом деле стало, а не общий «не закрыто».
        text = await this.textForClosedAction(id, lang, name);
      } else if (r.reason === 'gone') {
        text = tgText(lang, 'pa_gone');
      } else {
        // Сырой r.message — только в лог бэкенда (его уже написал
        // completeDelete), сюда он не идёт: это русский/технический текст,
        // который задваивал бы «Не получилось» на других языках.
        text = tgText(lang, 'pa_failed');
      }
    } else {
      return;
    }
    if (chatId && messageId) {
      await this.grammy.editMessageText(chatId, messageId, text, { reply_markup: { inline_keyboard: [] } })
        .catch((e: any) => this.logger.warn(`карточка продукта: сообщение не поправлено: ${e?.message}`));
    }
  }

  /**
   * Текст для «действие уже не ждёт»: не единое «подтверждение закрыто», а по
   * фактическому статусу — повторное нажатие после удаления или отмены (в
   * этом же чате вторым нажатием, из кабинета, из другой реплики карточки)
   * должно звучать как исход, а не как отказ.
   */
  private async textForClosedAction(id: string, lang: string, name: string): Promise<string> {
    const row: ActionRow | null = await this.actions.getById(id);
    if (row?.status === 'done' && typeof row.result?.restoreUntil === 'string') {
      return tgText(lang, 'pa_deleted', { name, date: formatTgDate(lang, row.result.restoreUntil) });
    }
    if (row?.status === 'cancelled') return tgText(lang, 'pa_cancelled');
    return tgText(lang, 'pa_closed');
  }
}
