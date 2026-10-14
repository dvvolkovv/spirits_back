import { Inject, Injectable, Logger, OnModuleInit, forwardRef } from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PgService } from '../common/services/pg.service';
import { TgIdentityService, TgIdentityConflictError } from './tg-identity.service';
import { TgClaimService } from './tg-claim.service';
import { TgConfigService, TgBotConfigRow } from './tg-config.service';
import { TgRouterService, isForeignBotCommand } from './tg-router.service';
import { isPrivateConfig } from './tg-chat-kind';
import { escapeHtml } from './tg-html';
import { tgText, formatTgNumber, ownerTgLanguage, pickTgLanguage, TgLang, TgTextKey } from './tg-i18n';
import { TgClaimFailure } from './tg-claim.service';
import { TgMeetingService } from './tg-meeting.service';
import { TgVoiceService } from './tg-voice.service';
import { TgBillingService } from './tg-billing.service';
import { TgCommandsService } from './tg-commands.service';
import { TgGrammyClient } from './tg-grammy.client';
import { MiscService } from '../misc/misc.service';
import { VideoService } from '../video/video.service';
import { BlogApprovalService } from '../blog/blog-approval.service';
import { fetchMediaBytes } from '../common/net/own-media';

// Лимит размера файла, который мы готовы скачать с Telegram и передать в Claude.
// Telegram сам отдаёт через Bot API до 20 МБ; больше — нужен MTProto, не наш кейс.
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

type OutgoingMarker =
  | { kind: 'image'; prompt: string }
  | { kind: 'image_edit'; source: string; prompt: string }
  | { kind: 'image_compose'; sources: string[]; prompt: string }
  | { kind: 'upscale'; source: string }
  | { kind: 'video'; prompt: string; source?: string; duration?: number; mode: 'text2video' | 'image2video'; model?: string }
  | { kind: 'file'; url: string; caption?: string; name?: string };

// Файлы которые мы готовы автоматически прикреплять из песочницы Claude.
// Скрипты и исходники намеренно НЕ включены — Claude может писать .py/.sh
// как рабочий код, артефактом считается то что юзеру полезно само по себе.
const SANDBOX_OUTPUT_EXTS = new Set([
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'rtf',
  'csv', 'tsv', 'txt', 'md', 'html', 'json', 'xml', 'yaml', 'yml',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'tiff',
  'mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac',
  'mp4', 'mov', 'webm', 'mkv', 'avi',
  'zip', 'tar', 'gz', 'tgz', '7z',
]);
const MAX_SANDBOX_OUTPUT_SIZE = 49 * 1024 * 1024; // Telegram document limit 50MB

/**
 * Корень постоянных рабочих папок ботов — по папке на чат.
 *
 * Не os.tmpdir(): systemd-tmpfiles чистит /tmp по своему возрасту, и файл
 * пользователя исчезал бы по чужому сроку, а не по нашему. Это ровно тот класс
 * сюрприза, который здесь и лечится.
 *
 * Функция, а не константа: путь читается из окружения на каждом вызове, иначе
 * его не подменить в тестах.
 */
function workspaceRoot(): string {
  return process.env.TG_WORKSPACE_ROOT || path.join(os.homedir(), '.linkeon', 'tg-workspace');
}

/** Сколько дней простоя переживает рабочая папка чата. */
const WORKSPACE_TTL_DAYS = Number(process.env.TG_WORKSPACE_TTL_DAYS || 7);

/** Потолок на папку одного чата. Сверх него сносим самые старые файлы. */
const WORKSPACE_MAX_BYTES = Number(process.env.TG_WORKSPACE_MAX_MB || 200) * 1024 * 1024;

/**
 * Адрес мини-аппа для кнопки привязки. Совпадает с Menu Button бота в
 * BotFather; вынесено в env на случай смены домена.
 */
const TMA_URL = process.env.TMA_URL || 'https://my.linkeon.io/tma/';

/**
 * Сколько ждём остальные части альбома после очередной приехавшей.
 *
 * Telegram растягивает доставку альбома на сотни миллисекунд; 2.5 с покрывают
 * это с запасом и при этом не превращаются в заметную задержку — ход с файлами
 * всё равно идёт десятки секунд. Таймер сбрасывается на каждой новой части,
 * поэтому окно считается от последней, а не от первой.
 */
const ALBUM_DEBOUNCE_MS = Number(process.env.TG_ALBUM_DEBOUNCE_MS || 2500);

/** Потолок альбома в Telegram. Набрали столько — ждать больше нечего. */
const ALBUM_MAX_PARTS = 10;

/** Почему не удалась привязка группы → что сказать человеку (tg-i18n). */
const CLAIM_FAILURE_TEXT: Record<TgClaimFailure, TgTextKey> = {
  expired: 'claim_expired',
  wrong_account: 'claim_wrong_account',
  group_taken: 'claim_group_taken',
  already_connected: 'claim_already_connected',
};

/** Эхо расшифровки голосового — подсказка «что я услышал», не стенограмма. */
const ECHO_MAX_CHARS = 1024;

/**
 * Кнопки блога приходят тем же вебхуком, что и кнопки ассистентов.
 *
 * Отдельная функция, а не строчка внутри роутера: порядок веток в
 * handleCallbackQuery — единственное, что отделяет нажатие владельца блога от
 * молчаливого `return` по непривязанному аккаунту, и его надо уметь проверять
 * тестом, не поднимая весь сервис.
 */
export function shouldRouteToBlog(data?: string): boolean {
  return String(data || '').startsWith('blog:');
}

@Injectable()
export class TgBotService implements OnModuleInit {
  private readonly logger = new Logger(TgBotService.name);
  // Throttle для busy-сообщения "минутку, заканчиваю предыдущее" —
  // не спамим если юзер пишет 10 сообщений подряд. In-memory, сбрасывается
  // при рестарте бэка, что приемлемо.
  private readonly lastBusyNoticeAt = new Map<number, number>();
  /**
   * Незакрытые альбомы: ключ — чат + media_group_id, значение — уже приехавшие
   * части и таймер дебаунса. Подробности почему это нужно — над bufferAlbumPart.
   *
   * In-memory осознанно: linkeon-api живёт одним процессом, части одного альбома
   * приходят в него же. Потеря буфера при рестарте равна потере хода — ровно то
   * же, что уже делает advisory lock, когда бэк перезапускают посреди ответа.
   */
  private readonly albumBuffers = new Map<string, { parts: any[]; timer: NodeJS.Timeout }>();

  constructor(
    private readonly pg: PgService,
    private readonly identity: TgIdentityService,
    private readonly claim: TgClaimService,
    private readonly configs: TgConfigService,
    private readonly router: TgRouterService,
    private readonly voice: TgVoiceService,
    private readonly billing: TgBillingService,
    private readonly commands: TgCommandsService,
    private readonly meetings: TgMeetingService,
    private readonly grammy: TgGrammyClient,
    private readonly misc: MiscService,
    private readonly video: VideoService,
    // Блог зовёт TgGrammyClient, а бот — блог: кольцо модулей рвётся forwardRef
    // с обеих сторон (вторая половина — в blog.module.ts).
    @Inject(forwardRef(() => BlogApprovalService))
    private readonly blogApproval: BlogApprovalService,
  ) {}

  async onModuleInit() {
    await this.applyMigration('001_tg_bot_schema.sql');
    await this.applyMigration('002_tg_bot_custom_agent_fk.sql');
    await this.applyMigration('003_tg_bot_video_delivery.sql');
    await this.applyMigration('004_tg_bot_answer_watch.sql');

    // Рабочие папки чатов больше не удаляются после хода — за диском следит
    // джанитор. unref(), чтобы таймер не держал процесс при завершении.
    await this.pruneWorkspaces().catch((e) => this.logger.warn(`workspace prune failed: ${e.message}`));
    setInterval(
      () => this.pruneWorkspaces().catch((e) => this.logger.warn(`workspace prune failed: ${e.message}`)),
      6 * 60 * 60 * 1000,
    ).unref();
  }

  private async applyMigration(filename: string) {
    const candidates = [
      path.join(__dirname, 'migrations', filename),
      path.join(__dirname, '..', '..', 'src', 'tg-bot', 'migrations', filename),
    ];
    for (const p of candidates) {
      try {
        if (fs.existsSync(p)) {
          await this.pg.query(fs.readFileSync(p, 'utf8'));
          this.logger.log(`tg-bot migration ${filename} applied from ${p}`);
          return;
        }
      } catch (e: any) {
        this.logger.error(`tg-bot migration ${filename} failed (${p}): ${e.message}`);
      }
    }
    this.logger.warn(`tg-bot migration ${filename} not found, skipping`);
  }

  async handleUpdate(update: any): Promise<void> {
    try {
      const msg = update.message ?? update.edited_message;
      if (msg) {
        await this.handleMessage(msg);
        return;
      }
      if (update.callback_query) {
        await this.handleCallbackQuery(update.callback_query);
        return;
      }
      if (update.my_chat_member) {
        await this.handleMyChatMember(update.my_chat_member);
        return;
      }
    } catch (e: any) {
      this.logger.error(`handleUpdate failed: ${e.message}\n${e.stack}`);
    }
  }

