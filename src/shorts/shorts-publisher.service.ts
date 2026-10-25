import { Injectable, Logger } from '@nestjs/common';
import { GrammyError, InputFile } from 'grammy';
import { approverChatId } from '../blog/blog-approval.service';
import { buildPostUrl } from '../blog/blog-publisher.service';
import { PgService } from '../common/services/pg.service';
import { StorageService } from '../common/services/storage.service';
import { TgGrammyClient } from '../tg-bot/tg-grammy.client';
import { buildYoutubeKeyboard } from './short-callback';
import { STAND_MARK, clip } from './short-captions';
import { isStand } from './short-env';
import { SUPPORTED_PLATFORMS, ShortSettings, ShortsSettingsService } from './shorts-settings.service';
import { ShortPlatform, ShortPublication, ShortVideo, rowToPublication, rowToShort, shortsBucket } from './shorts.types';

/** Сколько раз ролик пробует выйти. Попытку считает захват, счётчик переживает рестарт. */
export const MAX_PUBLISH_ATTEMPTS = 3;
/**
 * Ролик в publishing, чью живость не продлевали дольше этого, — осиротевший:
 * процесс умер посреди публикации. Живость продлевается перед каждой площадкой
 * и перед самой отправкой в канал, так что порог должен покрывать один шаг —
 * выгрузку файла (таймаут grammy 500 с ≈ 8,3 мин), а не всю публикацию.
 */
export const STUCK_PUBLISHING_MINUTES = 10;

/**
 * Причина для владельца, когда исход отправки в канал неизвестен. У Telegram
 * нет ключа идемпотентности, номер поста приходит только в ответе: повтор
 * вслепую может дать второй такой же пост в публичном канале. Поэтому решает
 * человек, а «Повторить» — только если поста в канале нет: вышедший пост
 * повтор продублирует.
 */
export const POST_MAY_BE_OUT = 'пост мог выйти — проверьте канал; «Повторить» в админке — только если поста там нет';
const STUCK_TELEGRAM = `${POST_MAY_BE_OUT} (отправка оборвалась — процесс перезапущен посреди публикации)`;
const STUCK_OTHER = 'отправка оборвалась — процесс перезапущен посреди публикации';

/** Площадка своё отработала: вышла сама или ушла владельцу набором. */
const SETTLED = ['published', 'manual_pending', 'manual_done'];

interface PlatformResult {
  status: 'published' | 'manual_pending';
  externalId: string;
  url: string | null;
}

/**
 * Чем кончилась площадка:
 * - `done` — вышла, отметка записана;
 * - `skipped` — строку не захватил: площадка уже отработала;
 * - `refused` — отказ Telegram или сбой до отправки: строка `failed`, обычный повтор;
 * - `unknown` — исход отправки в канал неизвестен: строка и ролик уже в `failed`;
 * - `unrecorded` — отправка прошла, а отметка в базу не легла: ролик остаётся
 *   в `publishing`, его разберёт сторож (`rearmStuck`).
 */
type PlatformOutcome = 'done' | 'skipped' | 'refused' | 'unknown' | 'unrecorded';

/**
 * Отправка в канал началась, а ответа Telegram — ни «вышел», ни «отказ» — нет:
 * обрыв, таймаут, ответ прокси вместо Bot API. Пост мог выйти.
 */
class TelegramOutcomeUnknown extends Error {
  constructor(readonly causeMessage: string) {
    super(`${POST_MAY_BE_OUT} (ответа Telegram нет: ${causeMessage})`);
    this.name = 'TelegramOutcomeUnknown';
  }
}

/**
 * Telegram ответил отказом — поста точно нет, повтор безопасен.
 *
 * GrammyError grammy бросает, только когда Bot API вернул JSON `ok: false`
 * (`ApiClient.callApi` в grammy/out/core/client.js). Всё, что случилось в пути, —
 * сбой fetch, таймаут `timeoutSeconds`, ответ не-JSON (HTML прокси на 502), сбой
 * потока выгрузки — grammy заворачивает в HttpError (`toHttpError`): это
 * неизвестный исход. Ответ 5xx от самого Bot API тоже считаем неизвестным: сбой
 * на стороне сервера не значит, что сообщение не ушло.
 *
 * `instanceof`, а не имя класса: если в сборке окажется вторая копия grammy,
 * отказ уйдёт в «неизвестный исход» — в безопасную сторону (ручной повтор, а не
 * дубль в канале).
 */
