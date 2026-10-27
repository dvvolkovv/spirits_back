import { Injectable, Logger } from '@nestjs/common';
import { approverChatId } from '../blog/blog-approval.service';
import { decryptSecret, encryptSecret } from '../calendar/crypto';
import { PgService } from '../common/services/pg.service';
import { StorageService } from '../common/services/storage.service';
import { TgGrammyClient } from '../tg-bot/tg-grammy.client';
import { STAND_MARK } from './short-captions';
import { isStand } from './short-env';
import { ShortsSettingsService } from './shorts-settings.service';
import { ShortVideo, YoutubeMode, shortsBucket } from './shorts.types';
import { YoutubeAuthError, YoutubeMaybeUploaded, YoutubeNotUploaded, YoutubeUploadExpired } from './youtube/youtube-errors';
import { Http, axiosHttp, clip } from './youtube/youtube-http';
import { YoutubeOAuthConfig, authorizeUrl, exchangeCode, fetchMyChannel, refreshAccessToken, youtubeOAuthConfig } from './youtube/youtube-oauth';
import { signState, verifyState } from './youtube/youtube-state';
import { UploadMeta, checkUpload, sendFile, startUpload } from './youtube/youtube-upload';

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

/** «Образование»: ролики — короткие разборы житейских вопросов. */
export const YOUTUBE_CATEGORY_ID = '27';

/** Что делать с роликом на YouTube: набор владельцу (с заметкой — почему) или загрузка с этим доступом. */
export type YoutubePlan = { kind: 'kit'; note: string | null } | { kind: 'upload'; privacy: 'unlisted' | 'public' };