  private async handleMessage(msg: any): Promise<void> {
    // Группа стала супергруппой: у неё новый id, а конфиг бота держал старый —
    // бот в новой супергруппе молчал. Telegram шлёт два служебных сообщения:
    // migrate_to_chat_id — в старой группе, migrate_from_chat_id — в новой;
    // moveToChat идемпотентен, второе уже ничего не найдёт.
    if (msg.migrate_to_chat_id || msg.migrate_from_chat_id) {
      const fromChat = Number(msg.migrate_to_chat_id ? msg.chat.id : msg.migrate_from_chat_id);
      const toChat = Number(msg.migrate_to_chat_id ?? msg.chat.id);
      await this.configs.moveToChat(fromChat, toChat);
      return;
    }
    if (msg.from?.is_bot) return;
    if (msg.new_chat_members || msg.left_chat_member || msg.pinned_message) return;

    const chatType = msg.chat?.type;

    // В группах Telegram добавляет к командам @<botname>: `/start@LinkeonTestBot <token>`.
    // В личке — без суффикса. Парсим оба формата.
    const botUsername = process.env.TG_BOT_USERNAME || 'LinkeonAgentBot';
    const startToken = typeof msg.text === 'string' ? this.parseStartToken(msg.text, botUsername) : null;

    if (chatType === 'private' && startToken) {
      await this.handleDmStart(msg, startToken);
      return;
    }

    if (chatType === 'private' && (msg.text === '/start' || msg.text?.startsWith('/start@'))) {
      // Привязку проверяем ДО совета «подключись»: раньше эта ветка отвечала
      // одинаково всем, и уже привязанный человек получал предложение
      // подключиться ещё раз — выглядело так, будто бот его не узнаёт
      // (репорт владельца 28.08.2026, когда личка уже работала).
      const ownerId = await this.identity.getLinkeonIdByTgUserId(msg.from.id);
      if (!ownerId) {
        const lang = pickTgLanguage(null, msg.from?.language_code);
        await this.replyUnlinked(msg.chat.id, tgText(lang, 'start_unlinked'), lang);
        return;
      }
      const prof = await this.pg.query(
        `SELECT preferred_agent, profile_data->>'language' AS language FROM ai_profiles_consolidated WHERE user_id = $1 LIMIT 1`,
        [ownerId],
      );
      const current = prof.rows[0]?.preferred_agent;
      const lang = pickTgLanguage(prof.rows[0]?.language, null);
      await this.grammy.sendMessage(
        msg.chat.id,
        (current ? tgText(lang, 'start_hello_agent', { agent: escapeHtml(current) }) : tgText(lang, 'start_hello')) +
          '\n\n' + tgText(lang, 'start_body'),
        { parse_mode: 'HTML' },
      );
      return;
    }

    if (chatType === 'private' && typeof msg.text === 'string' && msg.text.startsWith('/')) {
      await this.handleDmCommand(msg);
      return;
    }

    // Обычный текст в личке — разговор с ассистентом. Раньше такой ветки не
    // было вовсе: бот молчал на всё, кроме /start и команд, и личного диалога
    // с ассистентами в Telegram просто не существовало.
    //
    // Ветка стоит ПОСЛЕ проверки на '/' — иначе команды уехали бы в ассистента.
    if (chatType === 'private') {
      // Реплай на черновик блога — это правка поста, а не реплика ассистенту.
      // Стоит до проверки привязки по той же причине, что и ветка кнопок:
      // владелец блога опознаётся по координатам сообщения-черновика.
      // handleReplyEdit возвращает false на всё чужое, и тогда текст идёт
      // обычным путём — перехватить лишнее значит сломать людям чат.
      if (await this.blogApproval.handleReplyEdit(msg)) return;

      const ownerId = await this.identity.getLinkeonIdByTgUserId(msg.from.id);
      if (!ownerId) {
        const lang = pickTgLanguage(null, msg.from?.language_code);
        await this.replyUnlinked(msg.chat.id, tgText(lang, 'unlinked_chat'), lang);
        return;
      }
      const cfg = await this.configs.ensurePrivateConfig(ownerId, msg.chat.id);
      await this.handleChatMessage(msg, cfg);
      return;
    }

    if (chatType === 'channel') {
      try { await this.grammy.leaveChat(msg.chat.id); } catch { /* ignore */ }
      return;
    }

    if (chatType === 'group' || chatType === 'supergroup') {
      // Команда другому боту — не нам. `/start@ДругойБот <код>` приходит, когда в
      // группу добавляют чужого бота: раньше наш принимал чужой код за свой, не
      // находил его и выходил из группы, бросая рабочий конфиг. А `/help@ДругойБот`
      // в режиме «на каждое сообщение» уходил в платный ход модели. В историю
      // чата такие строки тоже не пишем: чужие коды и команды модели ни к чему.
      // Подпись альбома не смотрим: она у одной части из нескольких, и выброс
      // её одной отдал бы модели альбом без фотографии.
      const said = typeof msg.text === 'string'
        ? msg.text
        : !msg.media_group_id && typeof msg.caption === 'string' ? msg.caption : '';
      if (isForeignBotCommand(said, botUsername)) {
        this.logger.debug(`chat ${msg.chat.id}: command for another bot, skipping`);
        return;
      }
      if (startToken) {
        await this.handleGroupClaim(msg, startToken);
        return;
      }
      await this.handleChatMessage(msg);
      return;
    }
  }

  // Парсит `/start <token>` и `/start@<botname> <token>`. Возвращает токен или null.
  // Токен с чужим @именем — не наш: это привязка другого бота.
  private parseStartToken(text: string, botUsername: string): string | null {
    const m = text.match(/^\/start(?:@(\w+))?\s+(\S+)/);
    if (!m) return null;
    if (m[1] && m[1].toLowerCase() !== botUsername.toLowerCase()) return null;
    return m[2];
  }

  /**
   * Ответ человеку, чей Telegram не привязан к Linkeon.
   *
   * Кнопка ведёт в мини-апп, и это принципиально: прежний текст советовал
   * «зайди в кабинет и нажми Подключить Telegram», но войти в веб-кабинет
   * можно только по телефону или почте — то есть человеку БЕЗ аккаунта
   * предлагали сделать то, чего он сделать не может. Мини-апп — единственная
   * дверь, где аккаунт заводится прямо из Telegram: он показывает экран
   * выбора «начать заново» / «у меня уже есть аккаунт».
   *
   * web_app-кнопки Telegram разрешает только в личных чатах — здесь мы
   * всегда в личке.
   */
  private async replyUnlinked(chatId: number, intro: string, lang: TgLang): Promise<void> {
    await this.grammy.sendMessage(chatId, intro, {
      reply_markup: {
        inline_keyboard: [[{ text: tgText(lang, 'open_linkeon'), web_app: { url: TMA_URL } }]],
      },
    });
  }

  /**
   * Нажатия инлайн-кнопок. Пока единственные — выбор ассистента и листание
   * его списка. Непривязанный пользователь молча игнорируется: кнопку он
   * может получить только из сообщения, которое бот прислал ему же, так что
   * это либо чужой forward, либо отвязка аккаунта между показом и нажатием.
   */
  private async handleCallbackQuery(cb: any): Promise<void> {
    const data = String(cb.data || '');

    // Ветка блога стоит ПЕРВОЙ и до проверки привязки: владелец блога
    // определяется не через связку ассистентов, и `if (!ownerId) return`
    // ниже молча проглотил бы нажатие «Опубликовать».
    if (shouldRouteToBlog(data)) {
      await this.blogApproval.handleCallback(cb);
      return;
    }

    const ownerId = await this.identity.getLinkeonIdByTgUserId(cb.from.id);
    if (!ownerId) return;

    if (data.startsWith('agent:')) {
      await this.commands.handleAgentCallback(cb, ownerId);
      return;
    }
    if (data.startsWith('lang:')) {
      await this.commands.handleLanguageCallback(cb, ownerId);
      return;
    }
    if (TgMeetingService.isJoin(data)) {
      await this.meetings.handleJoinCallback(cb, ownerId);
      return;
    }
    if (data.startsWith('agents_page:')) {
      const page = Number(data.split(':')[1]) || 0;
      // Ответ на нажатие гасит «часики» на кнопке — иначе они крутятся до
      // таймаута Telegram.
      await this.grammy.answerCallbackQuery(cb.id, {});
      await this.commands.handleAssistants(cb.message, ownerId, page);
      return;
    }
  }

  // Команды в личке с ботом: /help, /assistants, /language, /balance; /silent
  // глушит группы владельца (личку — нет), /resume будит всё, в том числе
  // лички, заглушённые прежним /silent.
  private async handleDmCommand(msg: any): Promise<void> {
    // `/case <история>` — реальный кейс в блог, команда владельца блога. Стоит
    // первой: разбор ниже переводит текст в нижний регистр и режет по пробелу,
    // а историю надо взять целиком и как написана. Чужой `/case` блог не берёт
    // (false) — он доходит до ответа про неизвестную команду, как и до
    // появления этой. В /help и в меню команд её нет намеренно.
    if (await this.blogApproval.handleCaseCommand(msg)) return;

    const text = msg.text.toLowerCase().trim();
    const cmd = text.split('@')[0].split(' ')[0];

    // Команда, которой нужен аккаунт, у непривязанного — кнопка в Linkeon.
    // Раньше часть команд советовала «зайди в кабинет и нажми «Подключить
    // Telegram»», но человеку без аккаунта в кабинет не войти (см. replyUnlinked).
    const needsAccount = async (): Promise<string | null> => {
      const ownerId = await this.identity.getLinkeonIdByTgUserId(msg.from.id);
      if (!ownerId) {
        const lang = pickTgLanguage(null, msg.from?.language_code);
        await this.replyUnlinked(msg.chat.id, tgText(lang, 'unlinked_command'), lang);
      }
      return ownerId;
    };

    if (cmd === '/language') {
      const ownerId = await needsAccount();
      if (!ownerId) return;
      await this.commands.handleLanguage(msg, ownerId);
      return;
    }

    if (cmd === '/assistants') {
      const ownerId = await needsAccount();
      if (!ownerId) return;
      await this.commands.handleAssistants(msg, ownerId);
      return;
    }

    if (cmd === '/help') {
      await this.grammy.sendMessage(msg.chat.id, tgText(await this.langOfTgUser(msg.from), 'dm_help'));
      return;
    }

    if (cmd === '/balance') {
      const ownerId = await needsAccount();
      if (!ownerId) return;
      const bal = await this.billing.getBalance(ownerId);
      const lang = await this.langFor(ownerId, msg.from);
      await this.grammy.sendMessage(
        msg.chat.id,
        tgText(lang, 'balance', { balance: formatTgNumber(lang, bal) }),
        { parse_mode: 'HTML' },
      );
      return;
    }

    if (cmd === '/silent' || cmd === '/resume') {
      const ownerId = await needsAccount();
      if (!ownerId) return;
      const targetStatus = cmd === '/silent' ? 'silent' : 'active';
      const fromStatuses = cmd === '/silent' ? ['active'] : ['silent'];
      // /silent — только группы: личка с ботом — разговор один на один, глушить
      // её нечего (раньше замолкала и она, и бот переставал отвечать владельцу).
      // /resume будит всё — в том числе лички, заглушённые той ошибкой.
      const groupsOnly = cmd === '/silent' ? ' AND tg_chat_id < 0' : '';
      const r = await this.pg.query(
        `UPDATE tg_bot_configs SET status = $1
          WHERE owner_user_id = $2 AND status = ANY($3::text[])${groupsOnly}
          RETURNING id, display_name, tg_chat_title, tg_chat_id`,
        [targetStatus, ownerId, fromStatuses],
      );
      // Язык — после UPDATE: ответ нужен только тому, что изменилось.
      const lang = await this.langFor(ownerId, msg.from);
      if (r.rowCount === 0) {
        await this.grammy.sendMessage(msg.chat.id, tgText(lang, cmd === '/silent' ? 'silent_none' : 'resume_none'));
        return;
      }
      const list = r.rows
        .map(b => isPrivateConfig(b)
          ? tgText(lang, 'list_private', { name: escapeHtml(b.display_name) })
          : b.tg_chat_title
            ? tgText(lang, 'list_group', { name: escapeHtml(b.display_name), group: escapeHtml(b.tg_chat_title) })
            : tgText(lang, 'list_group_untitled', { name: escapeHtml(b.display_name) }))
        .join('\n');
      const verb = tgText(lang, cmd === '/silent' ? 'silenced' : 'resumed');
      // HTML: имена ботов и названия групп задают люди, и «Team_A» в
      // legacy-Markdown ронял всё сообщение.
      await this.grammy.sendMessage(
        msg.chat.id,
        `${verb}\n${list}`,
        { parse_mode: 'HTML' },
      );
      return;
    }

    // неизвестная команда — не ругаемся, /help подскажет
    await this.grammy.sendMessage(msg.chat.id, tgText(await this.langOfTgUser(msg.from), 'unknown_command'));
  }