export function isTelegramRefusal(e: unknown): boolean {
  return e instanceof GrammyError && Number(e.error_code) < 500;
}

@Injectable()
export class ShortsPublisherService {
  private readonly logger = new Logger(ShortsPublisherService.name);

  constructor(
    private readonly pg: PgService,
    private readonly tg: TgGrammyClient,
    private readonly storage: StorageService,
    private readonly settings: ShortsSettingsService,
  ) {}

  /** Одобренные человеком ролики, чей слот наступил. */
  async publishDue(): Promise<void> {
    const due = await this.pg.query(
      `SELECT id FROM short_video
        WHERE status = 'approved' AND approved_at IS NOT NULL AND slot_at <= now()
        ORDER BY slot_at LIMIT 3`,
    );
    for (const row of due.rows) {
      try {
        await this.publish(row.id);
      } catch (e: any) {
        this.logger.error(`публикация ${row.id} сорвалась: ${e.message}`);
      }
    }
  }

  /**
   * Захват `approved → publishing` атомарный: два тика или два процесса дают
   * один пост. `approved_at IS NOT NULL` — публикатор сам не выпустит ролик,
   * которого человек не одобрял, что бы ни делали с ним другие части модуля.
   *
   * Дальше — по площадкам: Telegram, затем набор YouTube (только когда Telegram
   * вышел). Перед каждой площадкой — продление живости: иначе медленная
   * выгрузка двух файлов пережила бы STUCK_PUBLISHING_MINUTES, и сторож забрал
   * бы ролик у живой отправки. Ролик ушёл из publishing — останавливаемся.
   *
   * Итог — `published`; возврат в `approved` под повтор или, когда попытки
   * кончились, `failed` с сообщением владельцу. Неизвестный исход отправки в
   * канал — сразу `failed`, без автоповтора: повтор решает владелец.
   */
  async publish(id: string): Promise<void> {
    const claim = await this.pg.query(
      `UPDATE short_video SET status = 'publishing', attempts = attempts + 1, updated_at = now()
        WHERE id = $1 AND status = 'approved' AND approved_at IS NOT NULL AND slot_at <= now()
        RETURNING *`,
      [id],
    );
    if (!claim.rows.length) return;
    const v = rowToShort(claim.rows[0]);
    const settings = await this.settings.get();
    const platforms = settings.platforms.filter((p) => SUPPORTED_PLATFORMS.includes(p));
    if (!platforms.length) {
      // Без площадок все строки «отработали» бы вхолостую, и ролик стал бы published без единого поста.
      const message =
        'публикация: в настройках роликов нет ни одной поддерживаемой площадки ' +
        `(short_settings.platforms: ${settings.platforms.join(', ') || 'пусто'}; поддерживаются ${SUPPORTED_PLATFORMS.join(', ')})`;
      this.logger.error(`ролик ${v.id}: ${message}`);
      await this.finishAttempt(v, message);
      return;
    }
    for (const p of platforms) {
      await this.pg.query(
        `INSERT INTO short_publication (short_id, platform, status) VALUES ($1, $2, 'pending')
         ON CONFLICT (short_id, platform) DO NOTHING`,
        [v.id, p],
      );
    }
    if (platforms.includes('telegram')) {
      if (!(await this.keepAlive(v.id))) return;
      const out = await this.platform(v, 'telegram', () => this.toTelegram(v, settings));
      // unknown — строка и ролик уже в failed; unrecorded — ролик разберёт сторож. Набора YouTube нет в обоих случаях.
      if (out === 'unknown' || out === 'unrecorded') return;
    }
    const telegramDone = !platforms.includes('telegram') || (await this.rows(v.id)).some((r) => r.platform === 'telegram' && r.status === 'published');
    if (platforms.includes('youtube') && telegramDone) {
      if (!(await this.keepAlive(v.id))) return;
      if ((await this.platform(v, 'youtube', () => this.youtubeKit(v))) === 'unrecorded') return;
    }
    await this.settle(v, platforms);
  }

