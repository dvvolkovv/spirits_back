import { Injectable, Logger } from '@nestjs/common';
import { approverChatId } from '../blog/blog-approval.service';
import { inTransaction } from '../blog/blog-slot-claim';
import { decryptSecret, encryptSecret } from '../calendar/crypto';
import { PgService } from '../common/services/pg.service';
import { StorageService } from '../common/services/storage.service';
import { TgGrammyClient } from '../tg-bot/tg-grammy.client';
import { STAND_MARK, youtubeSafe } from './short-captions';
import { isStand, shortsEnabled } from './short-env';
import { downloadShortFile } from './short-files';
import { ShortsSettingsService } from './shorts-settings.service';
import { ShortVideo, YoutubeMode } from './shorts.types';
import {
  YoutubeAttemptSuperseded, YoutubeAuthError, YoutubeCodeRejected, YoutubeMaybeUploaded, YoutubeNotUploaded, YoutubeUploadExpired,
} from './youtube/youtube-errors';
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

  /** Ссылка на вход для владельца; null — на этой среде не настроен клиент OAuth (id, секрет или PUBLIC_BASE_URL). */
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
        this.logger.log(`YouTube: режим ${cmd.mode} — командой владельца`);
        await this.say(chatId, await this.modeChanged(cmd.mode, chatId));
      } else {
        await this.say(chatId, await this.statusText(chatId));
      }
    } catch (e: any) {
      const reason = clip(String(e?.message ?? e), 300);
      this.logger.error(`команда /youtube не выполнена: ${reason}`);
      await this.say(chatId, `YouTube: не получилось — ${reason}`);
    }
    return true;
  }

  /** Адрес возврата Google: проверить state, обменять код, запомнить канал, сказать владельцу. */
  async completeConnect(q: { code?: string; state?: string; error?: string }): Promise<ConnectPage> {
    const cfg = youtubeOAuthConfig();
    if (!cfg) return connectPage(503, 'YouTube не настроен', 'На этом сервере не настроен клиент OAuth YouTube: нужны YOUTUBE_OAUTH_CLIENT_ID, YOUTUBE_OAUTH_CLIENT_SECRET и PUBLIC_BASE_URL.');
    if (q.error) {
      // До verifyState — сюда попадёт и чужой анонимный запрос; коды Google — [a-z_],
      // перевод строки или прочий мусор в значении чистим, чтобы не исказить соседние строки лога.
      this.logger.warn(`YouTube: вход в Google не завершён (error=${clip(q.error.replace(/[^\w.-]/g, '?'), 100)})`);
      return connectPage(200, 'Подключение отменено', 'Канал не подключён. Чтобы попробовать снова, пришлите боту /youtube.');
    }
    const st = verifyState(cfg.clientSecret, cfg.redirectUri, q.state);
    const owner = approverChatId();
    if (!st || !owner || st.chatId !== owner) {
      return connectPage(400, 'Ссылка устарела', 'Пришлите боту /youtube и откройте новую ссылку.');
    }
    if (!q.code) return connectPage(400, 'Нет кода от Google', 'Пришлите боту /youtube и попробуйте ещё раз.');
    if ((process.env.CALENDAR_SECRET_KEY || '').length < 32) {
      // Код Google одноразовый: потратить его на exchangeCode, не умея сохранить refresh-токен
      // этим же ключом (accessToken() проверяет его так же при обновлении), — сжечь код впустую.
      const reason = 'на сервере нет CALENDAR_SECRET_KEY — канал не подключить';
      this.logger.error(`YouTube: ${reason}`);
      void this.say(st.chatId, `YouTube не подключён: ${reason}`);
      return connectPage(503, 'YouTube не настроен', `${reason}. Напишите администратору.`);
    }
    let tokens: { accessToken: string; refreshToken: string; scope: string };
    try {
      tokens = await exchangeCode(this.http, cfg, q.code);
    } catch (e: any) {
      if (e instanceof YoutubeCodeRejected) {
        // Код Google одноразовый: чаще всего браузер повторил адрес возврата. Страница перед глазами — в Telegram не пишем.
        const acc = await this.account().catch((): YoutubeAccount | null => null);
        if (acc?.status === 'connected' && acc.connectedAt && Date.now() - acc.connectedAt.getTime() < RECONNECT_GRACE_MS) {
          return connectPage(200, 'Канал уже подключён', `Канал «${acc.channelTitle ?? acc.channelId}» подключён. Вкладку можно закрыть.`);
        }
        this.logger.warn('YouTube: Google отверг код входа, недавнего подключения нет — страница «Ссылка устарела»');
        return connectPage(400, 'Ссылка устарела', 'Код Google уже использован или устарел. Пришлите боту /youtube и откройте новую ссылку.');
      }
      return this.connectFailed(st.chatId, e);
    }
    try {
      const ch = await fetchMyChannel(this.http, tokens.accessToken);
      // Канал роликов закреплён в .env: другой — по ошибке или по чужой ссылке — не подключится.
      const expected = (process.env.YOUTUBE_CHANNEL_ID || '').trim();
      if (expected && ch.id !== expected) {
        throw new Error(`выбран канал «${ch.title}» (${ch.id}), а роликам нужен ${expected} — войдите снова и выберите канал Linkeon`);
      }
      // Шифруем до транзакции: внутри нужны только запросы к базе, не сторонние вычисления.
      const tokenEnc = encryptSecret(tokens.refreshToken);
      // Аккаунт и режим — одной транзакцией: сбой второго запроса откатывает и первый,
      // а не оставляет канал записанным в базе при странице 502 владельцу.
      const mode: YoutubeMode = await inTransaction(this.pg, async (tx) => {
        await tx.query(
          `INSERT INTO short_youtube_account
                  (id, channel_id, channel_title, refresh_token_enc, scopes, status, last_error, connected_at, updated_at)
           VALUES (1, $1, $2, $3, $4, 'connected', NULL, now(), now())
           ON CONFLICT (id) DO UPDATE
              SET channel_id = EXCLUDED.channel_id, channel_title = EXCLUDED.channel_title,
                  refresh_token_enc = EXCLUDED.refresh_token_enc, scopes = EXCLUDED.scopes,
                  status = 'connected', last_error = NULL, connected_at = now(), updated_at = now()`,
          [ch.id, ch.title, tokenEnc, tokens.scope],
        );
        // Подключение при «вручную» включает «по ссылке»: первый ролик — проверка (спека, «Сценарий владельца»).
        // Канал хранится только в short_youtube_account; short_settings.youtube_channel_id не трогаем — одна правда.
        const r = await tx.query(
          `UPDATE short_settings
              SET youtube_mode = CASE WHEN youtube_mode = 'manual' THEN 'unlisted' ELSE youtube_mode END,
                  updated_at = now()
            WHERE id = 1
            RETURNING youtube_mode`,
        );
        return r.rows[0]?.youtube_mode ?? 'unlisted';
      });
      this.logger.log(`YouTube подключён: канал ${ch.id} «${ch.title}», режим ${mode}`);
      const handle = ch.handle ? ` (${ch.handle})` : '';
      const check =
        mode === 'unlisted'
          ? ' Проверьте первый ролик: если открывается по ссылке и не стал приватным — /youtube публично (сам он останется по ссылке — доступ меняется в YouTube Studio).'
          : '';
      const off = shortsEnabled() ? '' : ' Конвейер роликов на этом сервере пока выключен (SHORTS_ENABLED) — загрузка начнётся, когда его включат.';
      // Страницу не держим ради Telegram: say() не бросает, а ждать его ответа браузеру незачем.
      void this.say(st.chatId, `YouTube подключён: канал «${ch.title}»${handle}. Ролики будут загружаться сами, режим — ${MODE_WORDS[mode]}.${check}${off}`);
      return connectPage(200, 'Канал подключён', `Канал «${ch.title}» подключён к роликам Linkeon. Вкладку можно закрыть — подтверждение придёт в Telegram.`);
    } catch (e: any) {
      return this.connectFailed(st.chatId, e);
    }
  }

  /** Подключение сорвалось по настоящей причине: в лог, владельцу в Telegram (не ждём) и страница 502. */
  private connectFailed(chatId: number, e: any): ConnectPage {
    const reason = clip(String(e?.message ?? e), 300);
    this.logger.error(`подключение YouTube не удалось: ${reason}`);
    void this.say(chatId, `YouTube не подключён: ${reason}`);
    return connectPage(502, 'Не получилось подключить канал', `${reason}. Пришлите боту /youtube и попробуйте ещё раз.`);
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
      if (acc?.status === 'connected') {
        // Канал закреплён в .env, но подключали его раньше: пин могли задать
        // или сменить позже — без этой проверки ролик ушёл бы в канал из базы.
        const mismatch = this.channelMismatch(acc);
        if (!mismatch) return { kind: 'upload', privacy: mode };
        note = `${mismatch.charAt(0).toUpperCase()}${mismatch.slice(1)} — набор вместо загрузки. Переподключить: /youtube`;
      } else {
        note = acc
          ? 'Доступ к каналу YouTube пропал — набор вместо загрузки. Переподключить: /youtube'
          : 'Канал YouTube не подключён — набор вместо загрузки. Подключить: /youtube';
      }
    }
    let pending: boolean;
    try {
      pending = !!(await this.session(shortId));
    } catch (e: any) {
      if (e?.code === '42703' && String(e?.message ?? '').includes('upload_session')) {
        // Нет именно этой колонки — миграция 003 не накатилась: загрузок не было, предупреждать
        // не о чем. 42703 про другую колонку (например, если запрос когда-нибудь пополнят новым
        // условием) — не наш случай: безопасная сторона здесь, как при любой непонятной ошибке, — else.
        this.logger.error('YouTube: нет колонки upload_session — миграция 003 не накатилась; набор без предупреждения о прошлой загрузке');
        pending = false;
      } else {
        // Не смогли прочитать адрес — не знаем, была ли загрузка: предупреждаем в безопасную сторону.
        this.logger.warn(`ролик ${shortId}: адрес сессии YouTube не прочитан: ${e?.message ?? e}`);
        pending = true;
      }
    }
    if (pending) note = [note, PENDING_UPLOAD_NOTE].filter(Boolean).join('\n');
    return { kind: 'kit', note };
  }

  /**
   * Загрузить ролик (спека, «Публикация»). Порядок: свежий access-токен (доступа нет —
   * YoutubeAuthError, с признаком живой сессии), вопрос о прошлой сессии, новая загрузка.
   * Новая загрузка начинается, только когда YouTube подтвердил, что прошлая не дошла:
   * не догружена (incomplete) или кончилась отказом (failed). Истёкшая сессия (gone) —
   * YoutubeUploadExpired: спросить не у кого, вслепую не грузим. Ответа нет —
   * YoutubeMaybeUploaded, адрес сессии остаётся для следующей попытки.
   *
   * fence — жетон строки YouTube (см. platform() в shorts-publisher.service.ts): адрес сессии
   * читается и пишется, только пока строку держит эта попытка, иначе YoutubeAttemptSuperseded.
   * keepAlive вызывается перед отправкой файла: вернул false — слать файл нельзя
   * (YoutubeAttemptSuperseded), свой адрес сессии остаётся для следующей попытки.
   */
  async upload(
    v: ShortVideo,
    privacy: 'unlisted' | 'public',
    keepAlive: () => Promise<boolean>,
    fence: number,
  ): Promise<{ videoId: string; url: string; resumed: boolean }> {
    const yt = v.captions?.youtube;
    if (!v.videoKey || !yt) throw new YoutubeNotUploaded('у ролика нет файла или подписей YouTube');
    const cfg = youtubeOAuthConfig();
    if (!cfg) throw new YoutubeNotUploaded('YouTube не настроен на сервере');
    let acc: YoutubeAccount | null;
    let previous: string | null;
    try {
      acc = await this.account();
      previous = await this.ownSession(v.id, fence);
    } catch (e: any) {
      if (e instanceof YoutubeAttemptSuperseded) throw e;
      // Не знаем, жива ли прошлая загрузка, — «ролика нет» сказать нельзя.
      throw new YoutubeMaybeUploaded(`не прочитал состояние загрузки: ${clip(String(e?.message ?? e), 200)}`);
    }
    if (!acc || acc.status !== 'connected') throw new YoutubeAuthError('канал YouTube не подключён', !!previous);
    let accessToken: string;
    let video: Buffer;
    try {
      accessToken = await this.accessToken(cfg, acc, !!previous);
      video = await downloadShortFile(this.storage, v.videoKey);
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
      if (st.state === 'complete') return this.done(v.id, st.videoId, true);
      // Истекла: адрес не стираем — повтор снова получит 404 и снова пришлёт набор, а не загрузит вслепую.
      if (st.state === 'gone') throw new YoutubeUploadExpired('YouTube уже не помнит прошлую загрузку этого ролика');
      // incomplete или failed — прошлая загрузка не дошла: грузим заново. Строка уже не наша — YoutubeAttemptSuperseded.
      await this.clearSession(v.id, previous, fence);
    }

    const meta: UploadMeta = {
      // YouTube отверг бы < и > (400) — заменяем на ёлочки; теги чистит tidyTags при сборке подписей.
      title: youtubeSafe(yt.title),
      description: youtubeSafe(yt.description),
      tags: yt.tags ?? [],
      categoryId: YOUTUBE_CATEGORY_ID,
      language: v.lang || 'ru',
      privacy,
    };
    const sessionUrl = await startUpload(this.http, accessToken, meta, video.length);
    // С жетоном адрес в «нашу» строку может положить только эта попытка: провал значит, что строка
    // уже не наша, и её исход — дело новой попытки. Сессия без байтов ролика не создаёт.
    if (!(await this.claimSession(v.id, sessionUrl, fence))) throw new YoutubeAttemptSuperseded('строку YouTube захватила другая попытка — файл не шлю');
    if (!(await keepAlive())) {
      throw new YoutubeAttemptSuperseded(
        'перед отправкой файла живость не продлена: ролик или строку YouTube забрала другая попытка либо продление шло слишком долго — не отправляю',
      );
    }
    try {
      return this.done(v.id, await sendFile(this.http, sessionUrl, accessToken, video), false);
    } catch (e: any) {
      if (e instanceof YoutubeNotUploaded) {
        // Явный отказ — итог сессии: на повторе она повторила бы его, спрашивать незачем.
        await this.clearSession(v.id, sessionUrl, fence);
        throw e;
      }
      if (!(e instanceof YoutubeMaybeUploaded)) throw e;
      // Снова без ответа — YoutubeMaybeUploaded наверх, адрес остаётся.
      const st = await checkUpload(this.http, sessionUrl, accessToken, video.length);
      if (st.state === 'complete') return this.done(v.id, st.videoId, false);
      if (st.state === 'gone') throw new YoutubeUploadExpired('YouTube уже не помнит загрузку этого ролика');
      await this.clearSession(v.id, sessionUrl, fence);
      if (st.state === 'failed') throw new YoutubeNotUploaded(`отправка файла: ${st.reason}`, st.status);
      throw new YoutubeNotUploaded(`файл не дошёл до YouTube (${e.message})`);
    }
  }

  /** Свежий access-токен. Доступа нет — это подключение отозвано с причиной и YoutubeAuthError (pending — у ролика жива сессия). */
  private async accessToken(cfg: YoutubeOAuthConfig, acc: YoutubeAccount, pending: boolean): Promise<string> {
    if ((process.env.CALENDAR_SECRET_KEY || '').length < 32) {
      // Ошибка настройки сервера, а не отозванный доступ: подключение не трогаем.
      throw new YoutubeNotUploaded('на сервере нет CALENDAR_SECRET_KEY — токен канала не расшифровать');
    }
    let refreshToken: string;
    try {
      refreshToken = decryptSecret(acc.refreshTokenEnc);
    } catch {
      await this.revoke('токен не расшифровался — сменился CALENDAR_SECRET_KEY?', acc.refreshTokenEnc);
      throw new YoutubeAuthError('токен канала не расшифровался', pending);
    }
    try {
      return await refreshAccessToken(this.http, cfg, refreshToken);
    } catch (e: any) {
      if (!(e instanceof YoutubeAuthError)) throw e;
      await this.revoke(e.message, acc.refreshTokenEnc);
      throw new YoutubeAuthError(e.message, pending);
    }
  }

  /**
   * После записи published: ссылка владельцу; доступ — тот, с которым грузили; при «по ссылке» —
   * подсказка про «публично» и оговорка, что сам этот ролик так и останется по ссылке.
   */
  async notifyUploaded(shortId: string, privacy: 'unlisted' | 'public' | null): Promise<void> {
    try {
      const r = await this.pg.query(
        `SELECT url FROM short_publication WHERE short_id = $1 AND platform = 'youtube' AND status = 'published'`,
        [shortId],
      );
      const url = r.rows[0]?.url;
      if (!url) return;
      const word = privacy ? ` (${MODE_WORDS[privacy]})` : '';
      const hint =
        privacy === 'unlisted'
          ? '\nЕсли ролик открывается и не стал приватным — /youtube публично. Сам этот ролик останется по ссылке — его доступ меняется в YouTube Studio.'
          : '';
      await this.say(approverChatId(), `Вышло на YouTube${word}: ${url}${hint}`);
    } catch (e: any) {
      this.logger.warn(`ролик ${shortId}: сообщение о YouTube не отправлено: ${e?.message ?? e}`);
    }
  }

  /**
   * Ролик на YouTube. Адрес сессии здесь не стираем: его стирает публикатор тем же запросом,
   * что пишет published (recordSent). Сотри его раньше — сбой той записи вернул бы ролик в
   * очередь без адреса, и повтор загрузил бы ролик второй раз. resumed — ролик нашёлся по
   * прошлой сессии: его доступ — от прошлой попытки.
   */
  private done(shortId: string, videoId: string, resumed: boolean): { videoId: string; url: string; resumed: boolean } {
    this.logger.log(`ролик ${shortId}: на YouTube ${videoId}${resumed ? ', нашёлся по прошлой сессии' : ''}`);
    return { videoId, url: `https://youtube.com/shorts/${videoId}`, resumed };
  }

  /** Адрес сессии ролика — только чтение (план публикации). Загрузка читает его через ownSession, с жетоном. */
  private async session(shortId: string): Promise<string | null> {
    const r = await this.pg.query(`SELECT upload_session FROM short_publication WHERE short_id = $1 AND platform = 'youtube'`, [shortId]);
    return r.rows[0]?.upload_session ?? null;
  }

  /** Адрес сессии ролика — только пока строку YouTube держит эта попытка (жетон); иначе YoutubeAttemptSuperseded. */
  private async ownSession(shortId: string, fence: number): Promise<string | null> {
    const r = await this.pg.query(
      `SELECT upload_session, status, attempts FROM short_publication WHERE short_id = $1 AND platform = 'youtube'`,
      [shortId],
    );
    const row = r.rows[0];
    if (!row || row.status !== 'publishing' || Number(row.attempts) !== fence) {
      throw new YoutubeAttemptSuperseded(
        `строку YouTube держит другая попытка (жетон ${fence}, в строке ${row ? `${row.status}, попытка ${row.attempts}` : 'строки нет'})`,
      );
    }
    return row.upload_session ?? null;
  }

  /**
   * Адрес новой сессии — в строку площадки, только если строку держит эта попытка
   * (publishing и её жетон) и другой незавершённой загрузки в ней нет. false — строка
   * уже не наша: сторож вернул ролик в очередь, пока эта попытка висела, и строку
   * захватила новая. Файл тогда не отправляем.
   */
  private async claimSession(shortId: string, url: string, fence: number): Promise<boolean> {
    const r = await this.pg.query(
      `UPDATE short_publication SET upload_session = $2, updated_at = now()
        WHERE short_id = $1 AND platform = 'youtube' AND status = 'publishing' AND attempts = $3 AND upload_session IS NULL`,
      [shortId, url, fence],
    );
    return r.rowCount === 1;
  }

  /**
   * Стереть адрес — только свой и только пока строку держит эта попытка: адрес другой
   * попытки не трогаем. Ничего не стёрто — строка уже не наша: YoutubeAttemptSuperseded.
   */
  private async clearSession(shortId: string, url: string, fence: number): Promise<void> {
    const r = await this.pg.query(
      `UPDATE short_publication SET upload_session = NULL, updated_at = now()
        WHERE short_id = $1 AND platform = 'youtube' AND upload_session = $2 AND status = 'publishing' AND attempts = $3`,
      [shortId, url, fence],
    );
    if (r.rowCount === 0) throw new YoutubeAttemptSuperseded('адрес сессии уже не мой — строку держит другая попытка');
  }

  /** Отозвать — только то подключение, токен которого не сработал: переподключение посреди загрузки не трогаем. */
  private async revoke(reason: string, tokenEnc: string): Promise<void> {
    const r = await this.pg.query(
      `UPDATE short_youtube_account SET status = 'revoked', last_error = $1, updated_at = now()
        WHERE id = 1 AND refresh_token_enc = $2`,
      [clip(reason, 300), tokenEnc],
    );
    if (r.rowCount) {
      this.logger.warn(`YouTube: подключение отозвано — ${reason}`);
    } else {
      this.logger.warn(`YouTube: токен не сработал (${reason}), но канал уже переподключён — не трогаю`);
    }
  }

  private async statusText(chatId: number): Promise<string> {
    const link = this.connectUrl(chatId);
    if (!link) return 'YouTube не настроен на этом сервере: нужны YOUTUBE_OAUTH_CLIENT_ID, YOUTUBE_OAUTH_CLIENT_SECRET и PUBLIC_BASE_URL в .env.';
    const [acc, s] = await Promise.all([this.account(), this.settings.get()]);
    const howTo =
      'Подключить: откройте ссылку (действует 15 минут), войдите в Google и выберите канал Linkeon. ' +
      `На экране «Google не проверил это приложение» нажмите «Дополнительно» → «Перейти».\n${link}`;
    if (!acc) return `YouTube: канал не подключён — ролики идут набором.\n\n${howTo}`;
    const name = `«${acc.channelTitle ?? acc.channelId}»`;
    if (acc.status === 'revoked') {
      return `YouTube: доступ к каналу ${name} пропал${acc.lastError ? ` (${acc.lastError})` : ''} — ролики идут набором.\n\n${howTo}`;
    }
    const mismatch = this.channelMismatch(acc);
    if (mismatch) return `YouTube: ${mismatch} — ролики идут набором.\n\n${howTo}`;
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
    const mismatch = acc?.status === 'connected' ? this.channelMismatch(acc) : null;
    if (acc?.status === 'connected' && !mismatch) {
      // Режим — для новых загрузок: доступ уже загруженных роликов YouTube сам не меняет.
      return mode === 'public' ? `${done} Уже загруженные «по ссылке» так и останутся по ссылке — их доступ меняется в YouTube Studio.` : done;
    }
    const link = this.connectUrl(chatId);
    if (!link) return `${done} Но YouTube не настроен на этом сервере, поэтому пока набор.`;
    const why = mismatch ?? (acc ? 'доступ к каналу пропал' : 'канал не подключён');
    return `${done} Но ${why}, поэтому пока набор.\n\nПодключить (ссылка действует 15 минут):\n${link}`;
  }

  /**
   * Канал закреплён в YOUTUBE_CHANNEL_ID — подключённый (связка в базе рабочая,
   * токен не отозван), но не тот, не должен считаться исправным: иначе статус,
   * смена режима и план загрузки молча работали бы с чужим каналом. null —
   * пин не задан или совпал.
   */
  private channelMismatch(acc: YoutubeAccount): string | null {
    const expected = (process.env.YOUTUBE_CHANNEL_ID || '').trim();
    if (!expected || acc.channelId === expected) return null;
    return `подключён канал «${acc.channelTitle ?? acc.channelId}», а роликам нужен ${expected} (YOUTUBE_CHANNEL_ID)`;
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