/** К набору, когда у ролика жива сессия загрузки: прошлая загрузка могла дойти (спека, «Публикация», п. 7). */
export const PENDING_UPLOAD_NOTE = 'Прошлая загрузка этого ролика на YouTube могла дойти — проверьте канал, прежде чем выкладывать вручную.';

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

  /**
   * Загрузка — только когда режим не «вручную», клиент OAuth есть и канал подключён;
   * иначе набор. Набор при живой сессии загрузки ролика — с предупреждением: прошлая
   * загрузка могла дойти, и ручная выкладка дала бы дубль.
   */
  async uploadPlan(shortId: string): Promise<YoutubePlan> {
    const mode = (await this.settings.get()).youtubeMode;
    let note: string | null;
    if (mode === 'manual') {
      note = null;
    } else if (!youtubeOAuthConfig()) {
      note = 'YouTube не настроен на сервере — набор вместо загрузки.';
    } else {
      const acc = await this.account();
      if (acc?.status === 'connected') return { kind: 'upload', privacy: mode };
      note = acc
        ? 'Доступ к каналу YouTube пропал — набор вместо загрузки. Переподключить: /youtube'
        : 'Канал YouTube не подключён — набор вместо загрузки. Подключить: /youtube';
    }
    if (await this.session(shortId)) note = [note, PENDING_UPLOAD_NOTE].filter(Boolean).join(' ');
    return { kind: 'kit', note };
  }

  /**
   * Загрузить ролик (спека, «Публикация»). Порядок: свежий access-токен (доступа нет —
   * YoutubeAuthError, с признаком живой сессии), вопрос о прошлой сессии, новая загрузка.
   * Новая загрузка начинается, только когда YouTube подтвердил, что прошлая не дошла:
   * не догружена (incomplete) или кончилась отказом (failed). Истёкшая сессия (gone) —
   * YoutubeUploadExpired: спросить не у кого, вслепую не грузим. Ответа нет —
   * YoutubeMaybeUploaded, адрес сессии остаётся для следующей попытки.
   */
  async upload(v: ShortVideo, privacy: 'unlisted' | 'public', keepAlive: () => Promise<boolean>): Promise<{ videoId: string; url: string }> {
    const yt = v.captions?.youtube;
    if (!v.videoKey || !yt) throw new YoutubeNotUploaded('у ролика нет файла или подписей YouTube');
    const cfg = youtubeOAuthConfig();
    if (!cfg) throw new YoutubeNotUploaded('YouTube не настроен на сервере');
    const acc = await this.account();
    const previous = await this.session(v.id);
    if (!acc || acc.status !== 'connected') throw new YoutubeAuthError('канал YouTube не подключён', !!previous);
    let accessToken: string;
    let video: Buffer;
    try {
      accessToken = await this.accessToken(cfg, acc, !!previous);
      video = await this.storage.download({ bucket: shortsBucket(), key: v.videoKey });
    } catch (e: any) {
      // Прошлая загрузка ещё не проверена — сказать «ролика нет» нельзя (спека, «Публикация», п. 7).
      if (previous && !(e instanceof YoutubeAuthError)) {
        throw new YoutubeMaybeUploaded(`прошлая загрузка не проверена: ${clip(String(e?.message ?? e), 200)}`);
      }
      throw e;
    }

    if (previous) {
      // Нет ответа — YoutubeMaybeUploaded наверх, адрес остаётся.
      const st = await checkUpload(this.http, previous, accessToken, video.length);
      if (st.state === 'complete') return this.done(v.id, st.videoId);
      // Истекла: адрес не стираем — повтор снова получит 404 и снова пришлёт набор, а не загрузит вслепую.
      if (st.state === 'gone') throw new YoutubeUploadExpired('YouTube уже не помнит прошлую загрузку этого ролика');
      // incomplete или failed — прошлая загрузка не дошла: грузим заново.
      await this.setSession(v.id, null);
    }

    const meta: UploadMeta = {
      title: yt.title,
      description: yt.description,
      tags: yt.tags ?? [],
      categoryId: YOUTUBE_CATEGORY_ID,
      language: v.lang || 'ru',
      privacy,
    };
    const sessionUrl = await startUpload(this.http, accessToken, meta, video.length);
    await this.setSession(v.id, sessionUrl);
    if (!(await keepAlive())) throw new YoutubeNotUploaded('ролик ушёл из publishing до отправки файла — не отправляю');
    try {
      return await this.done(v.id, await sendFile(this.http, sessionUrl, accessToken, video));
    } catch (e: any) {
      if (e instanceof YoutubeNotUploaded) {
        // Явный отказ — итог сессии: на повторе она повторила бы его, спрашивать незачем.
        await this.setSession(v.id, null);
        throw e;
      }
      if (!(e instanceof YoutubeMaybeUploaded)) throw e;
      // Снова без ответа — YoutubeMaybeUploaded наверх, адрес остаётся.
      const st = await checkUpload(this.http, sessionUrl, accessToken, video.length);
      if (st.state === 'complete') return this.done(v.id, st.videoId);
      if (st.state === 'gone') throw new YoutubeUploadExpired('YouTube уже не помнит загрузку этого ролика');
      await this.setSession(v.id, null);
      if (st.state === 'failed') throw new YoutubeNotUploaded(`отправка файла: ${st.reason}`, st.status);
      throw new YoutubeNotUploaded(`файл не дошёл до YouTube (${e.message})`);
    }
  }

  /** Свежий access-токен. Доступа нет — аккаунт отозван с причиной и YoutubeAuthError (pending — у ролика жива сессия). */
  private async accessToken(cfg: YoutubeOAuthConfig, acc: YoutubeAccount, pending: boolean): Promise<string> {
    let refreshToken: string;
    try {
      refreshToken = decryptSecret(acc.refreshTokenEnc);
    } catch {
      await this.revoke('токен не расшифровался — сменился CALENDAR_SECRET_KEY?');
      throw new YoutubeAuthError('токен канала не расшифровался — переподключите: /youtube', pending);
    }
    try {
      return await refreshAccessToken(this.http, cfg, refreshToken);
    } catch (e: any) {
      if (!(e instanceof YoutubeAuthError)) throw e;
      await this.revoke(e.message);
      throw new YoutubeAuthError(e.message, pending);
    }
  }

  /** После записи published: ссылка владельцу; при «по ссылке» — подсказка про «публично». Набор молчит: строки published нет. */
  async notifyUploaded(shortId: string): Promise<void> {
    try {
      const r = await this.pg.query(
        `SELECT url FROM short_publication WHERE short_id = $1 AND platform = 'youtube' AND status = 'published'`,
        [shortId],
      );
      const url = r.rows[0]?.url;
      if (!url) return;
      const mode = (await this.settings.get()).youtubeMode;
      const hint = mode === 'unlisted' ? '\nЕсли ролик открывается и не стал приватным — /youtube публично.' : '';
      await this.say(approverChatId(), `Вышло на YouTube (${MODE_WORDS[mode]}): ${url}${hint}`);
    } catch (e: any) {
      this.logger.warn(`ролик ${shortId}: сообщение о YouTube не отправлено: ${e?.message ?? e}`);
    }
  }

  /** Ролик на YouTube: стереть адрес сессии. Сбой стирания успех не отменяет. */
  private async done(shortId: string, videoId: string): Promise<{ videoId: string; url: string }> {
    await this.setSession(shortId, null).catch((e: any) => this.logger.warn(`ролик ${shortId}: адрес сессии не стёрт: ${e?.message ?? e}`));
    return { videoId, url: `https://youtube.com/shorts/${videoId}` };
  }

  private async session(shortId: string): Promise<string | null> {
    const r = await this.pg.query(`SELECT upload_session FROM short_publication WHERE short_id = $1 AND platform = 'youtube'`, [shortId]);
    return r.rows[0]?.upload_session ?? null;
  }

  private async setSession(shortId: string, url: string | null): Promise<void> {
    await this.pg.query(
      `UPDATE short_publication SET upload_session = $2, updated_at = now() WHERE short_id = $1 AND platform = 'youtube'`,
      [shortId, url],
    );
  }

  private async revoke(reason: string): Promise<void> {
    await this.pg.query(
      `UPDATE short_youtube_account SET status = 'revoked', last_error = $1, updated_at = now() WHERE id = 1`,
      [clip(reason, 300)],
    );
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