  private async handleDmStart(msg: any, token: string): Promise<void> {
    try {
      const ownerId = await this.identity.consumeAuthToken(
        token,
        msg.from.id,
        msg.from.username ?? null,
        msg.from.first_name ?? null,
      );
      const lang = await this.langFor(ownerId, msg.from);
      await this.grammy.sendMessage(
        msg.chat.id,
        msg.from.first_name
          ? tgText(lang, 'bind_ok_named', { name: msg.from.first_name })
          : tgText(lang, 'bind_ok'),
      );
      this.logger.log(`identity bound: linkeon=${ownerId} tg=${msg.from.id}`);
    } catch (e: any) {
      // Провал привязки раньше не логировался вообще — задним числом нельзя было
      // установить даже то, из какого Telegram пришли.
      this.logger.warn(
        `identity bind failed: tg=${msg.from?.id} @${msg.from?.username ?? '—'}: ${e?.message}`,
      );
      await this.grammy.sendMessage(
        msg.chat.id,
        TgBotService.bindFailureMessage(e, msg.from, pickTgLanguage(null, msg.from?.language_code)),
      );
    }
  }

  /**
   * Раньше на любую ошибку выдавался совет «сгенерируй новую ссылку — TTL 15
   * минут». Для занятого Telegram он бесполезен: новая ссылка упрётся в то же
   * ограничение, и человек ходит по кругу.
   */
  static bindFailureMessage(
    e: any,
    from: { id?: number; username?: string | null } | undefined,
    lang: string,
  ): string {
    if (e instanceof TgIdentityConflictError || e?.constraint === 'tg_user_identities_tg_user_id_key') {
      const who = from?.username ? `@${from.username}` : `id ${from?.id ?? '—'}`;
      return tgText(lang, 'bind_conflict', { who });
    }
    return tgText(lang, 'bind_failed');
  }

  private async handleGroupClaim(msg: any, token: string): Promise<void> {
    try {
      const result = await this.claim.claim(
        token,
        msg.from.id,
        msg.chat.id,
        msg.chat.title ?? null,
      );
      const botUsername = process.env.TG_BOT_USERNAME || 'LinkeonAgentBot';
      const lang = await this.langFor(result.ownerUserId, msg.from);
      await this.grammy.sendMessage(
        msg.chat.id,
        tgText(lang, 'claim_hello', { name: result.displayName, bot: botUsername }),
      );
      this.logger.log(`config ${result.configId} activated for chat ${msg.chat.id}`);
    } catch (e: any) {
      const ownerTgId = msg.from.id;
      try {
        // Причину — своими словами: сырой текст исключения бывал русским или
        // техническим («claim token не принадлежит…») посреди переведённого
        // сообщения. Незнакомая — общий текст, подробности в лог ниже.
        const key = CLAIM_FAILURE_TEXT[e?.claimFailure as TgClaimFailure] ?? 'claim_failed';
        await this.grammy.sendMessage(ownerTgId, tgText(await this.langOfTgUser(msg.from), key));
      } catch { /* ignore */ }
      this.logger.warn(`claim failed for chat ${msg.chat.id}: ${e.message}`);
      // Уходим, только если в группе точно нет работающего бота: выход
      // архивирует его конфиг (handleMyChatMember). Раньше уходили всегда — и
      // старая ссылка, нажатая владельцем в группе, где бот уже отвечает,
      // или чужая привязка к занятой группе выключали рабочего бота.
      let live: TgBotConfigRow | null | undefined;
      try { live = await this.configs.getActiveByTgChatId(msg.chat.id); } catch { live = undefined; }
      if (live === null) {
        try { await this.grammy.leaveChat(msg.chat.id); } catch { /* ignore */ }
      }
    }
  }

  /**
   * Обработка сообщения в чате — групповом или личном. Раньше называлась
   * handleGroupMessage: личных чатов у бота не было. Всё, что ниже (голос,
   * вложения, баланс, история, биллинг), одинаково нужно обоим, поэтому
   * второй такой путь не заводим.
   *
   * cfgIn передаёт личная ветка: там конфиг уже получен (и при необходимости
   * создан) через ensurePrivateConfig, второй поход в БД не нужен.
   */
  /**
   * Копим части альбома и отдаём их одним ходом.
   *
   * Telegram не присылает «несколько файлов» одним апдейтом: это N отдельных
   * сообщений с общим media_group_id, каждое со своим файлом и только одно — с
   * подписью. Контроллер отдаёт апдейты в работу параллельно, поэтому раньше
   * первое сообщение забирало per-chat advisory lock и уходило в модель ровно с
   * одним вложением, а остальные логировались как «busy, skipping» и оседали
   * только в истории. Для пользователя это выглядело как «бот взял в работу
   * один файл из пяти» (репорт владельца 09.09.2026).
   */
  private bufferAlbumPart(cfg: TgBotConfigRow, msg: any): void {
    const key = `${msg.chat.id}:${msg.media_group_id}`;
    const existing = this.albumBuffers.get(key);
    if (existing) clearTimeout(existing.timer);
    const parts = existing ? [...existing.parts, msg] : [msg];

    const waitMs = parts.length >= ALBUM_MAX_PARTS ? 0 : ALBUM_DEBOUNCE_MS;
    const timer = setTimeout(() => { void this.flushAlbum(key, cfg); }, waitMs);
    // unref: незакрытый альбом не должен держать процесс при остановке.
    timer.unref?.();
    this.albumBuffers.set(key, { parts, timer });
  }

  /** Склеивает накопленные части альбома в одно сообщение и пускает его в ход. */
  private async flushAlbum(key: string, cfg: TgBotConfigRow): Promise<void> {
    const entry = this.albumBuffers.get(key);
    if (!entry) return;
    this.albumBuffers.delete(key);
    clearTimeout(entry.timer);

    // Апдейты приезжают параллельно и не обязательно по порядку. Сортировка по
    // message_id возвращает порядок отправки — иначе «первая таблица» в подписи
    // указывала бы на случайный файл.
    const parts = [...entry.parts].sort((a, b) => (a.message_id ?? 0) - (b.message_id ?? 0));
    const head = parts[0];
    // Подпись Telegram кладёт ровно на одну часть альбома, и какая это часть —
    // зависит от клиента. Берём первую непустую, а не head.caption: иначе ход
    // уходит как «файл без подписи» и задача теряется.
    const caption = parts
      .map(p => String(p.caption ?? p.text ?? ''))
      .find(t => t.trim()) ?? '';

    this.logger.log(`album ${key}: ${parts.length} частей, подпись ${caption ? 'есть' : 'нет'}`);
    try {
      await this.handleChatMessage({ ...head, caption, text: undefined, albumParts: parts }, cfg);
    } catch (e: any) {
      // Ход стартует из таймера, наверху ловить некому.
      this.logger.error(`album ${key} failed: ${e?.message || e}\n${e?.stack}`);
    }
  }