  /**
   * Сторож: публикация, оборванная рестартом, иначе висела бы вечно. Осиротевший
   * ролик — в `publishing`, живость не продлевалась дольше
   * STUCK_PUBLISHING_MINUTES. Его площадки в `publishing` — оборванные отправки:
   * - строка telegram — исход неизвестен (пост мог выйти): строка и ролик в
   *   `failed`, повтор — кнопкой владельца, а не по кругу в канал;
   * - прочие (набор YouTube в личку — дубль безвреден): строка `failed`, ролик
   *   в `approved` под повтор, а исчерпав попытки — в `failed`. Без предела
   *   ролик, на котором процесс умирает, ходил бы по кругу бесконечно.
   *
   * Один запрос — одна транзакция: строка telegram в `failed` не может остаться
   * при ролике в `approved` (это и был бы автоповтор). `FOR UPDATE` в выборке
   * зависших: продление живости живой отправки, пришедшее одновременно, либо
   * дождётся сторожа и увидит, что ролик ушёл из publishing, либо успеет первым,
   * и тогда сторож этот ролик не тронет.
   */
  async rearmStuck(): Promise<void> {
    const r = await this.pg.query(
      `WITH stuck AS (
         SELECT id FROM short_video
          WHERE status = 'publishing' AND updated_at < now() - make_interval(mins => $1)
          FOR UPDATE
       ),
       cut AS (
         UPDATE short_publication
            SET status = 'failed', last_error = CASE WHEN platform = 'telegram' THEN $2::text ELSE $3::text END,
                updated_at = now()
          WHERE status = 'publishing' AND short_id IN (SELECT id FROM stuck)
          RETURNING short_id, platform
       ),
       verdict AS (
         SELECT s.id, EXISTS (SELECT 1 FROM cut c WHERE c.short_id = s.id AND c.platform = 'telegram') AS unknown
           FROM stuck s
       )
       UPDATE short_video v
          SET status = CASE WHEN d.unknown OR v.attempts >= $4 THEN 'failed' ELSE 'approved' END,
              failed_from = CASE WHEN d.unknown OR v.attempts >= $4 THEN 'publishing' ELSE v.failed_from END,
              failure_notified = CASE WHEN d.unknown OR v.attempts >= $4 THEN false ELSE v.failure_notified END,
              last_error = CASE
                WHEN d.unknown THEN 'публикация: telegram: ' || $2::text
                WHEN v.attempts >= $4 THEN 'публикация оборвалась, попыток было ' || v.attempts || ' — процесс перезапускался посреди отправки'
                ELSE 'публикация оборвалась — процесс перезапущен посреди отправки; ролик вернулся в очередь'
              END,
              updated_at = now()
         FROM verdict d
        WHERE v.id = d.id AND v.status = 'publishing'
        RETURNING v.id, v.status`,
      [STUCK_PUBLISHING_MINUTES, STUCK_TELEGRAM, STUCK_OTHER, MAX_PUBLISH_ATTEMPTS],
    );
    for (const row of r.rows) {
      this.logger.warn(`ролик ${row.id}: публикация оборвалась — ${row.status === 'failed' ? 'в failed, повтор за владельцем' : 'вернул в approved'}`);
    }
  }

  /**
   * Продлить живость ролика: сторож считает осиротевшим ролик, чей updated_at
   * старше STUCK_PUBLISHING_MINUTES. false — ролик уже не в publishing (забрал
   * сторож или перевели вручную): дальше слать нельзя.
   */
  private async keepAlive(id: string): Promise<boolean> {
    const r = await this.pg.query(
      `UPDATE short_video SET updated_at = now() WHERE id = $1 AND status = 'publishing' RETURNING 1`,
      [id],
    );
    if (r.rows.length) return true;
    this.logger.warn(`ролик ${id} ушёл из publishing посреди публикации — останавливаюсь`);
    return false;
  }

