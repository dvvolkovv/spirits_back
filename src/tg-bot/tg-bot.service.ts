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

// Лимит размера файла, который мы готовы скачать с Telegram и передать в Claude.
// Telegram сам отдаёт через Bot API до 20 МБ; больше — нужен MTProto, не наш кейс.
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

type OutgoingMarker =
  | { kind: 'image'; prompt: string }
  | { kind: 'file'; url: string; caption?: string; name?: string };

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
  ) {}

  async onModuleInit() {
    await this.applyMigration('001_tg_bot_schema.sql');
    await this.applyMigration('002_tg_bot_custom_agent_fk.sql');
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
      return;
    }

    try {
      await this.router.persistUserMessage(cfg, ctx);

      // Phase 8: handle slash-commands (/help /balance /silent /resume) ДО LLM-вызова.
      // tryHandle вернёт true если это была команда — в таком случае биллинг не запускаем.
      const handled = await this.commands.tryHandle(cfg, msg);
      if (handled) return;

      const should = await this.router.shouldRespond(cfg, ctx);
      if (!should) return;

      const ownerRes = await this.pg.query(
        `SELECT profile_data->>'name' AS first_name FROM ai_profiles_consolidated WHERE user_id = $1 LIMIT 1`,
        [cfg.owner_user_id],
      );
      const ownerFirstName = ownerRes.rows[0]?.first_name ?? 'Linkeon-пользователь';

      const reply = await this.router.generateReply(cfg, ownerFirstName, attachments);

      // Парсим маркеры {{image:...}} и {{file:...}} — они идут отдельными сообщениями,
      // в основном тексте их быть не должно.
      const { cleanText, markers } = this.extractOutgoingMarkers(reply.text);

      // Voice reply policy. Голос — только для текстовой части ответа, не для файлов.
      const wantsVoice =
        cfg.voice_reply_mode === 'always' ||
        (cfg.voice_reply_mode === 'mirror' && actualIsVoice);

      let contentType: 'text' | 'voice_reply' = 'text';
      let voiceTtsCostUsd = 0;

      const textToSend = cleanText || (markers.length > 0 ? '' : '...');

      if (wantsVoice && textToSend) {
        try {
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
   * Извлекает маркеры {{image:...}} и {{file:...}} из ответа LLM.
   * Возвращает текст без маркеров + список найденных. Кейсы:
   *   {{image: подсолнух в стиле Ван Гога}}
   *   {{file: url=https://my.linkeon.io/some.pdf | caption=Отчёт | name=q4.pdf}}
   */
  private extractOutgoingMarkers(reply: string): {
    cleanText: string;
    markers: OutgoingMarker[];
  } {
    const markers: OutgoingMarker[] = [];
    // Жадно матчим всё внутри {{…}} — но без вложенных скобок.
    const re = /\{\{(image|file)\s*:\s*([^{}]+?)\}\}/gi;
    const cleanText = reply.replace(re, (_full, kind: string, body: string) => {
      const k = kind.toLowerCase() as 'image' | 'file';
      if (k === 'image') {
        const prompt = body.trim();
        if (prompt) markers.push({ kind: 'image', prompt });
      } else {
        const parts = body.split('|').map((s: string) => s.trim());
        const kv: Record<string, string> = {};
        for (const pp of parts) {
          const m = pp.match(/^(\w+)\s*=\s*(.+)$/);
          if (m) kv[m[1].toLowerCase()] = m[2].trim();
        }
        if (kv.url) {
          markers.push({ kind: 'file', url: kv.url, caption: kv.caption, name: kv.name });
        }
      }
      return ''; // вырезаем маркер из текста
    }).replace(/\n{3,}/g, '\n\n').trim();
    return { cleanText, markers };
  }

  /** Отправляет один маркер: генерим картинку или скачиваем по URL → шлём в чат. */
  private async dispatchOutgoingMarker(cfg: TgBotConfigRow, msg: any, m: OutgoingMarker): Promise<void> {
    if (m.kind === 'image') {
      const res = await this.misc.generateImage(cfg.owner_user_id, { prompt: m.prompt });
      const url = res?.images?.[0]?.url;
      if (!url) throw new Error('image-gen вернул пустой URL');
      await this.grammy.sendPhoto(msg.chat.id, url, {
        reply_to_message_id: msg.message_id,
        caption: m.prompt.slice(0, 1024),
      });
      return;
    }
    // file: качаем сами и шлём как document, чтобы Telegram не ограничивал
    // по размеру изображения (для картинок лучше отдельный {{image:…}})
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
