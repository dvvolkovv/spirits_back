import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { TgGrammyClient } from './tg-grammy.client';
import { TgBotConfigRow } from './tg-config.service';
import { TgBillingService } from './tg-billing.service';
import { TgIdentityService } from './tg-identity.service';
import { AgentsService } from '../agents/agents.service';
import { TgConfigService } from './tg-config.service';
import { buildAssistantsKeyboard } from './tg-assistants-keyboard';
import { SUPPORTED_LANGUAGES } from '../common/services/language.service';
import { escapeHtml } from './tg-html';
import { tgText, formatTgNumber, ownerTgLanguage, pickTgLanguage, TgLang, TgTextKey } from './tg-i18n';

/**
 * Родные названия языков — те же, что показывает сайт и мини-апп
 * (src/i18n/languages.ts во фронте). Список кодов берём из
 * language.service, чтобы не разошёлся второй источник правды: тут только
 * подписи для кнопок.
 */
const LANGUAGE_LABELS: Record<string, string> = {
  ru: 'Русский', en: 'English', es: 'Español', de: 'Deutsch',
  fr: 'Français', zh: '中文', pt: 'Português',
};

/** Как бот описывает свой режим в /help. */
const MODE_KEY: Record<string, TgTextKey> = {
  strict: 'mode_strict',
  always: 'mode_always',
  smart: 'mode_smart',
};

@Injectable()
export class TgCommandsService {
  private readonly logger = new Logger(TgCommandsService.name);

  constructor(
    private readonly pg: PgService,
    private readonly grammy: TgGrammyClient,
    private readonly billing: TgBillingService,
    private readonly identity: TgIdentityService,
    private readonly agents: AgentsService,
    private readonly configs: TgConfigService,
  ) {}

  /**
   * /language — выбрать язык. До этого сменить его из бота было нельзя вовсе:
   * только веб или мини-апп. Пишем в то же profile_data.language, что и они —
   * один источник правды, как и с текущим ассистентом.
   */
  async handleLanguage(msg: any, ownerId: string): Promise<void> {
    const prof = await this.pg.query(
      `SELECT profile_data->>'language' AS language FROM ai_profiles_consolidated WHERE user_id = $1 LIMIT 1`,
      [ownerId],
    );
    const current = prof.rows[0]?.language ?? null;
    const lang = pickTgLanguage(current, null);
    await this.grammy.sendMessage(msg.chat.id, tgText(lang, 'language_prompt'), {
      reply_markup: {
        inline_keyboard: SUPPORTED_LANGUAGES.map((code) => [
          {
            text: code === current ? `✓ ${LANGUAGE_LABELS[code]}` : LANGUAGE_LABELS[code],
            callback_data: `lang:${code}`,
          },
        ]),
      },
    });
  }

  /**
   * Нажатие на язык. Код сверяем со списком: callback_data приходит от
   * клиента, и незнакомый код молча уехал бы в профиль, а оттуда — в
   * системный промпт ассистента.
   */
  async handleLanguageCallback(cb: any, ownerId: string): Promise<void> {
    const code = String(cb.data || '').slice('lang:'.length);
    if (!(SUPPORTED_LANGUAGES as readonly string[]).includes(code)) {
      this.logger.warn(`callback с неизвестным языком "${code}" от ${ownerId}`);
      const lang = await ownerTgLanguage(this.pg, ownerId);
      await this.grammy.answerCallbackQuery(cb.id, { text: tgText(lang, 'language_unknown') });
      return;
    }

    await this.pg.query(
      `UPDATE ai_profiles_consolidated
          SET profile_data = COALESCE(profile_data, '{}'::jsonb) || $1::jsonb,
              updated_at = now()
        WHERE user_id = $2`,
      [JSON.stringify({ language: code }), ownerId],
    );
    await this.grammy.answerCallbackQuery(cb.id, {});
    // Подтверждение — уже на новом языке: человек сразу видит, что сработало.
    await this.grammy.sendMessage(cb.message.chat.id, tgText(code, 'language_set', { language: escapeHtml(LANGUAGE_LABELS[code]) }), {
      parse_mode: 'HTML',
    });
  }