  /** Площадка: захват строки (только pending/failed), отправка, отметка вместе с номером поста. */
  private async platform(v: ShortVideo, platform: ShortPlatform, send: () => Promise<PlatformResult>): Promise<PlatformOutcome> {
    const claim = await this.pg.query(
      `UPDATE short_publication SET status = 'publishing', attempts = attempts + 1, updated_at = now()
        WHERE short_id = $1 AND platform = $2 AND status IN ('pending', 'failed')
        RETURNING *`,
      [v.id, platform],
    );
    if (!claim.rows.length) return 'skipped';
    let out: PlatformResult;
    try {
      out = await send();
    } catch (e: any) {
      const message = String(e?.message ?? e).slice(0, 500);
      if (e instanceof TelegramOutcomeUnknown) {
        this.logger.error(`ролик ${v.id}, ${platform}: исход отправки неизвестен, автоповтора не будет — ${e.causeMessage}`);
        // Строка и ролик — одним запросом: строка failed при ролике в publishing
        // сторож вернул бы в approved, и повтор ушёл бы в канал сам.
        await this.pg.query(
          `WITH pub AS (
             UPDATE short_publication SET status = 'failed', last_error = $3, updated_at = now()
              WHERE short_id = $1 AND platform = $2 AND status = 'publishing'
           )
           UPDATE short_video SET status = 'failed', failed_from = 'publishing', last_error = $4,
                  failure_notified = false, updated_at = now()
            WHERE id = $1 AND status = 'publishing'`,
          [v.id, platform, message, `публикация: ${platform}: ${message}`.slice(0, 1000)],
        );
        return 'unknown';
      }
      this.logger.error(`ролик ${v.id}, ${platform}: ${e?.message ?? e}`);
      await this.pg.query(
        `UPDATE short_publication SET status = 'failed', last_error = $3, updated_at = now()
          WHERE short_id = $1 AND platform = $2 AND status = 'publishing'`,
        [v.id, platform, message],
      );
      return 'refused';
    }
    return (await this.recordSent(v, platform, out)) ? 'done' : 'unrecorded';
  }

  /**
   * Отметка успеха — вне try отправки: пост вышел, и строку `failed` (а с ней
   * автоповтор и дубль) после этого не ставит никакой сбой записи.
   *
   * Условие — «площадка ещё не отработала», а не только `publishing`: если сторож
   * успел счесть долгую отправку оборванной (`failed`) или владелец уже нажал
   * «Повторить» (`pending`), правда о вышедшем посте важнее — иначе следующий
   * повтор его продублирует.
   */
  private async recordSent(v: ShortVideo, platform: ShortPlatform, out: PlatformResult): Promise<boolean> {
    const sent = out.url ?? `сообщение ${out.externalId}`;
    try {
      const r = await this.pg.query(
        `UPDATE short_publication
            SET status = $3, external_id = $4, url = $5, last_error = NULL,
                published_at = CASE WHEN $3 = 'published' THEN now() ELSE published_at END, updated_at = now()
          WHERE short_id = $1 AND platform = $2 AND status IN ('pending', 'publishing', 'failed')`,
        [v.id, platform, out.status, out.externalId, out.url],
      );
      if (r.rowCount) return true;
      this.logger.error(`ролик ${v.id}, ${platform}: отправлено (${sent}), а в базе не отмечено — строка площадки уже отработала; повторно не отправляю`);
    } catch (e: any) {
      this.logger.error(`ролик ${v.id}, ${platform}: отправлено (${sent}), а отметка в базу упала: ${e?.message ?? e}; повторно не отправляю, ролик разберёт сторож`);
    }
    return false;
  }

  /** Telegram-канал: тот же бот, что у блога, видео байтами с обложкой и подписью до 1000 знаков. */
  private async toTelegram(v: ShortVideo, s: ShortSettings): Promise<PlatformResult> {
    if (!s.tgChannelChatId) throw new Error('канал Telegram не настроен (short_settings.tg_channel_chat_id)');
    if (!v.videoKey || !v.coverKey || !v.captions) throw new Error('у ролика нет файла, обложки или подписей');
    const bucket = shortsBucket();
    const [video, cover] = await Promise.all([
      this.storage.download({ bucket, key: v.videoKey }),
      this.storage.download({ bucket, key: v.coverKey }),
    ]);
    const options = {
      caption: v.captions.telegram,
      // cover (Bot API 8.3): thumbnail Telegram принимает только до 320 px и 200 КБ, кадр 1080×1920 он молча выбросил бы.
      cover: new InputFile(cover, 'cover.jpg'),
      supports_streaming: true,
      width: 1080,
      height: 1920,
      ...(v.durationMs ? { duration: Math.round(v.durationMs / 1000) } : {}),
    };
    // Перед необратимым шагом: ролик ещё наш (скачивание могло затянуться), и живости хватит на всю выгрузку.
    if (!(await this.keepAlive(v.id))) throw new Error('ролик ушёл из publishing до отправки в канал — не отправляю');
    let msg: any;
    try {
      msg = await this.tg.sendVideo(Number(s.tgChannelChatId), video, options);
    } catch (e: any) {
      if (isTelegramRefusal(e)) throw e;
      throw new TelegramOutcomeUnknown(String(e?.message ?? e));
    }
    // Пост уже вышел: отсюда ничего не должно бросать, иначе сбой засчитался бы отказом и ушёл в повтор.
    const messageId = Number(msg?.message_id);
    return {
      status: 'published',
      externalId: String(messageId),
      url: buildPostUrl({ id: Number(msg?.chat?.id ?? s.tgChannelChatId), username: msg?.chat?.username }, messageId),
    };
  }