  private async handleChatMessage(msg: any, cfgIn?: TgBotConfigRow): Promise<void> {
    const cfg = cfgIn ?? (await this.configs.getActiveByTgChatId(msg.chat.id));
    if (!cfg) return;

    // Язык служебных сообщений хода — язык владельца (его профиля). В базу —
    // один раз и только когда бот действительно что-то скажет.
    let langOnce: Promise<TgLang> | null = null;
    const lang = () => (langOnce ??= this.langFor(cfg.owner_user_id));

    // Часть альбома — не самостоятельный ход: копим и обрабатываем всё вместе.
    // albumParts значит «это уже склейка», её пропускаем дальше.
    if (msg.media_group_id && !msg.albumParts) {
      this.bufferAlbumPart(cfg, msg);
      return;
    }

    const isVoice = !!(msg.voice || msg.audio);
    let workingText: string = msg.text ?? msg.caption ?? '';
    let actualIsVoice = false;
    let voiceFileId: string | undefined;

    if (isVoice) {
      voiceFileId = msg.voice?.file_id ?? msg.audio?.file_id;
      if (!voiceFileId) return;
      try {
        // Whisper с language не подсказывает, а заставляет: на чужой речи он
        // переводит или транслитерирует. Язык профиля — язык интерфейса, а не
        // речи (браузер с uk/kk/be даёт профилю en), поэтому заставляем только
        // русский — как было всегда, — а остальным Whisper определяет язык сам.
        const ownerLang = await this.router.ownerLanguage(cfg);
        workingText = await this.voice.transcribe(voiceFileId, ownerLang === 'ru' ? 'ru' : undefined);
        actualIsVoice = true;
        this.logger.log(`voice transcribed in chat ${msg.chat.id}: "${workingText.substring(0, 50)}..."`);
        // Эхо расшифровки уходит позже — только если бот решит отвечать
        // (см. после shouldRespond).
      } catch (e: any) {
        this.logger.warn(`STT failed for chat ${msg.chat.id}: ${e.message}`);
        return;
      }
    }

    // Рабочая папка чата — общая для всех ходов. Сюда кладём вложения, отсюда
    // же Claude берёт свои прошлые результаты, когда просят «поправь».
    const workspace = this.chatWorkspace(cfg.id);

    // Скачиваем приложенные фото/документы. Если пусто — просто пустой массив.
    const attachments: string[] = [];
    if (!isVoice && workspace) {
      try {
        const dl = await this.downloadIncomingAttachments(msg, workspace);
        attachments.push(...dl);
      } catch (e: any) {
        this.logger.warn(`attachment download failed in chat ${msg.chat.id}: ${e.message}`);
      }
    }

    // Если есть файлы но текста нет — даём LLM плейсхолдер, иначе будет early return.
    if (!workingText && attachments.length > 0) {
      workingText = attachments.length > 1
        ? `(юзер прислал ${attachments.length} файлов без подписи — разбери ВСЕ и прокомментируй)`
        : '(юзер прислал файл без подписи — разбери и прокомментируй)';
    }
    if (!workingText) return;

    // Ответ на сообщение бота — явное обращение. Нужен и проверке нулевого
    // баланса, и контексту хода (getBotUserId кэширует getMe).
    const botUserId = await this.grammy.getBotUserId();
    const replyToFromBot = msg.reply_to_message?.from?.id === botUserId;

    // Pre-flight: balance check. При ≤ 0 — повторяемое уведомление каждые
    // 10 минут, чтобы юзеры с пустым балансом не думали, что бот молча умер.
    const preBalance = await this.billing.getBalance(cfg.owner_user_id);
    if (preBalance <= 0) {
      // Ход не состоится, и сообщение в историю не попадёт — файл тоже не
      // должен остаться в папке чата (см. discardAttachments).
      this.discardAttachments(attachments);
      // Владелец узнаёт о нуле сам — личкой, раз в сутки: в группах «по
      // обращению» объяснение ниже получает лишь тот, кто позвал бота. В личке
      // предупреждение и так придёт прямо здесь.
      // В фоне: объяснение позвавшему (ниже) не ждёт ни Redis, ни Telegram
      // владельца.
      if (!isPrivateConfig(cfg)) {
        this.inBackground(`zero-balance owner notify for ${cfg.id}`, async () => {
          const ownerTg = await this.identity.getIdentityByLinkeonId(cfg.owner_user_id);
          await this.billing.notifyOwnerZeroBalance(cfg.owner_user_id, ownerTg?.tgUserId ?? null);
        });
      }
      // Объяснять, почему бот молчит, — только тому, кто его позвал. Раньше
      // предупреждение уходило на любое сообщение группы, в том числе в режиме
      // «по обращению» и у замолчанного /silent бота.
      const addressed = this.router.isExplicitlyAddressed(cfg, { text: workingText, replyToFromBot });
      if (!addressed) return;
      const ZERO_BALANCE_COOLDOWN_MS = 10 * 60 * 1000;
      const recent = await this.billing.recentlyNotifiedZeroBalance(cfg.id, ZERO_BALANCE_COOLDOWN_MS);
      if (!recent) {
        try {
          await this.grammy.sendMessage(
            msg.chat.id,
            // В личке владелец и есть тот, у кого кончились токены.
            tgText(await lang(), isPrivateConfig(cfg) ? 'zero_balance_owner' : 'zero_balance_group'),
            { reply_to_message_id: msg.message_id },
          );
          await this.billing.markZeroBalanceNotified(cfg.id);
        } catch (e: any) {
          this.logger.warn(`zero-balance notify failed in chat ${msg.chat.id}: ${e.message}`);
        }
      }
      return;
    }

    // Ссылка на встречу замыкает ход: показываем приглашение с кнопкой и в
    // модель не идём. Иначе за каждую вставленную ссылку платим ход LLM и
    // получаем два ответа — приглашение и рассуждение ассистента о нём.
    // Тот же приём, что в вебе (chat.service.ts).
    // Приглашаем, только если к боту обратились (решение владельца 14.10.2026):
    // раньше карточка уходила на любую ссылку в группе — и в режиме «по
    // обращению», и у замолчанного /silent бота.
    // Команда со ссылкой — всё равно команда: у замолчанного бота «/resume
    // <ссылка>» не должен давать карточку, у живого «/balance <ссылка>» —
    // исполняется как команда.
    if (
      cfg.owner_user_id &&
      typeof workingText === 'string' &&
      cfg.status !== 'silent' &&
      !workingText.trimStart().startsWith('/') &&
      this.router.isExplicitlyAddressed(cfg, { text: workingText, replyToFromBot })
    ) {
      try {
        const handled = await this.meetings.tryHandleLink(
          msg.chat.id, workingText, cfg.owner_user_id,
        );
        if (handled) {
          this.discardAttachments(attachments);
          return;
        }
      } catch (e: any) {
        // Не повод глушить сообщение: не получилось показать приглашение —
        // пусть ассистент ответит как обычно.
        this.logger.warn(`meeting link check failed in chat ${msg.chat.id}: ${e.message}`);
      }
    }

    const ctx = {
      chatId: msg.chat.id,
      msgId: msg.message_id,
      fromTgUserId: msg.from.id,
      fromTgUserName: msg.from.first_name ?? msg.from.username ?? null,
      text: workingText,
      replyToBotMessageId: msg.reply_to_message?.message_id,
      replyToFromBot,
      isVoice: actualIsVoice,
      voiceFileId,
      attachmentPaths: attachments.length ? attachments : undefined,
    };

    const lockId = this.hashLock(`tg-chat:${msg.chat.id}`);
    // Лок берётся на выделенном соединении и на нём же снимается. Через
    // this.pg.query() это было сломано: unlock уезжал на другое соединение пула,
    // возвращал false, и чат оглушало до закрытия соединения по таймауту.
    const lock = await this.pg.tryAdvisoryLock(lockId);
    if (!lock) {
      this.logger.debug(`chat ${msg.chat.id} busy, skipping`);
      // Сообщение сохраняем всегда — чтобы в истории не было дыр. «Минутку» и
      // отметка «ждём ответа» — только тому, кто обратился к боту: раньше они
      // уходили на любую реплику группы, а отметка без ответа поднимала потом в
      // мониторинге ложное «бот молчит».
      try {
        await this.router.persistUserMessage(cfg, ctx);
      } catch (e: any) {
        this.logger.warn(`busy-skip persistUserMessage failed in chat ${msg.chat.id}: ${e.message}`);
      }
      if (!this.router.isExplicitlyAddressed(cfg, ctx)) return;
      // Юзеру ниже уходит «минутку» — значит ответа он ждёт. Если лок залип и
      // не отпустится, ответа не будет никогда: без этой отметки такой чат
      // молчит бесконечно и никто об этом не узнает.
      try {
        await this.router.markAnswerExpected(ctx.chatId, ctx.msgId);
      } catch (e: any) {
        this.logger.warn(`busy-skip markAnswerExpected failed in chat ${msg.chat.id}: ${e.message}`);
      }
      const lastNotice = this.lastBusyNoticeAt.get(msg.chat.id) ?? 0;
      if (Date.now() - lastNotice > 60_000) {
        this.lastBusyNoticeAt.set(msg.chat.id, Date.now());
        try {
          await this.grammy.sendMessage(
            msg.chat.id,
            tgText(await lang(), 'busy'),
            { reply_to_message_id: msg.message_id },
          );
        } catch (e: any) {
          this.logger.warn(`busy-skip notice failed in chat ${msg.chat.id}: ${e.message}`);
        }
      } else {
        try { await this.grammy.sendChatAction(msg.chat.id, 'typing'); } catch { /* ignore */ }
      }
      return;
    }

    // Typing-индикатор пока думает Claude. Telegram action длится ~5с — обновляем
    // каждые 4с. Останавливаем как только Claude вернул ответ.
    let typingTimer: NodeJS.Timeout | null = null;
    // Status-сообщение в чате — редактируется по приходу tool_use событий.
    let statusMsgId: number | null = null;
    let statusLastLabel = '';
    let statusLastEditAt = 0;
    let statusPendingLabel: string | null = null;
    let statusPendingTimer: NodeJS.Timeout | null = null;
    // Момент старта хода: по нему отличаем свежие артефакты Claude от того, что
    // уже лежало в папке чата с прошлых раз.
    let turnStartedAt = Date.now();

    try {
      await this.router.persistUserMessage(cfg, ctx);

      // Phase 8: handle slash-commands (/help /balance /silent /resume) ДО LLM-вызова.
      // tryHandle вернёт true если это была команда — в таком случае биллинг не запускаем.
      const handled = await this.commands.tryHandle(cfg, msg);
      if (handled) return;

      const should = await this.router.shouldRespond(cfg, ctx);
      if (!should) return;

      // Эхо расшифровки — чтобы юзер видел, что бот услышал, и мог поправить.
      // Только когда бот отвечает: раньше эхо уходило на каждое голосовое группы,
      // в том числе в режиме «по обращению» и у замолчанного /silent бота.
      // Ждём доставки: иначе эхо обгоняет статус «Думаю…» и встаёт под ним.
      if (actualIsVoice && workingText) {
        try {
          // HTML с экранированием: в legacy-Markdown любой из _ * [ ` в
          // расшифровке ронял сообщение, и эха просто не было.
          // Режем по символам, а не по UTF-16: slice посреди эмодзи оставлял
          // половинку суррогатной пары.
          const chars = Array.from(workingText);
          const heard = chars.length > ECHO_MAX_CHARS ? chars.slice(0, ECHO_MAX_CHARS).join('') + '…' : workingText;
          await this.grammy.sendMessage(
            msg.chat.id,
            `🎙️ <i>«${escapeHtml(heard)}»</i>`,
            { reply_to_message_id: msg.message_id, parse_mode: 'HTML' },
          );
        } catch { /* эхо — подсказка, не повод ронять ход */ }
      }

      // Решение принято — дальше молчание означает сбой, а не режим адресации.
      // Мониторинг вторичен: не смогли отметить — работаем дальше без надзора,
      // но ответ юзеру не роняем.
      try {
        await this.router.markAnswerExpected(ctx.chatId, ctx.msgId);
      } catch (e: any) {
        this.logger.warn(`markAnswerExpected failed in chat ${msg.chat.id}: ${e.message}`);
      }

      // Отсечка «что сделано в этом ходе». Ставится ПОСЛЕ загрузки вложений,
      // чтобы присланный файл заведомо остался по старую сторону границы.
      turnStartedAt = Date.now();

      this.grammy.sendChatAction(msg.chat.id, 'typing').catch(() => {});
      typingTimer = setInterval(() => {
        this.grammy.sendChatAction(msg.chat.id, 'typing').catch(() => {});
      }, 4000);

      // Стартовое status-сообщение. Если оно не отправилось (rate-limit/permission)
      // — продолжаем без статуса, не блокируем основной поток.
      const turnLang = await lang();
      try {
        const sent = await this.grammy.sendMessage(msg.chat.id, tgText(turnLang, 'thinking'), {
          reply_to_message_id: msg.message_id,
        });
        statusMsgId = sent.message_id;
        statusLastLabel = tgText(turnLang, 'thinking');
      } catch (e: any) {
        this.logger.warn(`failed to send status msg in chat ${msg.chat.id}: ${e.message}`);
      }

      const editStatus = async (label: string): Promise<void> => {
        if (!statusMsgId || label === statusLastLabel) return;
        const now = Date.now();
        const since = now - statusLastEditAt;
        // Telegram лимитит editMessageText ~1 req/sec на чат — throttle 1.5с.
        if (since >= 1500) {
          statusLastEditAt = now;
          statusLastLabel = label;
          try {
            await this.grammy.editMessageText(msg.chat.id, statusMsgId, label);
          } catch (e: any) {
            // "message is not modified" — нормально, "message to edit not found" — статус удалён.
            const m = String(e.message ?? '');
            if (!m.includes('not modified') && !m.includes('not found')) {
              this.logger.debug(`status edit failed in chat ${msg.chat.id}: ${m}`);
            }
          }
        } else {
          statusPendingLabel = label;
          if (!statusPendingTimer) {
            statusPendingTimer = setTimeout(() => {
              statusPendingTimer = null;
              const l = statusPendingLabel;
              statusPendingLabel = null;
              if (l && l !== statusLastLabel) editStatus(l).catch(() => {});
            }, 1500 - since);
          }
        }
      };

      const labelFor = (toolName: string) => TgBotService.toolStatusLabel(toolName, turnLang);

      const ownerRes = await this.pg.query(
        `SELECT profile_data->>'name' AS first_name FROM ai_profiles_consolidated WHERE user_id = $1 LIMIT 1`,
        [cfg.owner_user_id],
      );
      const ownerFirstName = ownerRes.rows[0]?.first_name ?? 'Linkeon-пользователь';

      // Инструмент продуктов владельца — только ему и только в чате, где кроме
      // него никто не писал (см. productsOwnerForTurn). Считается ПОСЛЕ
      // persistUserMessage: текущее сообщение уже в истории и тоже учтено.
      const productsOwner = await this.productsOwnerForTurn(cfg, msg);

      let reply: { text: string; costUsd: number };
      try {
        reply = await this.router.generateReply(cfg, ownerFirstName, attachments, (ev) => {
          if (ev.kind === 'tool_use') editStatus(labelFor(ev.name)).catch(() => {});
        }, workspace ?? undefined, { productsOwner });
      } catch (e: any) {
        // Не вылетаем тихо — пишем юзеру в статус и оставляем след в БД.
        await this.recordTurnFailure(cfg, msg.chat.id, statusMsgId, e, turnLang);
        statusMsgId = null; // не удалять в finally — оставляем как уведомление
        throw e;
      }

      // Claude отработал — гасим status-throttle, typing-loop, и удаляем статус,
      // дальше каждый исходящий канал (voice/photo/document) выставит свой action.
      if (typingTimer) { clearInterval(typingTimer); typingTimer = null; }
      if (statusPendingTimer) { clearTimeout(statusPendingTimer); statusPendingTimer = null; }
      if (statusMsgId) {
        try { await this.grammy.deleteMessage(msg.chat.id, statusMsgId); } catch { /* ignore */ }
        statusMsgId = null;
      }

      // Парсим маркеры {{image:...}} и {{file:...}} — они идут отдельными сообщениями,
      // в основном тексте их быть не должно.
      const { cleanText, markers } = this.extractOutgoingMarkers(reply.text);

      // Сканим рабочую папку — что Claude насоздавал В ЭТОМ ходе. Скрипты
      // (.py/.sh) в whitelist не входят, посылаем только итоговые файлы.
      const sandboxOutputs = workspace
        ? this.scanSandboxOutputs(workspace, turnStartedAt, new Set(attachments))
        : [];

      // Voice reply policy. Голос — только для текстовой части ответа, не для файлов.
      const wantsVoice =
        cfg.voice_reply_mode === 'always' ||
        (cfg.voice_reply_mode === 'mirror' && actualIsVoice);

      let contentType: 'text' | 'voice_reply' = 'text';
      let voiceTtsCostUsd = 0;

      const textToSend = cleanText || (markers.length > 0 ? '' : '...');

      if (wantsVoice && textToSend) {
        try {
          this.grammy.sendChatAction(msg.chat.id, 'record_voice').catch(() => {});
          const tts = await this.voice.synthesize(textToSend);
          voiceTtsCostUsd = tts.costUsd;
          const plan = TgBotService.voiceCaptionPlan(textToSend);
          await this.grammy.sendVoice(msg.chat.id, tts.buffer, {
            reply_to_message_id: msg.message_id,
            ...(plan.caption !== undefined ? { caption: plan.caption } : {}),
          });
          if (plan.needsSeparateText) {
            await this.deliverReplyText(msg.chat.id, msg.message_id, textToSend, turnLang);
          }
          contentType = 'voice_reply';
        } catch (e: any) {
          this.logger.warn(`TTS failed for chat ${msg.chat.id}, fallback to text: ${e.message}`);
          await this.deliverReplyText(msg.chat.id, msg.message_id, textToSend, turnLang);
        }
      } else if (textToSend) {
        await this.deliverReplyText(msg.chat.id, msg.message_id, textToSend, turnLang);
      }

      await this.deliverOutgoingMarkers(cfg, msg, markers, turnLang);

      // Артефакты из песочницы Claude (PDF/DOCX/XLSX/etc.) — каждый отдельным
      // документом. Лимит уже наложен в scanSandboxOutputs (5 файлов max).
      for (const f of sandboxOutputs) {
        try {
          this.grammy.sendChatAction(msg.chat.id, 'upload_document').catch(() => {});
          const buf = fs.readFileSync(f);
          await this.grammy.sendDocument(msg.chat.id, buf, path.basename(f), {
            reply_to_message_id: msg.message_id,
          });
        } catch (e: any) {
          this.logger.warn(`sandbox file ${path.basename(f)} send failed in chat ${msg.chat.id}: ${e.message}`);
        }
      }

      const totalCostUsd = reply.costUsd + voiceTtsCostUsd;
      // Два курса, а не один на сумму: ход Claude — по курсу подписки, озвучка
      // OpenAI — по курсу возмещения живых денег. Раньше складывались доллары
      // и делились по курсу подписки, и доллар, отданный OpenAI, возвращался
      // девятью рублями из восьмидесяти.
      const tokensCharged = this.billing.tokensForTurn(reply.costUsd, voiceTtsCostUsd);
      const newBalance = await this.billing.deduct(cfg.owner_user_id, tokensCharged);
      this.logger.log(
        `tg-bot billing: config=${cfg.id} cost=$${totalCostUsd.toFixed(5)} deducted=${tokensCharged} balance=${newBalance}`,
      );
      // Аномально дорогой ход. Агентные ходы (договор, финмодель) доходили до
      // 65k токенов ещё на Sonnet и проходили молча — теперь модель как в вебе,
      // и такие выбросы должны быть видны нам сразу, а не из жалобы владельца.
      await this.billing.alertIfExpensiveTurn(cfg, totalCostUsd, tokensCharged, newBalance);
      await this.router.persistAssistantReply(cfg, reply.text, contentType, tokensCharged);
      // Отметки о нуле снимаем после записи ответа: их сбой не должен стоить
      // хода, за который уже списали. Флаг группы — чтобы при следующем нуле
      // снова сработало однократное сообщение; отметка владельца — Redis, её
      // снимаем в фоне (см. inBackground).
      if (newBalance > 0) {
        try {
          await this.billing.clearZeroBalanceFlag(cfg.id);
        } catch (e: any) {
          this.logger.warn(`zero-balance flag not cleared for ${cfg.id}: ${e?.message}`);
        }
        this.inBackground(`zero-balance owner mark clear for ${cfg.id}`, () =>
          this.billing.clearOwnerZeroBalanceDm(cfg.owner_user_id),
        );
      }
      // Пишем разговор в тот же граф Neo4j, из которого читает веб-чат: без
      // этого бот ничего не запоминает и переспрашивает уже рассказанное.
      await this.router.consolidateAfterReply(cfg, workingText, reply.text);

      // DM-alert при низком балансе (post-deduct) — в фоне: при нуле это Redis.
      this.inBackground(`balance alerts for ${cfg.id}`, async () => {
        const ownerTg = await this.identity.getIdentityByLinkeonId(cfg.owner_user_id);
        await this.billing.checkBalanceAlerts(cfg.id, cfg.owner_user_id, ownerTg?.tgUserId ?? null);
      });
    } finally {
      if (typingTimer) clearInterval(typingTimer);
      if (statusPendingTimer) clearTimeout(statusPendingTimer);
      if (statusMsgId) {
        // Сюда попадаем только если ни success-cleanup, ни error-edit не отработали
        // (например ранний throw до try-блока с generateReply). Прибираем за собой.
        try { await this.grammy.deleteMessage(msg.chat.id, statusMsgId); } catch { /* ignore */ }
      }
      // Рабочую папку НЕ трогаем: она общая для всех ходов чата, и снос здесь —
      // ровно та ошибка, из-за которой «поправь договор» приходило к модели без
      // договора. За диском следит pruneWorkspaces (TTL + потолок размера).
      await lock.release();
    }
  }

