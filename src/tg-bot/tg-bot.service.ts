import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import axios from 'axios';
import { PgService } from '../common/services/pg.service';
import { TgIdentityService } from './tg-identity.service';
import { TgClaimService } from './tg-claim.service';
import { TgConfigService, TgBotConfigRow } from './tg-config.service';
import { TgRouterService } from './tg-router.service';
import { TgVoiceService } from './tg-voice.service';
import { TgBillingService } from './tg-billing.service';
import { TgCommandsService } from './tg-commands.service';
import { TgGrammyClient } from './tg-grammy.client';
import { MiscService } from '../misc/misc.service';
import { VideoService } from '../video/video.service';

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

@Injectable()
export class TgBotService implements OnModuleInit {
  private readonly logger = new Logger(TgBotService.name);

  constructor(
    private readonly pg: PgService,
    private readonly identity: TgIdentityService,
    private readonly claim: TgClaimService,
    private readonly configs: TgConfigService,
    private readonly router: TgRouterService,
    private readonly voice: TgVoiceService,
    private readonly billing: TgBillingService,
    private readonly commands: TgCommandsService,
    private readonly grammy: TgGrammyClient,
    private readonly misc: MiscService,
    private readonly video: VideoService,
  ) {}

  async onModuleInit() {
    await this.applyMigration('001_tg_bot_schema.sql');
    await this.applyMigration('002_tg_bot_custom_agent_fk.sql');
    await this.applyMigration('003_tg_bot_video_delivery.sql');
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
      if (update.my_chat_member) {
        await this.handleMyChatMember(update.my_chat_member);
        return;
      }
    } catch (e: any) {
      this.logger.error(`handleUpdate failed: ${e.message}\n${e.stack}`);
    }
  }

  private async handleMessage(msg: any): Promise<void> {
    if (msg.from?.is_bot) return;
    if (msg.new_chat_members || msg.left_chat_member || msg.pinned_message) return;

    const chatType = msg.chat?.type;

    // В группах Telegram добавляет к командам @<botname>: `/start@LinkeonTestBot <token>`.
    // В личке — без суффикса. Парсим оба формата.
    const startToken = typeof msg.text === 'string' ? this.parseStartToken(msg.text) : null;

    if (chatType === 'private' && startToken) {
      await this.handleDmStart(msg, startToken);
      return;
    }

    if (chatType === 'private' && (msg.text === '/start' || msg.text?.startsWith('/start@'))) {
      await this.grammy.sendMessage(
        msg.chat.id,
        'Привет! Для подключения зайди в Linkeon и нажми «Подключить Telegram».',
      );
      return;
    }

    if (chatType === 'private' && typeof msg.text === 'string' && msg.text.startsWith('/')) {
      await this.handleDmCommand(msg);
      return;
    }

    if (chatType === 'channel') {
      try { await this.grammy.leaveChat(msg.chat.id); } catch { /* ignore */ }
      return;
    }

    if (chatType === 'group' || chatType === 'supergroup') {
      if (startToken) {
        await this.handleGroupClaim(msg, startToken);
        return;
      }
      await this.handleGroupMessage(msg);
      return;
    }
  }

  // Парсит `/start <token>` и `/start@<botname> <token>`. Возвращает токен или null.
  private parseStartToken(text: string): string | null {
    const m = text.match(/^\/start(?:@\S+)?\s+(\S+)/);
    return m ? m[1] : null;
  }

  // Команды в личке с ботом: /help (всем) и /balance (привязанному юзеру).
  // /silent /resume — групповые, в DM не имеют смысла.
  private async handleDmCommand(msg: any): Promise<void> {
    const text = msg.text.toLowerCase().trim();
    const cmd = text.split('@')[0].split(' ')[0];

    if (cmd === '/help') {
      await this.grammy.sendMessage(
        msg.chat.id,
        `Я бот Linkeon — отвечаю в группах, куда меня добавил владелец.

Команды (работают и здесь, и в группе — где надо, привязка по твоему Telegram):
/start — подключить Telegram к Linkeon
/balance — баланс токенов твоего аккаунта
/silent — замолчать все твои боты во всех группах
/resume — снова включить их
/help — это сообщение

В группе /silent /resume управляют только тем ботом, в чате с которым вызваны.

Веб-кабинет: https://my.linkeon.io/telegram-bots`,
      );
      return;
    }

    if (cmd === '/balance') {
      const ownerId = await this.identity.getLinkeonIdByTgUserId(msg.from.id);
      if (!ownerId) {
        await this.grammy.sendMessage(
          msg.chat.id,
          'Telegram не привязан к Linkeon. Зайди в кабинет и нажми «Подключить Telegram».',
        );
        return;
      }
      const bal = await this.billing.getBalance(ownerId);
      await this.grammy.sendMessage(
        msg.chat.id,
        `Баланс: *${bal.toLocaleString('ru-RU')}* токенов.\nПополнить: https://my.linkeon.io/tokens`,
        { parse_mode: 'Markdown' },
      );
      return;
    }

    if (cmd === '/silent' || cmd === '/resume') {
      const ownerId = await this.identity.getLinkeonIdByTgUserId(msg.from.id);
      if (!ownerId) {
        await this.grammy.sendMessage(
          msg.chat.id,
          'Telegram не привязан к Linkeon. /start или зайди в кабинет и нажми «Подключить Telegram».',
        );
        return;
      }
      const targetStatus = cmd === '/silent' ? 'silent' : 'active';
      const fromStatuses = cmd === '/silent' ? ['active'] : ['silent'];
      const r = await this.pg.query(
        `UPDATE tg_bot_configs SET status = $1
          WHERE owner_user_id = $2 AND status = ANY($3::text[])
          RETURNING id, display_name, tg_chat_title`,
        [targetStatus, ownerId, fromStatuses],
      );
      if (r.rowCount === 0) {
        await this.grammy.sendMessage(
          msg.chat.id,
          cmd === '/silent'
            ? 'У тебя нет активных ботов, которых можно замолчать.'
            : 'У тебя нет молчащих ботов, которых можно возобновить.',
        );
        return;
      }
      const list = r.rows.map(b => `• *${b.display_name}* в «${b.tg_chat_title ?? 'группе'}»`).join('\n');
      const verb = cmd === '/silent' ? '🤫 Замолкли' : '✅ Снова на связи';
      await this.grammy.sendMessage(
        msg.chat.id,
        `${verb}:\n${list}`,
        { parse_mode: 'Markdown' },
      );
      return;
    }

    // неизвестная команда — не ругаемся, /help подскажет
    await this.grammy.sendMessage(
      msg.chat.id,
      `Не знаю такой команды. /help — список доступных.`,
    );
  }

  private async handleDmStart(msg: any, token: string): Promise<void> {
    try {
      const ownerId = await this.identity.consumeAuthToken(
        token,
        msg.from.id,
        msg.from.username ?? null,
        msg.from.first_name ?? null,
      );
      await this.grammy.sendMessage(
        msg.chat.id,
        `Привет, ${msg.from.first_name}! Твой Telegram привязан к Linkeon. Теперь возвращайся в кабинет и создавай ботов для групп.`,
      );
      this.logger.log(`identity bound: linkeon=${ownerId} tg=${msg.from.id}`);
    } catch (e: any) {
      await this.grammy.sendMessage(
        msg.chat.id,
        `Не получилось привязать: ${e.message}. Сгенерируй новую ссылку в Linkeon (старая могла истечь — TTL 15 минут).`,
      );
    }
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
      await this.grammy.sendMessage(
        msg.chat.id,
        `Я ${result.displayName}. Зови меня @${botUsername} или ответом на это сообщение.`,
      );
      this.logger.log(`config ${result.configId} activated for chat ${msg.chat.id}`);
    } catch (e: any) {
      const ownerTgId = msg.from.id;
      try {
        await this.grammy.sendMessage(ownerTgId, `Не получилось привязать бота: ${e.message}`);
      } catch { /* ignore */ }
      this.logger.warn(`claim failed for chat ${msg.chat.id}: ${e.message}`);
      try { await this.grammy.leaveChat(msg.chat.id); } catch { /* ignore */ }
    }
  }

  private async handleGroupMessage(msg: any): Promise<void> {
    const cfg = await this.configs.getActiveByTgChatId(msg.chat.id);
    if (!cfg) return;

    const isVoice = !!(msg.voice || msg.audio);
    let workingText: string = msg.text ?? msg.caption ?? '';
    let actualIsVoice = false;
    let voiceFileId: string | undefined;

    if (isVoice) {
      voiceFileId = msg.voice?.file_id ?? msg.audio?.file_id;
      if (!voiceFileId) return;
      try {
        workingText = await this.voice.transcribe(voiceFileId);
        actualIsVoice = true;
        this.logger.log(`voice transcribed in chat ${msg.chat.id}: "${workingText.substring(0, 50)}..."`);
      } catch (e: any) {
        this.logger.warn(`STT failed for chat ${msg.chat.id}: ${e.message}`);
        return;
      }
    }

    // Скачиваем приложенные фото/документы. Если пусто — просто пустой массив.
    const attachments: string[] = [];
    if (!isVoice) {
      try {
        const dl = await this.downloadIncomingAttachments(msg);
        attachments.push(...dl);
      } catch (e: any) {
        this.logger.warn(`attachment download failed in chat ${msg.chat.id}: ${e.message}`);
      }
    }

    // Если есть файлы но текста нет — даём LLM плейсхолдер, иначе будет early return.
    if (!workingText && attachments.length > 0) {
      workingText = '(юзер прислал файл без подписи — разбери и прокомментируй)';
    }
    if (!workingText) return;

    // Pre-flight: balance check. При 0 — однократное сообщение в группе.
    const preBalance = await this.billing.getBalance(cfg.owner_user_id);
    if (preBalance <= 0) {
      const notified = await this.billing.hasZeroBalanceFlag(cfg.id);
      if (!notified) {
        try {
          await this.grammy.sendMessage(
            msg.chat.id,
            `У владельца закончились токены. Пополнить: https://my.linkeon.io/tokens`,
          );
          await this.billing.markZeroBalanceNotified(cfg.id);
        } catch { /* ignore */ }
      }
      return;
    }

    const botUserId = await this.grammy.getBotUserId();
    const ctx = {
      chatId: msg.chat.id,
      msgId: msg.message_id,
      fromTgUserId: msg.from.id,
      fromTgUserName: msg.from.first_name ?? msg.from.username ?? null,
      text: workingText,
      replyToBotMessageId: msg.reply_to_message?.message_id,
      replyToFromBot: msg.reply_to_message?.from?.id === botUserId,
      isVoice: actualIsVoice,
      voiceFileId,
      attachmentPaths: attachments.length ? attachments : undefined,
    };

    const lockId = this.hashLock(`tg-chat:${msg.chat.id}`);
    const lockRes = await this.pg.query(`SELECT pg_try_advisory_lock($1)`, [lockId]);
    if (!lockRes.rows[0].pg_try_advisory_lock) {
      this.logger.debug(`chat ${msg.chat.id} busy, skipping`);
      // Без обратной связи юзер не понимает что произошло. typing-action длится
      // ~5с и сигнализирует "вижу тебя, но занят" без отдельного сообщения-спама.
      try { await this.grammy.sendChatAction(msg.chat.id, 'typing'); } catch { /* ignore */ }
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
    // Песочница — выдаём Claude изолированную пустую папку под Bash/Write.
    // Если что-то там создаст с whitelist-расширением — авто-приложим к ответу.
    let sandboxDir: string | null = null;

    try {
      await this.router.persistUserMessage(cfg, ctx);

      // Phase 8: handle slash-commands (/help /balance /silent /resume) ДО LLM-вызова.
      // tryHandle вернёт true если это была команда — в таком случае биллинг не запускаем.
      const handled = await this.commands.tryHandle(cfg, msg);
      if (handled) return;

      const should = await this.router.shouldRespond(cfg, ctx);
      if (!should) return;

      // Создаём per-request песочницу. Если mkdir упадёт — Claude поработает
      // без Bash/Write (старый режим, только текст + медиа-маркеры).
      try {
        const candidate = path.join(os.tmpdir(), `tg-bot-${cfg.id}-${msg.message_id}-${Date.now()}`);
        fs.mkdirSync(candidate, { recursive: true, mode: 0o700 });
        sandboxDir = candidate;
      } catch (e: any) {
        this.logger.warn(`sandbox mkdir failed for chat ${msg.chat.id}: ${e.message}`);
      }

      this.grammy.sendChatAction(msg.chat.id, 'typing').catch(() => {});
      typingTimer = setInterval(() => {
        this.grammy.sendChatAction(msg.chat.id, 'typing').catch(() => {});
      }, 4000);

      // Стартовое status-сообщение. Если оно не отправилось (rate-limit/permission)
      // — продолжаем без статуса, не блокируем основной поток.
      try {
        const sent = await this.grammy.sendMessage(msg.chat.id, '🤔 Думаю...', {
          reply_to_message_id: msg.message_id,
        });
        statusMsgId = sent.message_id;
        statusLastLabel = '🤔 Думаю...';
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

      const labelFor = (toolName: string): string => {
        if (toolName === 'Read') return '📄 Читаю файл...';
        if (toolName === 'Write') return '✏️ Пишу файл...';
        if (toolName === 'Edit') return '✏️ Редактирую файл...';
        if (toolName === 'Bash') return '⚙️ Выполняю команду...';
        if (toolName === 'Glob') return '🔍 Ищу файлы...';
        if (toolName === 'Grep') return '🔍 Ищу в файлах...';
        if (toolName === 'WebSearch') return '🌐 Ищу в интернете...';
        if (toolName === 'WebFetch') return '🌐 Открываю страницу...';
        if (/generate_image|edit_image|compose_image/i.test(toolName)) return '🎨 Готовлю картинку...';
        if (/upscale_image/i.test(toolName)) return '✨ Улучшаю картинку...';
        if (/generate_video|video/i.test(toolName)) return '🎬 Запускаю генерацию видео...';
        return `⚙️ ${toolName}...`;
      };

      const ownerRes = await this.pg.query(
        `SELECT profile_data->>'name' AS first_name FROM ai_profiles_consolidated WHERE user_id = $1 LIMIT 1`,
        [cfg.owner_user_id],
      );
      const ownerFirstName = ownerRes.rows[0]?.first_name ?? 'Linkeon-пользователь';

      let reply: { text: string; costUsd: number };
      try {
        reply = await this.router.generateReply(cfg, ownerFirstName, attachments, (ev) => {
          if (ev.kind === 'tool_use') editStatus(labelFor(ev.name)).catch(() => {});
        }, sandboxDir ?? undefined);
      } catch (e: any) {
        // Не вылетаем тихо — пишем юзеру в статус, что не получилось.
        if (statusMsgId) {
          try {
            await this.grammy.editMessageText(
              msg.chat.id,
              statusMsgId,
              `⚠️ Не получилось обработать запрос: ${String(e.message || 'неизвестная ошибка').slice(0, 200)}`,
            );
            statusMsgId = null; // не удалять в finally — оставляем как уведомление
          } catch { /* ignore */ }
        }
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

      // Сканим песочницу — что Claude насоздавал из артефактов. Скрипты (.py/.sh)
      // в whitelist не входят, посылаем только итоговые файлы.
      const sandboxOutputs = sandboxDir ? this.scanSandboxOutputs(sandboxDir) : [];

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
          await this.grammy.sendVoice(msg.chat.id, tts.buffer, {
            reply_to_message_id: msg.message_id,
            caption: textToSend.substring(0, 1024),
          });
          contentType = 'voice_reply';
        } catch (e: any) {
          this.logger.warn(`TTS failed for chat ${msg.chat.id}, fallback to text: ${e.message}`);
          await this.grammy.sendMessage(msg.chat.id, textToSend, {
            reply_to_message_id: msg.message_id,
          });
        }
      } else if (textToSend) {
        await this.grammy.sendMessage(msg.chat.id, textToSend, {
          reply_to_message_id: msg.message_id,
        });
      }

      // Отправляем каждый attachment-маркер отдельным сообщением. Ошибка по
      // конкретному файлу не валит остальные — логируем и продолжаем.
      for (const m of markers.slice(0, 3)) {
        try {
          await this.dispatchOutgoingMarker(cfg, msg, m);
        } catch (e: any) {
          this.logger.warn(`outgoing marker (${m.kind}) failed in chat ${msg.chat.id}: ${e.message}`);
          try {
            await this.grammy.sendMessage(msg.chat.id, `(не удалось приложить ${m.kind}: ${e.message})`);
          } catch { /* ignore */ }
        }
      }

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
      const tokensCharged = this.billing.tokensFromUsd(totalCostUsd);
      const newBalance = await this.billing.deduct(cfg.owner_user_id, tokensCharged);
      this.logger.log(
        `tg-bot billing: config=${cfg.id} cost=$${totalCostUsd.toFixed(5)} deducted=${tokensCharged} balance=${newBalance}`,
      );
      // При успешном списании > 0 — сбрасываем flag, чтобы при следующем падении в 0 снова срабатывало однократное сообщение
      if (newBalance > 0) {
        await this.billing.clearZeroBalanceFlag(cfg.id);
      }
      await this.router.persistAssistantReply(cfg, reply.text, contentType, tokensCharged);

      // DM-alert при низком балансе (post-deduct)
      const ownerTg = await this.identity.getIdentityByLinkeonId(cfg.owner_user_id);
      await this.billing.checkBalanceAlerts(cfg.id, cfg.owner_user_id, ownerTg?.tgUserId ?? null);
    } finally {
      if (typingTimer) clearInterval(typingTimer);
      if (statusPendingTimer) clearTimeout(statusPendingTimer);
      if (statusMsgId) {
        // Сюда попадаем только если ни success-cleanup, ни error-edit не отработали
        // (например ранний throw до try-блока с generateReply). Прибираем за собой.
        try { await this.grammy.deleteMessage(msg.chat.id, statusMsgId); } catch { /* ignore */ }
      }
      // Песочницу сносим целиком — независимо от того успешно отдали артефакты
      // или Claude упал на полпути. Если оставить — диск засрётся.
      if (sandboxDir) {
        try { fs.rmSync(sandboxDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
      await this.pg.query(`SELECT pg_advisory_unlock($1)`, [lockId]);
      // Чистим временные файлы независимо от исхода.
      for (const p of attachments) {
        try { fs.unlinkSync(p); } catch { /* ignore */ }
      }
    }
  }

  /** Скачиваем фото/документ с Telegram → /tmp. Возвращает локальные пути. */
  private async downloadIncomingAttachments(msg: any): Promise<string[]> {
    const paths: string[] = [];
    // photo — массив размеров; берём самый большой (последний)
    if (Array.isArray(msg.photo) && msg.photo.length > 0) {
      const largest = msg.photo[msg.photo.length - 1];
      const p = await this.downloadOneFile(largest.file_id, largest.file_size, 'jpg');
      if (p) paths.push(p);
    }
    if (msg.document) {
      const d = msg.document;
      // расширение из mime или из имени файла
      const ext = this.guessExtension(d.mime_type, d.file_name);
      const p = await this.downloadOneFile(d.file_id, d.file_size, ext);
      if (p) paths.push(p);
    }
    return paths;
  }

  private async downloadOneFile(
    fileId: string,
    fileSize: number | undefined,
    ext: string,
  ): Promise<string | null> {
    if (fileSize && fileSize > MAX_ATTACHMENT_BYTES) {
      this.logger.warn(`skip oversized attachment: ${fileId} (${fileSize} bytes)`);
      return null;
    }
    const file = await this.grammy.getFile(fileId);
    if (!file.file_path) return null;
    const buf = await this.grammy.downloadFile(file.file_path);
    const safeExt = ext.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bin';
    const p = path.join(os.tmpdir(), `tg-attach-${fileId.slice(0, 16)}-${Date.now()}.${safeExt}`);
    fs.writeFileSync(p, buf);
    return p;
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

  /** Отправляет один маркер: генерим картинку или скачиваем по URL → шлём в чат. */
  private async dispatchOutgoingMarker(cfg: TgBotConfigRow, msg: any, m: OutgoingMarker): Promise<void> {
    if (m.kind === 'image') {
      this.grammy.sendChatAction(msg.chat.id, 'upload_photo').catch(() => {});
      const res = await this.misc.generateImage(cfg.owner_user_id, { prompt: m.prompt });
      const url = res?.images?.[0]?.url;
      if (!url) throw new Error('image-gen вернул пустой URL');
      await this.grammy.sendPhoto(msg.chat.id, url, {
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
      await this.grammy.sendPhoto(msg.chat.id, url, {
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
      await this.grammy.sendPhoto(msg.chat.id, url, {
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
      await this.grammy.sendPhoto(msg.chat.id, url, {
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
        '🎬 Видео в очереди (1-3 минуты). Пришлю как только будет готово.',
        { reply_to_message_id: msg.message_id },
      );
      return;
    }
    // file: качаем сами и шлём как document, чтобы Telegram не ограничивал
    // по размеру изображения (для картинок лучше отдельный {{image:…}})
    this.grammy.sendChatAction(msg.chat.id, 'upload_document').catch(() => {});
    if (!/^https?:\/\//i.test(m.url)) throw new Error('url должен быть https');
    const resp = await axios.get(m.url, { responseType: 'arraybuffer', timeout: 30_000, maxContentLength: MAX_ATTACHMENT_BYTES });
    const buf = Buffer.from(resp.data);
    const name = m.name || m.url.split('/').pop() || 'file.bin';
    await this.grammy.sendDocument(msg.chat.id, buf, name, {
      reply_to_message_id: msg.message_id,
      caption: m.caption?.slice(0, 1024),
    });
  }

  /**
   * Scan Claude's sandbox cwd for output artifacts. Recursive walk, ограничиваем
   * по whitelist расширений (см. SANDBOX_OUTPUT_EXTS) и размеру файла. Скрипты
   * (.py/.sh/etc.) сюда не попадают — это рабочие файлы Claude, не результат.
   */
  private scanSandboxOutputs(dir: string): string[] {
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
        const ext = (e.name.split('.').pop() ?? '').toLowerCase();
        if (!SANDBOX_OUTPUT_EXTS.has(ext)) continue;
        let size: number;
        try { size = fs.statSync(full).size; } catch { continue; }
        if (size === 0 || size > MAX_SANDBOX_OUTPUT_SIZE) continue;
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
        await this.grammy.sendMessage(
          ownerTg.tgUserId,
          `Бот «${cfg.display_name}» удалён из «${cfg.tg_chat_title ?? 'группы'}». Конфигурация архивирована — её можно восстановить в кабинете.`,
        );
      } catch { /* ignore */ }
    }
  }

  // hashtext-эквивалент: 32-битный знаковый int для pg_advisory_lock
  private hashLock(key: string): number {
    let h = 0;
    for (let i = 0; i < key.length; i++) h = ((h << 5) - h + key.charCodeAt(i)) | 0;
    return h;
  }
}