  /**
   * YouTube, пока Google не проверил приложение: владельцу — файл документом
   * (без пережатия), заголовок, описание, теги и кнопка «Выложил на YouTube».
   * Повторяется как обычно: дубль набора в личке безвреден.
   */
  private async youtubeKit(v: ShortVideo): Promise<PlatformResult> {
    const chatId = approverChatId();
    if (!chatId) throw new Error('BLOG_APPROVER_TG_ID не задан — набор для YouTube отправить некому');
    if (!v.videoKey || !v.captions) throw new Error('у ролика нет файла или подписей');
    const video = await this.storage.download({ bucket: shortsBucket(), key: v.videoKey });
    const mark = isStand() ? STAND_MARK : '';
    const yt = v.captions.youtube;
    await this.tg.sendDocument(chatId, video, `linkeon-${v.slug ?? v.id}.mp4`, {
      caption: clip(`${mark}Набор для YouTube Shorts — файл ролика${v.title ? ` «${v.title}»` : ''}.`, 1000),
    });
    const msg: any = await this.tg.sendMessage(
      chatId,
      `${mark}YouTube — заголовок:\n${yt.title}\n\nОписание:\n${yt.description}\n\nТеги: ${yt.tags.join(', ')}\n\n` +
        'Когда выложите, нажмите кнопку и пришлите ссылку ответом.',
      { reply_markup: buildYoutubeKeyboard(v.id) },
    );
    return { status: 'manual_pending', externalId: String(msg.message_id), url: null };
  }

  private async settle(v: ShortVideo, platforms: ShortPlatform[]): Promise<void> {
    const rows = (await this.rows(v.id)).filter((r) => platforms.includes(r.platform));
    if (rows.length && rows.every((r) => SETTLED.includes(r.status))) {
      await this.pg.query(
        `UPDATE short_video SET status = 'published', published_at = now(), last_error = NULL, updated_at = now()
          WHERE id = $1 AND status = 'publishing'`,
        [v.id],
      );
      this.logger.log(`ролик ${v.id} опубликован`);
      return;
    }
    const problems = rows
      .filter((r) => !SETTLED.includes(r.status))
      .map((r) => `${r.platform}: ${r.lastError ?? r.status}`)
      .join('; ');
    await this.finishAttempt(v, `публикация: ${problems || 'строк площадок нет'}`);
  }

  /** Попытка не удалась: назад в `approved` под повтор или, когда попытки кончились, `failed` с сообщением владельцу. */
  private async finishAttempt(v: ShortVideo, message: string): Promise<void> {
    const text = message.slice(0, 1000);
    if (v.attempts >= MAX_PUBLISH_ATTEMPTS) {
      await this.pg.query(
        `UPDATE short_video SET status = 'failed', failed_from = 'publishing', last_error = $2,
                failure_notified = false, updated_at = now()
          WHERE id = $1 AND status = 'publishing'`,
        [v.id, text],
      );
    } else {
      // Тот же slot_at: строка та же, индекс одного ролика на слот её пропустит.
      await this.pg.query(
        `UPDATE short_video SET status = 'approved', last_error = $2, updated_at = now()
          WHERE id = $1 AND status = 'publishing'`,
        [v.id, text],
      );
    }
  }

  private async rows(id: string): Promise<ShortPublication[]> {
    const r = await this.pg.query(`SELECT * FROM short_publication WHERE short_id = $1`, [id]);
    return r.rows.map(rowToPublication);
  }
}