  /**
   * Лимит подписи к медиа в Telegram — 1024 символа, а не 4096 как у текстового
   * сообщения. Здесь стоял substring(0, 1024): TTS озвучивал ответ целиком, а
   * подпись молча обрывалась на полуслове — «голосом читает полностью, а текст
   * обрезает» (жалоба владельца 22.08.2026). Нарезка splitForTelegram этот путь
   * не прикрывала: она живёт в sendMessage, а голос уходит через sendVoice.
   *
   * Длинный ответ отправляем отдельным сообщением — там нарезка работает.
   */
  static readonly VOICE_CAPTION_LIMIT = 1024;

  static voiceCaptionPlan(text: string): { caption?: string; needsSeparateText: boolean } {
    return text.length <= TgBotService.VOICE_CAPTION_LIMIT
      ? { caption: text, needsSeparateText: false }
      : { needsSeparateText: true };
  }

  /**
   * Пересланное ли сообщение — хоть одна его часть (у альбома — любая).
   * forward_origin — поле Bot API 7+, forward_* — прежние, их Telegram ещё
   * шлёт; is_automatic_forward — пост канала, продублированный в обсуждение.
   */
  static isForwarded(msg: any): boolean {
    const parts: any[] = [msg, ...((msg?.albumParts as any[] | undefined) ?? [])];
    return parts.some((p) =>
      !!p && !!(p.forward_origin || p.forward_from || p.forward_from_chat ||
        p.forward_sender_name || p.forward_date || p.is_automatic_forward),
    );
  }