  /**
   * /assistants — список ассистентов с пометкой текущего.
   *
   * Только для лички: в группе ассистент привязан к чату, и смена одним
   * участником сбивала бы разговор остальных.
   */
  async handleAssistants(msg: any, ownerId: string, page = 0): Promise<void> {
    const agents = await this.agents.getAgents();
    const prof = await this.pg.query(
      `SELECT preferred_agent, profile_data->>'language' AS language FROM ai_profiles_consolidated WHERE user_id = $1 LIMIT 1`,
      [ownerId],
    );
    const current = prof.rows[0]?.preferred_agent ?? null;
    const lang = pickTgLanguage(prof.rows[0]?.language, null);
    await this.grammy.sendMessage(
      msg.chat.id,
      current ? tgText(lang, 'assistants_current', { agent: escapeHtml(current) }) : tgText(lang, 'assistants_prompt'),
      { parse_mode: 'HTML', reply_markup: buildAssistantsKeyboard(agents, page, current, lang) },
    );
  }

  /**
   * Нажатие на карточку ассистента.
   *
   * Имя из callback_data сверяем со списком: callback_data приходит от
   * клиента, доверять ему нельзя — иначе в preferred_agent уедет любая
   * строка, и резолвинг будет каждый раз падать в фолбэк.
   */
  async handleAgentCallback(cb: any, ownerId: string): Promise<void> {
    const name = String(cb.data || '').slice('agent:'.length);
    const agents = await this.agents.getAgents();
    const lang = await ownerTgLanguage(this.pg, ownerId);
    if (!agents.some((a: any) => a.name === name)) {
      this.logger.warn(`callback с неизвестным ассистентом "${name}" от ${ownerId}`);
      await this.grammy.answerCallbackQuery(cb.id, { text: tgText(lang, 'assistant_unknown') });
      return;
    }

    await this.agents.changeAgent(ownerId, name);
    await this.grammy.answerCallbackQuery(cb.id, {});
    await this.grammy.sendMessage(cb.message.chat.id, tgText(lang, 'assistant_set', { agent: escapeHtml(name) }), {
      parse_mode: 'HTML',
    });

    // Отметка в ленте: история в личке одна на всех ассистентов, и без неё
    // следующий ассистент получит контекст, где он же якобы говорил чужим
    // голосом.
    const cfg = await this.configs.getActiveByTgChatId(cb.message.chat.id);
    if (cfg) {
      await this.pg.query(
        `INSERT INTO tg_bot_messages (config_id, tg_chat_id, tg_user_id, role, content, content_type, tokens_charged)
         VALUES ($1, $2, $3, 'assistant', $4, 'text', 0)`,
        [cfg.id, cb.message.chat.id, cb.from.id, tgText(lang, 'assistant_switched_note', { agent: name })],
      );
    }
  }

  /**
   * Если text — команда из нашего списка, обработать и вернуть true.
   * Иначе — false (роутер пойдёт дальше в LLM).
   */
  async tryHandle(cfg: TgBotConfigRow, msg: any): Promise<boolean> {
    const text = (msg.text || '').toLowerCase().trim();
    if (!text.startsWith('/')) return false;

    // Strip @-suffix и аргументы: "/balance@LinkeonAgentBot arg" → "/balance".
    // Команда другому боту («/help@ДругойБот») — не наша: раньше на неё
    // приходила наша справка.
    const [cmd, addressee] = text.split(/\s/)[0].split('@');
    const own = (process.env.TG_BOT_USERNAME || 'LinkeonAgentBot').toLowerCase();
    if (addressee && addressee !== own) return false;
    const isOwner = await this.isOwner(cfg, msg.from.id);

    switch (cmd) {
      // Голый /start в группе чаще всего пишут другому боту: молча
      // перехватываем, чтобы не уйти в платный ход, но и справкой не
      // отвечаем. Наш /start@бот без кода (с кодом его раньше разбирает
      // привязка группы) — та же справка.
      case '/start':   if (addressee) await this.handleHelp(cfg, msg);  return true;
      case '/help':    await this.handleHelp(cfg, msg);                 return true;
      case '/assistants':
      case '/language': await this.handleDmOnly(cfg, msg);             return true;
      case '/balance': await this.handleBalance(cfg, msg, isOwner);     return true;
      case '/silent':  await this.handleSilent(cfg, msg, isOwner);      return true;
      case '/resume':  await this.handleResume(cfg, msg, isOwner);      return true;
      default: return false;
    }
  }

