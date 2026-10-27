import { Injectable, Logger } from '@nestjs/common';
import { approverChatId } from '../blog/blog-approval.service';
import { encryptSecret } from '../calendar/crypto';
import { PgService } from '../common/services/pg.service';
import { StorageService } from '../common/services/storage.service';
import { TgGrammyClient } from '../tg-bot/tg-grammy.client';
import { STAND_MARK } from './short-captions';
import { isStand } from './short-env';
import { ShortsSettingsService } from './shorts-settings.service';
import { YoutubeMode } from './shorts.types';
import { Http, axiosHttp } from './youtube/youtube-http';
import { authorizeUrl, exchangeCode, fetchMyChannel, youtubeOAuthConfig } from './youtube/youtube-oauth';
import { signState, verifyState } from './youtube/youtube-state';

/** Слова режимов — в командах и в сообщениях владельцу. */
export const MODE_WORDS: Record<YoutubeMode, string> = { manual: 'вручную', unlisted: 'по ссылке', public: 'публично' };

/** Повторный заход браузера на адрес возврата в эти минуты после подключения — не ошибка. */
const RECONNECT_GRACE_MS = 10 * 60 * 1000;

export interface YoutubeAccount {
  channelId: string;
  channelTitle: string | null;
  refreshTokenEnc: string;
  status: 'connected' | 'revoked';
  lastError: string | null;
  connectedAt: Date | null;
}

export interface ConnectPage {
  status: number;
  html: string;
}

/**
 * `/youtube [режим]` (и `/youtube@Бот`). null — не эта команда. arg пустой —
 * запрос статуса; arg непустой при mode null — режим не узнан.
 */
export function parseYoutubeCommand(text: unknown): { mode: YoutubeMode | null; arg: string } | null {
  if (typeof text !== 'string') return null;
  const m = text.match(/^\/youtube(?:@[A-Za-z0-9_]+)?(?=\s|$)([\s\S]*)$/i);
  if (!m) return null;
  const arg = m[1].trim().toLowerCase().replace(/\s+/g, ' ');
  const mode = (Object.keys(MODE_WORDS) as YoutubeMode[]).find((k) => MODE_WORDS[k] === arg) ?? null;
  return { mode, arg };
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ESCAPES[c]);

/** Страница для браузера после входа в Google: заголовок и одна фраза, без токенов. */
export function connectPage(status: number, title: string, text: string): ConnectPage {
  return {
    status,
    html:
      '<!doctype html><html lang="ru"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1"><title>Linkeon — YouTube</title></head>' +
      '<body style="font-family:system-ui,sans-serif;max-width:560px;margin:48px auto;padding:0 16px;line-height:1.5">' +
      `<h1 style="font-size:22px">${esc(title)}</h1><p>${esc(text)}</p></body></html>`,
  };
}

/**
 * YouTube роликов (спека 2026-10-27-shorts-youtube-autopublish-design.md):
 * подключение канала владельцем, режим, команда `/youtube`, загрузка ролика для
 * публикатора. Refresh-токен — в short_youtube_account, зашифрован
 * src/calendar/crypto.ts (как у Taler ID); access-токен живёт только в памяти.
 */
@Injectable()
export class ShortsYoutubeService {
  private readonly logger = new Logger(ShortsYoutubeService.name);
  /** HTTP к Google; тесты подставляют свой. */
  http: Http = axiosHttp;

  constructor(
    private readonly pg: PgService,
    private readonly tg: TgGrammyClient,
    private readonly storage: StorageService,
    private readonly settings: ShortsSettingsService,
  ) {}

  async account(): Promise<YoutubeAccount | null> {
    const r = await this.pg.query(`SELECT * FROM short_youtube_account WHERE id = 1`);
    const row = r.rows[0];
    if (!row) return null;
    return {
      channelId: row.channel_id,
      channelTitle: row.channel_title ?? null,
      refreshTokenEnc: row.refresh_token_enc,
      status: row.status === 'revoked' ? 'revoked' : 'connected',
      lastError: row.last_error ?? null,
      connectedAt: row.connected_at ? new Date(row.connected_at) : null,
    };
  }