  /**
   * Файлы, скачанные для хода, который не состоялся: выходы до
   * persistUserMessage (нулевой баланс, ссылка на встречу). Оставленный файл
   * увидел бы следующий ход — в списке папки и через Read, — а проверка «кто
   * писал в чате» (tg_bot_messages) о его авторе не знала бы: чужой файл
   * доехал бы до модели владельца мимо гейта инструмента продуктов.
   */
  private discardAttachments(paths: string[]): void {
    for (const p of paths) {
      try { fs.rmSync(p, { force: true }); }
      catch (e: any) { this.logger.warn(`discard attachment failed (${p}): ${e.message}`); }
    }
  }

  /**
   * Подпись статус-сообщения, пока идёт вызов инструмента. Статическая и без
   * `this` — чтобы проверяться тестом, не поднимая ход целиком.
   */
  static toolStatusLabel(toolName: string, lang: string): string {
    if (/mcp__products__/.test(toolName)) return tgText(lang, 'tool_products');
    if (toolName === 'Read') return tgText(lang, 'tool_read');
    if (toolName === 'Write') return tgText(lang, 'tool_write');
    if (toolName === 'Edit') return tgText(lang, 'tool_edit');
    if (toolName === 'Bash') return tgText(lang, 'tool_bash');
    if (toolName === 'Glob') return tgText(lang, 'tool_glob');
    if (toolName === 'Grep') return tgText(lang, 'tool_grep');
    if (toolName === 'WebSearch') return tgText(lang, 'tool_web_search');
    if (toolName === 'WebFetch') return tgText(lang, 'tool_web_fetch');
    if (/generate_image|edit_image|compose_image/i.test(toolName)) return tgText(lang, 'tool_image');
    if (/upscale_image/i.test(toolName)) return tgText(lang, 'tool_upscale');
    if (/generate_video|video/i.test(toolName)) return tgText(lang, 'tool_video');
    return `⚙️ ${toolName}...`;
  }

  /**
   * Чьи продукты может править этот ход — или ничьи (undefined).
   *
   * Решение владельца (26.09.2026): инструмент продуктов есть в ходе, ТОЛЬКО
   * если
   *   1) текущее сообщение написал сам владелец бота — его Telegram привязан к
   *      тому же аккаунту Linkeon, что владеет конфигом (tg_user_identities
   *      1:1), — и написал сам: пересланное сообщение написал кто-то другой,
   *      даже если переслал владелец;
   *   2) ни в этом чате, ни в истории этого конфига за всё время не писал
   *      никто, кроме него (router.onlySpeakerIs; текущее сообщение к этому
   *      моменту сохранено).
   * Личка проходит сама собой. Хоть одна чужая реплика — и инструмента здесь
   * больше нет: чужой текст в истории мог бы править продукты владельца его
   * же руками. «В группе» здесь не критерий: сольная группа владельца
   * проходит, людная личка невозможна.
   *
   * Отдаёт и TG-id владельца: generateReply сверяет по нему снимок истории,
   * который уйдёт в модель (вторая линия — против гонки с чужой репликой).
   *
   * Любой сбой — «ничьи»: без инструмента бот работает как раньше, а выдать
   * его по ошибке нельзя.
   */
  private async productsOwnerForTurn(
    cfg: TgBotConfigRow,
    msg: any,
  ): Promise<{ linkeonId: string; tgUserId: number } | undefined> {
    const senderTgId = msg?.from?.id;
    if (!cfg?.owner_user_id || typeof senderTgId !== 'number') return undefined;
    if (TgBotService.isForwarded(msg)) return undefined;
    try {
      const senderLinkeonId = await this.identity.getLinkeonIdByTgUserId(senderTgId);
      if (!senderLinkeonId || senderLinkeonId !== cfg.owner_user_id) return undefined;
      if (!(await this.router.onlySpeakerIs(cfg, senderTgId))) return undefined;
      return { linkeonId: cfg.owner_user_id, tgUserId: senderTgId };
    } catch (e: any) {
      this.logger.warn(`products tool gate failed in chat ${msg?.chat?.id}: ${e?.message}`);
      return undefined;
    }
  }

  /**
   * Разбор упавшего хода: уведомить юзера и оставить след в истории чата.
   *
   * Раньше здесь было только редактирование статус-сообщения. Текст уведомления
   * жил исключительно в Telegram, в БД не появлялось ничего — и детектор
   * молчания (monitoring/TgHealthService) держал алерт «бот молчит N мин» сутки,
   * потому что искал строку бота после answer_expected_at. Инцидент 30.08.2026:
   * недельный лимит Claude уронил один ход, юзер ошибку увидел, а алерт висел
   * ещё час после того, как бот снова отвечал в других чатах.
   *
   * Метод не бросает: исходная ошибка важнее любого сбоя внутри разбора, её
   * пробрасывает вызывающий.
   */
  async recordTurnFailure(
    cfg: TgBotConfigRow,
    chatId: number,
    statusMsgId: number | null,
    err: any,
    lang?: TgLang,
  ): Promise<void> {
    const reason = String(err?.message || 'неизвестная ошибка').slice(0, 200);
    if (statusMsgId) {
      try {
        const l = lang ?? (await this.langFor(cfg.owner_user_id));
        // Причина — только в историю и лог: она бывает русской или
        // технической посреди переведённого сообщения.
        await this.grammy.editMessageText(chatId, statusMsgId, tgText(l, 'turn_failed'));
      } catch (e: any) {
        this.logger.warn(`turn-failure notice failed in chat ${chatId}: ${e.message}`);
      }
    }
    try {
      await this.router.persistTurnFailure(cfg, reason);
    } catch (e: any) {
      this.logger.warn(`turn-failure persist failed in chat ${chatId}: ${e.message}`);
    }
  }

  /**
   * Доставка текстовой части ответа. Единственное место, где ответ уходит
   * юзеру, — поэтому здесь же ловится провал доставки.
   *
   * Раньше падение sendMessage (19.08.2026 — ответ длиннее 4096 символов)
   * улетало наверх до handleUpdate, который только пишет строку в лог: юзер не
   * получал ни ответа, ни ошибки, а текст не сохранялся нигде — доставать
   * пришлось из сессии Claude CLI на проде. Нарезка в TgGrammyClient закрыла
   * конкретную причину; здесь закрывается сам класс отказа.
   *
   * Ошибку пробрасываем дальше намеренно: списание и persistAssistantReply
   * идут после доставки, и ход, которого юзер не видел, не должен ни попасть в
   * историю как отвеченный, ни быть оплачен.
   */
  async deliverReplyText(
    chatId: number,
    replyToMessageId: number,
    text: string,
    lang: string,
  ): Promise<void> {
    try {
      await this.grammy.sendMessage(chatId, text, { reply_to_message_id: replyToMessageId });
    } catch (e: any) {
      // Полный текст — в лог: это единственная копия ответа, за который уже
      // заплачено ёмкостью подписки.
      this.logger.error(
        `доставка ответа в чат ${chatId} провалилась: ${e?.message || e}. Текст ответа (${text.length} симв.) ниже:\n${text}`,
      );
      try {
        await this.grammy.sendMessage(
          chatId,
          tgText(lang, 'delivery_failed'),
          { reply_to_message_id: replyToMessageId },
        );
      } catch {
        // Канал до чата мёртв целиком — сказать юзеру нечем, ошибка ниже.
      }
      throw e;
    }
  }

  /**
   * Рабочая папка чата. Одна и та же между ходами — в ней лежат и присланные
   * пользователем файлы, и собранные ассистентом документы.
   *
   * Раньше на каждый ход создавалась пустая песочница, а вложение качалось в
   * os.tmpdir() и удалялось в finally. Из-за этого «поправь договор» уходило в
   * модель без договора, и она пересобирала его по своему же тексту из истории.
   */
  private chatWorkspace(configId: string): string | null {
    // Второй кандидат — деградация, а не выбор: если основной корень недоступен
    // (нет прав, диск), лучше папка в /tmp, чем ход вообще без вложения.
    for (const root of [workspaceRoot(), path.join(os.tmpdir(), 'linkeon-tg-workspace')]) {
      const dir = path.join(root, configId);
      try {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        return dir;
      } catch (e: any) {
        this.logger.warn(`workspace mkdir failed (${dir}): ${e.message}`);
      }
    }
    return null;
  }