  private async isOwner(cfg: TgBotConfigRow, tgUserId: number): Promise<boolean> {
    const id = await this.identity.getIdentityByLinkeonId(cfg.owner_user_id);
    return id?.tgUserId === tgUserId;
  }

  /** Язык группы — язык владельца бота (язык его профиля). */
  private ownerLang(cfg: TgBotConfigRow): Promise<TgLang> {
    return ownerTgLanguage(this.pg, cfg.owner_user_id);
  }

  private async handleHelp(cfg: TgBotConfigRow, msg: any): Promise<void> {
    const lang = await this.ownerLang(cfg);
    const mode = MODE_KEY[cfg.addressing_mode] ?? 'mode_strict';
    // Имя задаёт владелец: «Fin_Bot» в legacy-Markdown открывал курсив без
    // пары, и Telegram отклонял всё сообщение — справки не было вовсе.
    const text = tgText(lang, 'group_help', { name: escapeHtml(cfg.display_name), mode: tgText(lang, mode) });
    await this.grammy.sendMessage(msg.chat.id, text, {
      parse_mode: 'HTML',
      reply_to_message_id: msg.message_id,
    });
  }

  /**
   * /assistants и /language в группе. Меню команд Telegram показывает их и
   * там, и раньше они уходили в платный ход модели — за счёт владельца и с
   * рассуждением ассистента о команде. Ассистента группы меняют в кабинете,
   * личного — в личке, язык — тоже в личке.
   */
  private async handleDmOnly(cfg: TgBotConfigRow, msg: any): Promise<void> {
    const lang = await this.ownerLang(cfg);
    const bot = process.env.TG_BOT_USERNAME || 'LinkeonAgentBot';
    await this.grammy.sendMessage(msg.chat.id, tgText(lang, 'dm_only', { bot }), {
      reply_to_message_id: msg.message_id,
    });
  }

  private async replyOwnerOnly(cfg: TgBotConfigRow, msg: any): Promise<void> {
    await this.grammy.sendMessage(msg.chat.id, tgText(await this.ownerLang(cfg), 'owner_only'), {
      reply_to_message_id: msg.message_id,
    });
  }

  private async handleBalance(cfg: TgBotConfigRow, msg: any, isOwner: boolean): Promise<void> {
    if (!isOwner) {
      await this.replyOwnerOnly(cfg, msg);
      return;
    }
    const bal = await this.billing.getBalance(cfg.owner_user_id);
    const lang = await this.ownerLang(cfg);
    await this.grammy.sendMessage(
      msg.chat.id,
      tgText(lang, 'balance', { balance: formatTgNumber(lang, bal) }),
      { parse_mode: 'HTML', reply_to_message_id: msg.message_id },
    );
  }

  private async handleSilent(cfg: TgBotConfigRow, msg: any, isOwner: boolean): Promise<void> {
    if (!isOwner) {
      await this.replyOwnerOnly(cfg, msg);
      return;
    }
    await this.pg.query(`UPDATE tg_bot_configs SET status = 'silent' WHERE id = $1`, [cfg.id]);
    await this.grammy.sendMessage(msg.chat.id, tgText(await this.ownerLang(cfg), 'group_silenced'), {
      reply_to_message_id: msg.message_id,
    });
  }

  private async handleResume(cfg: TgBotConfigRow, msg: any, isOwner: boolean): Promise<void> {
    if (!isOwner) {
      await this.replyOwnerOnly(cfg, msg);
      return;
    }
    await this.pg.query(`UPDATE tg_bot_configs SET status = 'active' WHERE id = $1`, [cfg.id]);
    await this.grammy.sendMessage(msg.chat.id, tgText(await this.ownerLang(cfg), 'group_resumed'), {
      reply_to_message_id: msg.message_id,
    });
  }
}