  /** Ссылка на вход для владельца; null — на этой среде нет клиента OAuth. */
  connectUrl(chatId: number): string | null {
    const cfg = youtubeOAuthConfig();
    return cfg ? authorizeUrl(cfg, signState(cfg.clientSecret, cfg.redirectUri, chatId)) : null;
  }

  /**
   * `/youtube` — только владелец (`BLOG_APPROVER_TG_ID`) и только в личке, как
   * `/short`. Чужая команда не наша (false): бот ответит как на неизвестную.
   */
  async handleCommand(msg: any): Promise<boolean> {
    const cmd = parseYoutubeCommand(msg?.text);
    if (!cmd || msg?.chat?.type !== 'private') return false;
    const owner = approverChatId();
    if (!owner || Number(msg?.from?.id) !== owner) return false;
    const chatId = Number(msg?.chat?.id) || owner;
    try {
      if (cmd.arg && !cmd.mode) {
        await this.say(chatId, 'Не понял режим. Можно: /youtube публично, /youtube по ссылке, /youtube вручную.');
      } else if (cmd.mode) {
        await this.settings.update({ youtubeMode: cmd.mode });
        await this.say(chatId, await this.modeChanged(cmd.mode, chatId));
      } else {
        await this.say(chatId, await this.statusText(chatId));
      }
    } catch (e: any) {
      await this.say(chatId, `YouTube: не получилось — ${String(e?.message ?? e).slice(0, 300)}`);
    }
    return true;
  }

  /** Адрес возврата Google: проверить state, обменять код, запомнить канал, сказать владельцу. */
  async completeConnect(q: { code?: string; state?: string; error?: string }): Promise<ConnectPage> {
    const cfg = youtubeOAuthConfig();
    if (!cfg) return connectPage(503, 'YouTube не настроен', 'На этом сервере нет клиента OAuth YouTube.');
    if (q.error) return connectPage(200, 'Подключение отменено', 'Канал не подключён. Чтобы попробовать снова, пришлите боту /youtube.');
    const st = verifyState(cfg.clientSecret, cfg.redirectUri, q.state);
    const owner = approverChatId();
    if (!st || !owner || st.chatId !== owner) {
      return connectPage(400, 'Ссылка устарела', 'Пришлите боту /youtube и откройте новую ссылку.');
    }
    if (!q.code) return connectPage(400, 'Нет кода от Google', 'Пришлите боту /youtube и попробуйте ещё раз.');
    try {
      const tokens = await exchangeCode(this.http, cfg, q.code);
      const ch = await fetchMyChannel(this.http, tokens.accessToken);
      await this.pg.query(
        `INSERT INTO short_youtube_account
                (id, channel_id, channel_title, refresh_token_enc, scopes, status, last_error, connected_at, updated_at)
         VALUES (1, $1, $2, $3, $4, 'connected', NULL, now(), now())
         ON CONFLICT (id) DO UPDATE
            SET channel_id = EXCLUDED.channel_id, channel_title = EXCLUDED.channel_title,
                refresh_token_enc = EXCLUDED.refresh_token_enc, scopes = EXCLUDED.scopes,
                status = 'connected', last_error = NULL, connected_at = now(), updated_at = now()`,
        [ch.id, ch.title, encryptSecret(tokens.refreshToken), tokens.scope],
      );
      // Подключение при «вручную» включает «по ссылке»: первый ролик — проверка (спека, «Сценарий владельца»).
      // Канал хранится только в short_youtube_account; short_settings.youtube_channel_id не трогаем — одна правда.
      const r = await this.pg.query(
        `UPDATE short_settings
            SET youtube_mode = CASE WHEN youtube_mode = 'manual' THEN 'unlisted' ELSE youtube_mode END,
                updated_at = now()
          WHERE id = 1
          RETURNING youtube_mode`,
      );
      const mode: YoutubeMode = r.rows[0]?.youtube_mode ?? 'unlisted';
      const handle = ch.handle ? ` (${ch.handle})` : '';
      const check = mode === 'unlisted' ? ' Проверьте первый ролик: если открывается по ссылке и не стал приватным — /youtube публично.' : '';
      await this.say(st.chatId, `YouTube подключён: канал «${ch.title}»${handle}. Ролики будут загружаться сами, режим — ${MODE_WORDS[mode]}.${check}`);
      return connectPage(200, 'Канал подключён', `Канал «${ch.title}» подключён к роликам Linkeon. Вкладку можно закрыть — подтверждение пришло в Telegram.`);
    } catch (e: any) {
      const reason = String(e?.message ?? e).slice(0, 300);
      const acc = await this.account().catch((): YoutubeAccount | null => null);
      if (acc?.status === 'connected' && acc.connectedAt && Date.now() - acc.connectedAt.getTime() < RECONNECT_GRACE_MS) {
        // Браузер повторил адрес возврата: код уже обменян, канал подключён только что.
        return connectPage(200, 'Канал уже подключён', `Канал «${acc.channelTitle ?? acc.channelId}» подключён. Вкладку можно закрыть.`);
      }
      this.logger.error(`подключение YouTube не удалось: ${reason}`);
      await this.say(st.chatId, `YouTube не подключён: ${reason}`);
      return connectPage(502, 'Не получилось подключить канал', `${reason}. Пришлите боту /youtube и попробуйте ещё раз.`);
    }
  }