  /**
   * Имя файла внутри рабочей папки. Держим то, которое видит пользователь: он
   * пишет «пересчитай в dds.xlsx», и модель должна найти файл по этому имени.
   * Разделители пути и управляющие символы срезаем — имя приходит из Telegram,
   * то есть снаружи.
   */
  private workspaceFileName(originalName: string | null, ext: string, fileUid: string): string {
    const raw = (originalName ?? '').split(/[\\/]/).pop() ?? '';
    const cleaned = raw.replace(/[\x00-\x1f]/g, '').replace(/\s+/g, '_').trim();
    if (cleaned && cleaned !== '.' && cleaned !== '..') {
      if (cleaned.length <= 120) return cleaned;
      const e = path.extname(cleaned).slice(0, 10);
      return cleaned.slice(0, 120 - e.length) + e;
    }
    const safeExt = ext.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bin';
    // file_unique_id, а не префикс file_id: у фотографий из одного альбома
    // первые 16 символов file_id совпадают (общий заголовок), и все кадры
    // писались в ОДИН файл, затирая друг друга. В прод-логе 08.09.2026 два
    // разных кадра (59546 и 70838 байт) легли в tg-AgACAgIAAxkBAAID.jpg в одну
    // секунду. У фото своего имени нет, так что развести их больше нечем.
    const safeUid = fileUid.replace(/[^a-z0-9_-]/gi, '').slice(0, 24) || 'file';
    return `tg-${safeUid}.${safeExt}`;
  }

  /**
   * Скачиваем фото/документы сообщения в рабочую папку чата.
   *
   * У альбома части уже склеены в `albumParts` (см. flushAlbum) — идём по всем,
   * иначе в модель уедет только первый файл из отправленных.
   */
  private async downloadIncomingAttachments(msg: any, destDir: string): Promise<string[]> {
    const paths: string[] = [];
    for (const part of (msg.albumParts as any[] | undefined) ?? [msg]) {
      // photo — массив размеров; берём самый большой (последний)
      if (Array.isArray(part.photo) && part.photo.length > 0) {
        const largest = part.photo[part.photo.length - 1];
        const p = await this.downloadOneFile(
          largest.file_id, largest.file_unique_id, largest.file_size, 'jpg', destDir, null,
        );
        if (p) paths.push(p);
      }
      if (part.document) {
        const d = part.document;
        // расширение из mime или из имени файла
        const ext = this.guessExtension(d.mime_type, d.file_name);
        const p = await this.downloadOneFile(
          d.file_id, d.file_unique_id, d.file_size, ext, destDir, d.file_name ?? null,
        );
        if (p) paths.push(p);
      }
    }
    return paths;
  }

  private async downloadOneFile(
    fileId: string,
    fileUniqueId: string | undefined,
    fileSize: number | undefined,
    ext: string,
    destDir: string,
    originalName: string | null,
  ): Promise<string | null> {
    if (fileSize && fileSize > MAX_ATTACHMENT_BYTES) {
      this.logger.warn(`skip oversized attachment: ${fileId} (${fileSize} bytes)`);
      return null;
    }
    const file = await this.grammy.getFile(fileId);
    if (!file.file_path) return null;
    const buf = await this.grammy.downloadFile(file.file_path);
    // Одноимённый файл перезаписываем: прислать файл с тем же именем — это
    // «вот новая версия», а не «заведи второй».
    const p = path.join(destDir, this.workspaceFileName(originalName, ext, fileUniqueId || fileId));
    fs.writeFileSync(p, buf);
    this.logger.log(`attachment saved: ${p} (${buf.length} bytes)`);
    return p;
  }

  /**
   * Чистка рабочих папок: сносим те, где ничего не трогали дольше TTL, и
   * ужимаем распухшие до потолка.
   *
   * Возраст считаем по самому свежему файлу ВНУТРИ, а не по mtime самой папки:
   * mtime каталога меняется только при добавлении/удалении записи, поэтому
   * активный чат, где файлы правятся на месте, снесло бы из-под живого диалога.
   */
  private async pruneWorkspaces(): Promise<void> {
    const root = workspaceRoot();
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }

    const ttlMs = WORKSPACE_TTL_DAYS * 24 * 60 * 60 * 1000;
    const now = Date.now();

    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = path.join(root, e.name);
      const files = this.walkWorkspace(dir);

      const newest = files.length
        ? Math.max(...files.map(f => f.mtimeMs))
        : (() => { try { return fs.statSync(dir).mtimeMs; } catch { return 0; } })();

