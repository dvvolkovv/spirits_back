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
    await this.grammy.sendMessage(msg.chat.id, 'На каком языке отвечать?', {
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
      await this.grammy.answerCallbackQuery(cb.id, { text: 'Такого языка нет' });
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
    await this.grammy.sendMessage(cb.message.chat.id, `Готово, отвечаю на: *${LANGUAGE_LABELS[code]}*.`, {
      parse_mode: 'Markdown',
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
      `SELECT preferred_agent FROM ai_profiles_consolidated WHERE user_id = $1 LIMIT 1`,
      [ownerId],
    );
    const current = prof.rows[0]?.preferred_agent ?? null;
    await this.grammy.sendMessage(
      msg.chat.id,
      current ? `Сейчас отвечает *${current}*. Кого позвать?` : 'Кого позвать?',
      { parse_mode: 'Markdown', reply_markup: buildAssistantsKeyboard(agents, page, current) },
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
    if (!agents.some((a: any) => a.name === name)) {
      this.logger.warn(`callback с неизвестным ассистентом "${name}" от ${ownerId}`);
      await this.grammy.answerCallbackQuery(cb.id, { text: 'Такого ассистента нет' });
      return;
    }

    await this.agents.changeAgent(ownerId, name);
    await this.grammy.answerCallbackQuery(cb.id, {});
    await this.grammy.sendMessage(cb.message.chat.id, `Теперь отвечает *${name}*.`, {
      parse_mode: 'Markdown',
    });

    // Отметка в ленте: история в личке одна на всех ассистентов, и без неё
    // следующий ассистент получит контекст, где он же якобы говорил чужим
    // голосом.
    const cfg = await this.configs.getActiveByTgChatId(cb.message.chat.id);
    if (cfg) {
      await this.pg.query(
        `INSERT INTO tg_bot_messages (config_id, tg_chat_id, tg_user_id, role, content, content_type, tokens_charged)
         VALUES ($1, $2, $3, 'assistant', $4, 'text', 0)`,
        [cfg.id, cb.message.chat.id, cb.from.id, `— Дальше отвечает ${name}. —`],
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

    // Strip @-suffix и аргументы: "/balance@LinkeonAgentBot arg" → "/balance"
    const cmd = text.split('@')[0].split(' ')[0];
    const isOwner = await this.isOwner(cfg, msg.from.id);

    switch (cmd) {
      case '/help':    await this.handleHelp(cfg, msg);                 return true;
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

  private async handleHelp(cfg: TgBotConfigRow, msg: any): Promise<void> {
    const modeMap: Record<string, string> = {
      strict: 'отвечает только по обращению',
      always: 'отвечает на каждое сообщение',
      smart:  'отвечает когда видит, что стоит вмешаться',
    };
    const text = `Я *${cfg.display_name}* — ${modeMap[cfg.addressing_mode]}.

Команды:
/help — это сообщение
/balance — баланс владельца (только владельцу)
/silent — замолчать (только владельцу)
/resume — возобновить (только владельцу)

Веб-кабинет: https://my.linkeon.io/telegram-bots`;
    await this.grammy.sendMessage(msg.chat.id, text, {
      parse_mode: 'Markdown',
      reply_to_message_id: msg.message_id,
    });
  }

  private async handleBalance(cfg: TgBotConfigRow, msg: any, isOwner: boolean): Promise<void> {
    if (!isOwner) {
      await this.grammy.sendMessage(msg.chat.id, 'Эта команда доступна только владельцу бота.', {
        reply_to_message_id: msg.message_id,
      });
      return;
    }
    const bal = await this.billing.getBalance(cfg.owner_user_id);
    await this.grammy.sendMessage(
      msg.chat.id,
      `Баланс: *${bal.toLocaleString('ru-RU')}* токенов.\nПополнить: https://my.linkeon.io/tokens`,
      { parse_mode: 'Markdown', reply_to_message_id: msg.message_id },
    );
  }

  private async handleSilent(cfg: TgBotConfigRow, msg: any, isOwner: boolean): Promise<void> {
    if (!isOwner) {
      await this.grammy.sendMessage(msg.chat.id, 'Эта команда доступна только владельцу бота.', {
        reply_to_message_id: msg.message_id,
      });
      return;
    }
    await this.pg.query(`UPDATE tg_bot_configs SET status = 'silent' WHERE id = $1`, [cfg.id]);
    await this.grammy.sendMessage(msg.chat.id, '🤫 Замолкаю до /resume.', {
      reply_to_message_id: msg.message_id,
    });
  }

  private async handleResume(cfg: TgBotConfigRow, msg: any, isOwner: boolean): Promise<void> {
    if (!isOwner) {
      await this.grammy.sendMessage(msg.chat.id, 'Эта команда доступна только владельцу бота.', {
        reply_to_message_id: msg.message_id,
      });
      return;
    }
    await this.pg.query(`UPDATE tg_bot_configs SET status = 'active' WHERE id = $1`, [cfg.id]);
    await this.grammy.sendMessage(msg.chat.id, '✅ Снова на связи.', {
      reply_to_message_id: msg.message_id,
    });
  }
}