  private async statusText(chatId: number): Promise<string> {
    const link = this.connectUrl(chatId);
    if (!link) return 'YouTube не настроен на этом сервере: нет YOUTUBE_OAUTH_CLIENT_ID и YOUTUBE_OAUTH_CLIENT_SECRET в .env.';
    const [acc, s] = await Promise.all([this.account(), this.settings.get()]);
    const howTo =
      'Подключить: откройте ссылку (действует 15 минут), войдите в Google и выберите канал Linkeon. ' +
      `На экране «Google не проверил это приложение» нажмите «Дополнительно» → «Перейти».\n${link}`;
    if (!acc) return `YouTube: канал не подключён — ролики идут набором.\n\n${howTo}`;
    const name = `«${acc.channelTitle ?? acc.channelId}»`;
    if (acc.status === 'revoked') {
      return `YouTube: доступ к каналу ${name} пропал${acc.lastError ? ` (${acc.lastError})` : ''} — ролики идут набором.\n\n${howTo}`;
    }
    return (
      `YouTube: подключён канал ${name}, режим — ${MODE_WORDS[s.youtubeMode]}.\n\n` +
      'Сменить режим: /youtube публично · /youtube по ссылке · /youtube вручную\n' +
      `Переподключить (ссылка действует 15 минут):\n${link}`
    );
  }

  private async modeChanged(mode: YoutubeMode, chatId: number): Promise<string> {
    if (mode === 'manual') return 'Готово: YouTube — вручную, буду присылать набор.';
    const done = `Готово: ролики на YouTube — ${MODE_WORDS[mode]}.`;
    const acc = await this.account();
    if (acc?.status === 'connected') return done;
    const link = this.connectUrl(chatId);
    return `${done} Но канал не подключён, поэтому пока набор.${link ? `\n\nПодключить (ссылка действует 15 минут):\n${link}` : ''}`;
  }

  /** Сообщение владельцу. Сбой Telegram глотаем: он не повод ронять команду, подключение или публикацию. */
  private async say(chatId: number | null, text: string): Promise<void> {
    if (!chatId) {
      this.logger.warn(`BLOG_APPROVER_TG_ID не задан — сообщить некому: ${text.slice(0, 200)}`);
      return;
    }
    try {
      await this.tg.sendMessage(chatId, `${isStand() ? STAND_MARK : ''}${text}`, { link_preview_options: { is_disabled: true } });
    } catch (e: any) {
      this.logger.warn(`не смог написать ${chatId}: ${e?.message ?? e}`);
    }
  }
}