      if (now - newest > ttlMs) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
          this.logger.log(`workspace ${e.name} removed (idle > ${WORKSPACE_TTL_DAYS}d)`);
        } catch (err: any) {
          this.logger.warn(`workspace ${e.name} rm failed: ${err.message}`);
        }
        continue;
      }

      // Потолок по размеру: выносим самые старые, пока не влезем.
      let total = files.reduce((s, f) => s + f.size, 0);
      if (total <= WORKSPACE_MAX_BYTES) continue;
      for (const f of [...files].sort((a, b) => a.mtimeMs - b.mtimeMs)) {
        if (total <= WORKSPACE_MAX_BYTES) break;
        try { fs.rmSync(f.path, { force: true }); total -= f.size; } catch { /* ignore */ }
      }
      this.logger.log(`workspace ${e.name} trimmed to ${Math.round(total / 1024 / 1024)}MB`);
    }
  }

  private walkWorkspace(dir: string): { path: string; size: number; mtimeMs: number }[] {
    const out: { path: string; size: number; mtimeMs: number }[] = [];
    const walk = (d: string) => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        if (!e.isFile()) continue;
        try {
          const st = fs.statSync(full);
          out.push({ path: full, size: st.size, mtimeMs: st.mtimeMs });
        } catch { /* ignore */ }
      }
    };
    walk(dir);
    return out;
  }

  private guessExtension(mime: string | undefined, name: string | undefined): string {
    if (name && name.includes('.')) return name.split('.').pop()!.toLowerCase();
    if (!mime) return 'bin';
    if (mime.includes('pdf')) return 'pdf';
    if (mime.includes('png')) return 'png';
    if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
    if (mime.includes('webp')) return 'webp';
    if (mime.includes('plain')) return 'txt';
    if (mime.includes('markdown')) return 'md';
    return 'bin';
  }

  /**
   * Извлекает медиа-маркеры из ответа LLM. Возвращает текст без них + список.
   * Поддерживаемые формы:
   *   {{image: <prompt>}}
   *   {{image_edit: source=<url> | prompt=<...>}}
   *   {{image_compose: sources=<url>,<url>[,<url>] | prompt=<...>}}
   *   {{upscale: source=<url>}}
   *   {{file: url=<url> | caption=<...> | name=<...>}}
   */
  private extractOutgoingMarkers(reply: string): {
    cleanText: string;
    markers: OutgoingMarker[];
  } {
    const markers: OutgoingMarker[] = [];
    // Жадно матчим всё внутри {{…}} — но без вложенных скобок.
    const re = /\{\{(image|image_edit|image_compose|upscale|video|file)\s*:\s*([^{}]+?)\}\}/gi;
    const cleanText = reply.replace(re, (_full, kind: string, body: string) => {
      const k = kind.toLowerCase();
      if (k === 'image') {
        const prompt = body.trim();
        if (prompt) markers.push({ kind: 'image', prompt });
        return '';
      }
      // Остальные виды — key=value пары через |
      const parts = body.split('|').map((s: string) => s.trim());
      const kv: Record<string, string> = {};
      for (const pp of parts) {
        const m = pp.match(/^(\w+)\s*=\s*(.+)$/);
        if (m) kv[m[1].toLowerCase()] = m[2].trim();
      }
      if (k === 'image_edit') {
        if (kv.source && kv.prompt) markers.push({ kind: 'image_edit', source: kv.source, prompt: kv.prompt });
      } else if (k === 'image_compose') {
        const sources = (kv.sources ?? '').split(',').map(s => s.trim()).filter(Boolean);
        if (sources.length >= 2 && kv.prompt) {
          markers.push({ kind: 'image_compose', sources: sources.slice(0, 3), prompt: kv.prompt });
        }
      } else if (k === 'upscale') {
        if (kv.source) markers.push({ kind: 'upscale', source: kv.source });
      } else if (k === 'video') {
        if (kv.prompt) {
          const mode = (kv.mode === 'image2video' ? 'image2video' : 'text2video') as 'text2video' | 'image2video';
          const duration = kv.duration ? Math.max(5, Math.min(10, parseInt(kv.duration, 10) || 5)) : 5;
          markers.push({
            kind: 'video',
            prompt: kv.prompt,
            source: kv.source || undefined,
            duration: duration as 5 | 10,
            mode,
            model: kv.model || undefined,
          });
        }
      } else if (k === 'file') {
        if (kv.url) markers.push({ kind: 'file', url: kv.url, caption: kv.caption, name: kv.name });
      }
      return ''; // вырезаем маркер из текста
    }).replace(/\n{3,}/g, '\n\n').trim();
    return { cleanText, markers };
  }

  /**
   * Картинку шлём БАЙТАМИ, а не ссылкой.
   *
   * Telegram скачивает URL своими серверами, а my.linkeon.io живёт за РФ-edge
   * Selectel, до которого подсети дата-центров Telegram не доходят — та же
   * ingress-фильтрация, из-за которой вебхуку понадобился закреплённый IP
   * (TG_WEBHOOK_IP). На живом ходе 28.08.2026 это выглядело так: картинка
   * сгенерилась успешно, а sendPhoto ответил 400 «failed to get HTTP URL
   * content», и человек увидел молчание вместо картинки.
   *
   * Тот же приём уже применён к маркеру file ниже.
   *
   * Ссылка здесь наша (её вернул генератор), и fetchMediaBytes читает её из
   * своего MinIO напрямую — без круга через прокси Selectel.
   */
  private async sendPhotoFromUrl(chatId: number, url: string, options: any): Promise<void> {
    const media = await fetchMediaBytes(url, { maxBytes: MAX_ATTACHMENT_BYTES, timeoutMs: 30_000, allowHttp: true });
    await this.grammy.sendPhoto(chatId, media.data, options);
  }

  /**
   * Отправляем каждый attachment-маркер отдельным сообщением. Ошибка по
   * конкретному файлу не валит остальные и не роняет ход — логируем, коротко
   * пишем в чат и продолжаем. Сюда же приходит отказ по ссылке во внутреннюю
   * сеть (UnsafeUrlError): его сообщение рассчитано на человека.
   */
  private async deliverOutgoingMarkers(cfg: TgBotConfigRow, msg: any, markers: OutgoingMarker[], lang: TgLang): Promise<void> {
    for (const m of markers.slice(0, 3)) {
      try {
        await this.dispatchOutgoingMarker(cfg, msg, m, lang);
      } catch (e: any) {
        // Причина — только в лог: её текст бывает русским («Недостаточно
        // токенов») или внутренним посреди переведённого сообщения.
        this.logger.warn(`outgoing marker (${m.kind}) failed in chat ${msg.chat.id}: ${e.message}`);
        try {
          await this.grammy.sendMessage(msg.chat.id, tgText(lang, 'attach_failed'));
        } catch { /* ignore */ }
      }
    }
  }

  /** Отправляет один маркер: генерим картинку или скачиваем по URL → шлём в чат. */
  private async dispatchOutgoingMarker(cfg: TgBotConfigRow, msg: any, m: OutgoingMarker, lang: TgLang): Promise<void> {
    if (m.kind === 'image') {
      this.grammy.sendChatAction(msg.chat.id, 'upload_photo').catch(() => {});
      const res = await this.misc.generateImage(cfg.owner_user_id, { prompt: m.prompt });
      const url = res?.images?.[0]?.url;
      if (!url) throw new Error('image-gen вернул пустой URL');
      await this.sendPhotoFromUrl(msg.chat.id, url, {
        reply_to_message_id: msg.message_id,
        caption: m.prompt.slice(0, 1024),
      });
      return;
    }
    if (m.kind === 'image_edit') {
      this.grammy.sendChatAction(msg.chat.id, 'upload_photo').catch(() => {});
      const res = await this.misc.editImage(cfg.owner_user_id, { prompt: m.prompt, sourceImageUrl: m.source });
      const url = res?.images?.[0]?.url;
      if (!url) throw new Error('image-edit вернул пустой URL');
      await this.sendPhotoFromUrl(msg.chat.id, url, {
        reply_to_message_id: msg.message_id,
        caption: m.prompt.slice(0, 1024),
      });
      return;
    }
    if (m.kind === 'image_compose') {
      this.grammy.sendChatAction(msg.chat.id, 'upload_photo').catch(() => {});
      const res = await this.misc.composeImage(cfg.owner_user_id, { prompt: m.prompt, sourceImageUrls: m.sources });
      const url = res?.images?.[0]?.url;
      if (!url) throw new Error('image-compose вернул пустой URL');
      await this.sendPhotoFromUrl(msg.chat.id, url, {
        reply_to_message_id: msg.message_id,
        caption: m.prompt.slice(0, 1024),
      });
      return;
    }
    if (m.kind === 'upscale') {
      this.grammy.sendChatAction(msg.chat.id, 'upload_photo').catch(() => {});
      const res = await this.misc.upscaleImage(cfg.owner_user_id, { sourceImageUrl: m.source });
      const url = res?.images?.[0]?.url;
      if (!url) throw new Error('upscale вернул пустой URL');
      await this.sendPhotoFromUrl(msg.chat.id, url, {
        reply_to_message_id: msg.message_id,
      });
      return;
    }
    if (m.kind === 'video') {
      // Видео — async (Kling/Veo: 1-3 минуты). Запускаем job, привязываем к
      // чату, юзеру сразу пишем "в очереди". TgVideoDispatchService доставит
      // результат когда status=ready.
      this.grammy.sendChatAction(msg.chat.id, 'record_video').catch(() => {});
      const dto: any = {
        mode: m.mode,
        prompt: m.prompt,
        duration: m.duration ?? 5,
      };
      if (m.model) dto.model = m.model;
      if (m.source) dto.sourceImageUrl = m.source;
      const job = await this.video.createJob(cfg.owner_user_id, dto);
      await this.pg.query(
        `INSERT INTO tg_bot_video_jobs (job_id, tg_chat_id, tg_reply_to_message_id, config_id)
         VALUES ($1, $2, $3, $4) ON CONFLICT (job_id) DO NOTHING`,
        [job.jobId, msg.chat.id, msg.message_id, cfg.id],
      );
      await this.grammy.sendMessage(
        msg.chat.id,
        tgText(lang, 'video_queued'),
        { reply_to_message_id: msg.message_id },
      );
      return;
    }
    // file: качаем сами и шлём как document, чтобы Telegram не ограничивал
    // по размеру изображения (для картинок лучше отдельный {{image:…}}).
    //
    // Ссылку пишет МОДЕЛЬ, а её можно уговорить текстом из чата — и скачанные
    // байты уходят прямо в чат. Поэтому только fetchMediaBytes: внутренние
    // адреса (Redis, MinIO, сам API, метаданные облака) и редиректы на них
    // отбиваются до запроса. Отказ бросается как обычная ошибка, и цикл
    // маркеров выше коротко пишет в чат, что файл не приложен.
    this.grammy.sendChatAction(msg.chat.id, 'upload_document').catch(() => {});
    const media = await fetchMediaBytes(m.url, { maxBytes: MAX_ATTACHMENT_BYTES, timeoutMs: 30_000, allowHttp: true });
    const buf = media.data;
    const name = m.name || m.url.split('/').pop() || 'file.bin';
    await this.grammy.sendDocument(msg.chat.id, buf, name, {
      reply_to_message_id: msg.message_id,
      caption: m.caption?.slice(0, 1024),
    });
  }

  /**
   * Артефакты, сделанные Claude В ЭТОМ ходе. Recursive walk, ограничиваем по
   * whitelist расширений (см. SANDBOX_OUTPUT_EXTS) и размеру файла. Скрипты
   * (.py/.sh/etc.) сюда не попадают — это рабочие файлы Claude, не результат.
   *
   * Папка теперь живёт между ходами, поэтому одной whitelist мало: без отсечки
   * по времени бот на каждый ход заново слал бы весь накопленный архив чата.
   * Отсекаем по двум признакам сразу — mtime старше начала хода и явный список
   * входящих. Только mtime ненадёжен: вложение пишется в ту же папку за
   * миллисекунды до старта, и по времени его от результата не отличить.
   */
  private scanSandboxOutputs(dir: string, sinceMs: number, exclude: Set<string>): string[] {
    const results: string[] = [];
    const walk = (d: string) => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) {
          // Не лезем в node_modules / __pycache__ / .git и подобные служебные дирки.
          if (e.name.startsWith('.') || ['node_modules', '__pycache__', 'venv', '.venv'].includes(e.name)) continue;
          walk(full);
          continue;
        }
        if (!e.isFile()) continue;
        if (exclude.has(full)) continue;
        const ext = (e.name.split('.').pop() ?? '').toLowerCase();
        if (!SANDBOX_OUTPUT_EXTS.has(ext)) continue;
        let st: fs.Stats;
        try { st = fs.statSync(full); } catch { continue; }
        if (st.mtimeMs < sinceMs) continue;
        if (st.size === 0 || st.size > MAX_SANDBOX_OUTPUT_SIZE) continue;
        results.push(full);
      }
    };
    walk(dir);
    // Ограничиваем количество — иначе одно сообщение бота заполонит чат.
    return results.slice(0, 5);
  }

  /**
   * Bot kicked/left from a chat — archive the config + DM owner.
   * Telegram sends `my_chat_member` update with new_status='left'/'kicked' (also 'banned').
   */
  private async handleMyChatMember(event: any): Promise<void> {
    const newStatus = event.new_chat_member?.status;
    if (!['left', 'kicked', 'banned'].includes(newStatus)) return;

    const cfg = await this.configs.getActiveByTgChatId(event.chat.id);
    if (!cfg) return;

    await this.pg.query(
      `UPDATE tg_bot_configs SET status = 'archived', archived_at = now() WHERE id = $1`,
      [cfg.id],
    );
    this.logger.log(`config ${cfg.id} archived — bot ${newStatus} from chat ${event.chat.id}`);

    // DM owner (silent failure ok — owner may not have started DM with bot)
    const ownerTg = await this.identity.getIdentityByLinkeonId(cfg.owner_user_id);
    if (ownerTg) {
      try {
        const lang = await this.langFor(cfg.owner_user_id);
        await this.grammy.sendMessage(
          ownerTg.tgUserId,
          cfg.tg_chat_title
            ? tgText(lang, 'bot_removed', { name: cfg.display_name, group: cfg.tg_chat_title })
            : tgText(lang, 'bot_removed_untitled', { name: cfg.display_name }),
        );
      } catch { /* ignore */ }
    }
  }

  /**
   * Язык служебных сообщений: есть аккаунт Linkeon — язык его профиля, нет —
   * язык клиента Telegram того, кто пишет (см. ownerTgLanguage). Не бросает:
   * язык — не повод ронять ответ.
   */
  private langFor(ownerUserId: string | null | undefined, from?: { language_code?: string } | null): Promise<TgLang> {
    return ownerTgLanguage(this.pg, ownerUserId, from?.language_code);
  }

  /** Язык человека, о котором известен только его Telegram. Не бросает. */
  private async langOfTgUser(from: any): Promise<TgLang> {
    let ownerId: string | null = null;
    try {
      ownerId = await this.identity.getLinkeonIdByTgUserId(from?.id);
    } catch {
      // Без привязки язык возьмём из клиента Telegram.
    }
    return this.langFor(ownerId, from);
  }

  /**
   * Побочная работа хода — без ожидания: оповещения владельца о балансе и
   * отметки о них. При нуле это Redis, а ioredis при обрыве не падает сразу,
   * а держит команду в очереди 23–63 с — под замком чата, пока следующая
   * реплика человека получает «Минутку» без ответа. Ошибки — только в лог;
   * через Promise.resolve синхронный throw задачи тоже не уходит наверх.
   */
  private inBackground(what: string, job: () => Promise<unknown>): void {
    Promise.resolve()
      .then(job)
      .catch((e: any) => this.logger.error(`${what} failed: ${e?.message}`, e?.stack));
  }

  // hashtext-эквивалент: 32-битный знаковый int для pg_advisory_lock
  private hashLock(key: string): number {
    let h = 0;
    for (let i = 0; i < key.length; i++) h = ((h << 5) - h + key.charCodeAt(i)) | 0;
    return h;
  }
}
