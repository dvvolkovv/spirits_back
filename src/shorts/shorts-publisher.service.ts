import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { GrammyError, InputFile } from 'grammy';
import { performance } from 'perf_hooks';
import { approverChatId } from '../blog/blog-approval.service';
import { buildPostUrl } from '../blog/blog-publisher.service';
import { PgService } from '../common/services/pg.service';
import { StorageService } from '../common/services/storage.service';
import { TgGrammyClient } from '../tg-bot/tg-grammy.client';
import { buildYoutubeKeyboard } from './short-callback';
import { STAND_MARK, clip, youtubeSafe } from './short-captions';
import { isStand, shortsEnabled } from './short-env';
import { downloadShortFile } from './short-files';
import { SUPPORTED_PLATFORMS, ShortSettings, ShortsSettingsService } from './shorts-settings.service';
import { PENDING_UPLOAD_NOTE, ShortsYoutubeService } from './shorts-youtube.service';
import { ShortPlatform, ShortPublication, ShortVideo, rowToPublication, rowToShort } from './shorts.types';
import { YoutubeAttemptSuperseded, YoutubeAuthError, YoutubeMaybeUploaded, YoutubeUploadExpired } from './youtube/youtube-errors';

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
 * Предел задержки ответа на продление живости перед отправкой (keepAliveFenced). От продления
 * до конца отправки должно уложиться в порог сторожа (STUCK_PUBLISHING_MINUTES, 10 мин): файл в
 * канал, файл и подпись набора идут до 500 с каждая — таймаут grammy по умолчанию (timeoutSeconds в
 * ApiClientOptions; TgGrammyClient создаёт Bot без своих опций), файл на YouTube — до 8 мин
 * (SEND_TIMEOUT_MS). С минутой задержки ответа обе отправки всё ещё короче 10 мин. Продление,
 * чей ответ шёл дольше, — без отправки: сторож мог бы вернуть ролик в очередь посреди неё, и
 * новая попытка отправила бы ролик второй раз.
 *
 * Подпись набора — не всегда одна отправка: `TgGrammyClient.sendMessage` режет текст длиннее
 * 4096 знаков на несколько вызовов, а описание YouTube — до YT_DESCRIPTION_MAX (5000,
 * short-captions.ts) знаков, так что граница в 10 минут здесь не гарантирована. Почти всегда
 * безвредно: запись набора всё равно идёт с жетоном строки и чужую, захваченную новой попыткой,
 * не перепишет. Если за это время владелец сам включил загрузку, ролик на YouTube уйдёт сам, а
 * запоздалый набор всё равно придёт в личку — но для этого подписи нужно больше 4096 знаков,
 * что почти недостижимо.
 */
export const KEEPALIVE_MAX_LAG_MS = 60_000;

/**
 * Причина для владельца, когда исход отправки в канал неизвестен. У Telegram
 * нет ключа идемпотентности, номер поста приходит только в ответе: повтор
 * вслепую может дать второй такой же пост в публичном канале. Поэтому решает
 * человек: вышедший пост отмечается `mark_published` (дальше публикация идёт
 * сама), а `retry` — только если поста в канале нет, иначе он его продублирует.
 * Действия названы по API admin/shorts: вкладки «Ролики» в кабинете пока нет.
 */
export const POST_MAY_BE_OUT = 'пост мог выйти — проверьте канал; если пост вышел — mark_published со ссылкой на пост, иначе retry';
const STUCK_TELEGRAM = `${POST_MAY_BE_OUT} (отправка оборвалась — процесс перезапущен посреди публикации)`;
const STUCK_OTHER = 'отправка оборвалась — процесс перезапущен посреди публикации';

/**
 * Причина для владельца, когда на последней попытке YouTube не ответил, дошла ли загрузка,
 * или ответ был неоднозначен (403 без явного лимита, непонятный Range — см. checkUpload).
 * Набора нет — ручная выкладка дала бы дубль. Повтор безопасен: перед новой загрузкой сервис
 * YouTube спрашивает о сохранённой сессии (upload_session); если YouTube её уже не помнит
 * (срок сессии не опубликован), придёт набор с просьбой проверить канал.
 *
 * Если сессия стабильно отвечает неоднозначно (например, её привязали к каналу, который
 * переподключили другим аккаунтом), retry раз за разом возвращается в то же самое: без
 * подсказки в тексте ролик ходил бы по кругу бесконечно. Выход дописан в текст: сменить
 * режим на «вручную», повторить (придёт набор с предупреждением проверить канал), затем
 * вернуть режим; либо переподключить канал прежним аккаунтом. Дописан ДО места, куда
 * toYoutube() подставляет причину (e.message) в скобках — `${YOUTUBE_MAY_BE_OUT} (${e.message})`,
 * — так срез last_error до 500 знаков, который делает platform(), в худшем случае режет хвост
 * причины, а не эту подсказку (она раньше в строке).
 */
export const YOUTUBE_MAY_BE_OUT =
  'YouTube не ответил, дошла ли загрузка; retry безопасен — перед новой загрузкой спрошу YouTube о прошлой, а если он её уже не помнит, пришлю набор с просьбой проверить канал. ' +
  'Если повтор упрётся в то же: /youtube вручную, затем retry — придёт набор с предупреждением проверить канал; потом верните режим.';

/** Площадка своё отработала: вышла сама или ушла владельцу набором. */
const SETTLED = ['published', 'manual_pending', 'manual_done'];

interface PlatformResult {
  status: 'published' | 'manual_pending';
  externalId: string;
  url: string | null;
  /** Доступ, с которым ролик загружен на YouTube; у набора и Telegram его нет; null — ролик нашёлся по прошлой сессии (доступ неизвестен). */
  privacy?: 'unlisted' | 'public' | null;
}

/**
 * Чем кончилась площадка:
 * - `done` — вышла, отметка записана;
 * - `skipped` — строку не захватил: площадка уже отработала;
 * - `refused` — отказ Telegram или сбой до отправки: строка `failed`, обычный
 *   повтор; или отказ попытки YouTube, в том числе «исход неизвестен» до
 *   последней попытки: строка `failed`, повтор спросит YouTube о прошлой сессии;
 *   или попытка проиграла (YoutubeAttemptSuperseded), а строка ещё её — отдана
 *   как отказ (см. platform());
 * - `unknown` — исход отправки в канал неизвестен: строка и ролик уже в `failed`;
 * - `unrecorded` — отправка прошла, а отметка в базу не легла: ролик остаётся
 *   в `publishing`, его разберёт сторож (`rearmStuck`);
 * - `superseded` — строку держит другая попытка или сторож: ничего не записано,
 *   выходим молча (см. platform()).
 */
type PlatformOutcome = 'done' | 'skipped' | 'refused' | 'unknown' | 'unrecorded' | 'superseded';

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
export class ShortsPublisherService implements OnModuleInit {
  private readonly logger = new Logger(ShortsPublisherService.name);

  constructor(
    private readonly pg: PgService,
    private readonly tg: TgGrammyClient,
    private readonly storage: StorageService,
    private readonly settings: ShortsSettingsService,
    // Последним и @Optional: спеки собирают публикатор позиционно. Без сервиса — набор,
    // как до автопубликации; что Nest его подставляет, сторожит shorts.module.spec.ts.
    @Optional() private readonly youtube?: ShortsYoutubeService,
  ) {}

  /**
   * Разрыв связки с YouTube — как у TgBotService (tg-bot.youtube-routing.spec.ts): без сервиса
   * набор всё равно уходит, но без проверки живой сессии прошлой загрузки и без её
   * предупреждения (uploadPlan тут вовсе не вызывается) — тихий откат к режиму до автопубликации.
   */
  onModuleInit(): void {
    if (!this.youtube && shortsEnabled()) {
      this.logger.warn('ролики: ShortsYoutubeService не подставлен — YouTube только набором, без проверки прошлой загрузки');
    }
  }

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
   * Дальше — по площадкам: Telegram, затем YouTube — загрузкой или набором
   * (только когда Telegram вышел). Перед каждой площадкой — продление живости:
   * иначе медленная выгрузка двух файлов пережила бы STUCK_PUBLISHING_MINUTES,
   * и сторож забрал бы ролик у живой отправки. Ролик ушёл из publishing — останавливаемся.
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
      if (!(await this.keepAlive(v))) return;
      const out = await this.platform(v, 'telegram', (fence) => this.toTelegram(v, settings, fence));
      // unknown — строка и ролик уже в failed; unrecorded — ролик разберёт сторож; superseded — строку держит
      // другая попытка или сторож. Набора YouTube нет во всех трёх случаях.
      if (out === 'unknown' || out === 'unrecorded' || out === 'superseded') return;
    }
    const telegramDone = !platforms.includes('telegram') || (await this.rows(v.id)).some((r) => r.platform === 'telegram' && r.status === 'published');
    let uploaded: { privacy: 'unlisted' | 'public' | null } | null = null;
    if (platforms.includes('youtube') && telegramDone) {
      if (!(await this.keepAlive(v))) return;
      const out = await this.platform(v, 'youtube', async (fence) => {
        const r = await this.toYoutube(v, fence);
        uploaded = r.status === 'published' ? { privacy: r.privacy ?? null } : null;
        return r;
      });
      if (out === 'unrecorded' || out === 'superseded') return;
      if (out !== 'done') uploaded = null;
    }
    await this.settle(v, platforms);
    // Ссылку владельцу — после записи и итога ролика, не задерживая публикацию (notifyUploaded не бросает);
    // только для загрузки и с тем доступом, с которым грузили. Набор — без сообщения.
    if (uploaded) void this.youtube?.notifyUploaded(v.id, uploaded.privacy);
  }

  /**
   * Сторож: публикация, оборванная рестартом, иначе висела бы вечно. Осиротевший
   * ролик — в `publishing`, живость не продлевалась дольше
   * STUCK_PUBLISHING_MINUTES. Его площадки в `publishing` — оборванные отправки:
   * - строка telegram — исход неизвестен (пост мог выйти): строка и ролик в
   *   `failed`, повтор — кнопкой владельца, а не по кругу в канал;
   * - прочие: набор YouTube в личку — дубль безвреден; загрузка YouTube перед
   *   повтором спрашивает YouTube о прошлой сессии (upload_session) — дубля на
   *   канале нет. Строка failed, ролик в `approved` под повтор, а исчерпав
   *   попытки — в `failed`. Без предела ролик, на котором процесс умирает,
   *   ходил бы по кругу бесконечно.
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
   * Продлить живость ролика: сторож считает осиротевшим ролик, чей updated_at старше
   * STUCK_PUBLISHING_MINUTES. С жетоном ролика (см. platform()): false — ролик уже не у этой
   * попытки, дальше слать нельзя.
   */
  private async keepAlive(v: ShortVideo): Promise<boolean> {
    const r = await this.pg.query(
      `UPDATE short_video SET updated_at = now() WHERE id = $1 AND status = 'publishing' AND attempts = $2 RETURNING 1`,
      [v.id, v.attempts],
    );
    if (r.rows.length) return true;
    this.logger.warn(`ролик ${v.id} ушёл из publishing посреди публикации или его взяла новая попытка — останавливаюсь`);
    return false;
  }

  /**
   * Перед отправкой — файла в канал, файла на YouTube, набора: ролик и строка площадки всё ещё у
   * этой попытки (оба жетона — см. platform()). Продлено, но ответ шёл дольше KEEPALIVE_MAX_LAG_MS, —
   * тоже false: продление легло в базу в начале ожидания, и до порога сторожа не хватит запаса на
   * отправку. Время — по монотонным часам: перевод системных часов замер не исказит.
   */
  private async keepAliveFenced(v: ShortVideo, platform: ShortPlatform, fence: number): Promise<boolean> {
    const asked = performance.now();
    const r = await this.pg.query(
      `UPDATE short_video SET updated_at = now()
        WHERE id = $1 AND status = 'publishing' AND attempts = $2
          AND EXISTS (SELECT 1 FROM short_publication
                       WHERE short_id = $1 AND platform = $3 AND status = 'publishing' AND attempts = $4)
        RETURNING 1`,
      [v.id, v.attempts, platform, fence],
    );
    if (!r.rows.length) {
      this.logger.warn(`ролик ${v.id}, ${platform}: ролик или строку забрала другая попытка — останавливаюсь`);
      return false;
    }
    const lag = performance.now() - asked;
    if (lag > KEEPALIVE_MAX_LAG_MS) {
      this.logger.warn(
        `ролик ${v.id}, ${platform}: продление живости заняло ${Math.round(lag / 1000)} с (предел ${KEEPALIVE_MAX_LAG_MS / 1000} с) — ` +
          'до порога сторожа не хватит запаса на отправку, не отправляю',
      );
      return false;
    }
    return true;
  }

  /**
   * Площадка: захват строки (только pending/failed), отправка, отметка вместе с номером поста.
   *
   * Жетон попытки — значения attempts из захватов: строки площадки (fence; его получает send) и
   * ролика (v.attempts, захват в publish()). Попытка, зависшая дольше порога сторожа, пока ролик
   * и строку взяла новая, по жетонам видит, что они уже не её:
   * - отправки — файл в канал, файл на YouTube, набор — охраняет жетон строки: перед каждой
   *   keepAliveFenced сверяет оба жетона, а сессию загрузки сервис YouTube читает и пишет только
   *   с жетоном строки;
   * - записи — отказ, «исход неизвестен», набор (manual_pending), живость, итог ролика — идут с
   *   условием на свой жетон и в чужое не попадают (исход superseded). Свою строку проигравшая
   *   попытка отдаёт как отказ (refused), а итог ролика пишется, только если ролик тоже её.
   * Без жетона — только отметка вышедшего (published в recordSent): правда о вышедшем важнее.
   *
   * Жетон строки монотонен: счётчик строки растёт только при захвате, и retry его не обнуляет
   * (бюджет попыток — счётчик ролика). Жетон ролика обнуляют retry и mark_published
   * (shorts.controller.ts) и leave (shorts-approval.service.ts; после leave ролик вернётся в
   * публикацию только через пересъёмку и новое одобрение). Совпадение жетона ролика у зависшей и
   * новой попытки даёт лишь продление живости или запись итога ролика, но не повторную
   * отправку: отправки охраняет жетон строки. Зависшая попытка, прошедшая эти проверки по ролику,
   * может и сама захватить освободившуюся строку площадки (захват смотрит только на статус, не на
   * то, кто её держал) и отправить свой снимок ролика — это одна отправка, без дубля, но, если
   * тем временем было leave (пересъёмка), это будет отправка уже прежней версии ролика.
   */
  private async platform(v: ShortVideo, platform: ShortPlatform, send: (fence: number) => Promise<PlatformResult>): Promise<PlatformOutcome> {
    const claim = await this.pg.query(
      `UPDATE short_publication SET status = 'publishing', attempts = attempts + 1, updated_at = now()
        WHERE short_id = $1 AND platform = $2 AND status IN ('pending', 'failed')
        RETURNING *`,
      [v.id, platform],
    );
    if (!claim.rows.length) return 'skipped';
    const fence = Number(claim.rows[0].attempts);
    let out: PlatformResult;
    try {
      out = await send(fence);
    } catch (e: any) {
      const message = String(e?.message ?? e).slice(0, 500);
      if (e instanceof YoutubeAttemptSuperseded) {
        // Ни файла, ни набора. Свою строку (жетон ещё совпадает) отдаём как отказ: иначе она застряла
        // бы в publishing — сторож разбирает только ролики в publishing, а retry сбрасывает только
        // failed. Дальше settle: итог ролика с его жетоном пройдёт, только если ролик тоже наш (так
        // при медленном продлении — ролик сразу вернётся в очередь с этой причиной, без сторожа).
        // Адрес сессии не трогаем: своя строка проигрывает только до отправки (продление перед ней),
        // и следующая попытка спросит YouTube об адресе без байтов. Чужую строку жетон не пустит.
        const r = await this.pg.query(
          `UPDATE short_publication SET status = 'failed', last_error = $3, updated_at = now()
            WHERE short_id = $1 AND platform = $2 AND status = 'publishing' AND attempts = $4`,
          [v.id, platform, message, fence],
        );
        if (r.rowCount) {
          this.logger.warn(`ролик ${v.id}, ${platform}: свою строку отдал: ${message}`);
          return 'refused';
        }
        this.logger.warn(`ролик ${v.id}, ${platform}: строку держит другая попытка — ничего не пишу (${message})`);
        return 'superseded';
      }
      if (e instanceof TelegramOutcomeUnknown) {
        // Строка и ролик — одним запросом: строка failed при ролике в publishing
        // сторож вернул бы в approved, и повтор ушёл бы в канал сам. Оба — со своим
        // жетоном, ролик — только вместе со своей строкой.
        const r = await this.pg.query(
          `WITH pub AS (
             UPDATE short_publication SET status = 'failed', last_error = $3, updated_at = now()
              WHERE short_id = $1 AND platform = $2 AND status = 'publishing' AND attempts = $5
              RETURNING 1
           )
           UPDATE short_video SET status = 'failed', failed_from = 'publishing', last_error = $4,
                  failure_notified = false, updated_at = now()
            WHERE id = $1 AND status = 'publishing' AND attempts = $6 AND EXISTS (SELECT 1 FROM pub)
            RETURNING 1`,
          [v.id, platform, message, `публикация: ${platform}: ${message}`.slice(0, 1000), fence, v.attempts],
        );
        if (!r.rows.length) {
          this.logger.warn(
            `ролик ${v.id}, ${platform}: исход неизвестен, но строку или ролик уже держит другая попытка или сторож — ничего не записано (${e.causeMessage})`,
          );
          return 'superseded';
        }
        this.logger.error(`ролик ${v.id}, ${platform}: исход отправки неизвестен, автоповтора не будет — ${e.causeMessage}`);
        return 'unknown';
      }
      this.logger.error(`ролик ${v.id}, ${platform}: ${e?.message ?? e}`);
      const r = await this.pg.query(
        `UPDATE short_publication SET status = 'failed', last_error = $3, updated_at = now()
          WHERE short_id = $1 AND platform = $2 AND status = 'publishing' AND attempts = $4`,
        [v.id, platform, message, fence],
      );
      if (!r.rowCount) {
        this.logger.warn(`ролик ${v.id}, ${platform}: отказ не записан — строку держит другая попытка или сторож; выхожу`);
        return 'superseded';
      }
      return 'refused';
    }
    return (await this.recordSent(v, platform, out, fence)) ? 'done' : 'unrecorded';
  }

  /**
   * Отметка успеха — вне try отправки: пост вышел, и строку `failed` (а с ней
   * автоповтор и дубль) после этого не ставит никакой сбой записи.
   *
   * Вышедшее (published) пишем без жетона и в любую ещё не отработавшую строку: сторож мог
   * счесть долгую отправку оборванной (`failed`), владелец — нажать «Повторить» (`pending`),
   * строку могла захватить новая попытка, но правда о вышедшем посте или загруженном ролике
   * важнее — иначе следующая попытка выложила бы его снова. Набор (manual_pending) — не факт
   * на площадке: его пишем только в свою строку (жетон) или в никем не занятую (pending,
   * failed). Незаписанный набор даст лишь второй набор в личку, а записанный поверх чужой
   * загрузки — дубль на канале: та не запишет published, а владелец выложит ролик по набору.
   */
  private async recordSent(v: ShortVideo, platform: ShortPlatform, out: PlatformResult, fence: number): Promise<boolean> {
    const sent = out.url ?? `сообщение ${out.externalId}`;
    // Загрузка YouTube: адрес сессии стирается тем же запросом, что пишет published. Сотри его
    // раньше — сбой этой записи вернул бы ролик в очередь без адреса, и повтор загрузил бы ролик
    // второй раз. Telegram и набор колонку не трогают: им миграция 003 не нужна.
    const clearSession = platform === 'youtube' && out.status === 'published' ? ', upload_session = NULL' : '';
    const kit = out.status === 'manual_pending';
    const open = kit
      ? `(status IN ('pending', 'failed') OR (status = 'publishing' AND attempts = $6))`
      : `status IN ('pending', 'publishing', 'failed')`;
    const params: unknown[] = [v.id, platform, out.status, out.externalId, out.url];
    if (kit) params.push(fence);
    try {
      const r = await this.pg.query(
        `UPDATE short_publication
            SET status = $3, external_id = $4, url = $5, last_error = NULL${clearSession},
                published_at = CASE WHEN $3 = 'published' THEN now() ELSE published_at END, updated_at = now()
          WHERE short_id = $1 AND platform = $2 AND ${open}`,
        params,
      );
      if (r.rowCount) return true;
      const why = kit ? 'строку держит другая попытка или она уже отработала' : 'строка площадки уже отработала';
      this.logger.error(`ролик ${v.id}, ${platform}: отправлено (${sent}), а в базе не отмечено — ${why}; повторно не отправляю`);
    } catch (e: any) {
      this.logger.error(`ролик ${v.id}, ${platform}: отправлено (${sent}), а отметка в базу упала: ${e?.message ?? e}; повторно не отправляю, ролик разберёт сторож`);
    }
    return false;
  }

  /**
   * Telegram-канал: тот же бот, что у блога, видео байтами с обложкой и подписью до 1000 знаков.
   *
   * Готовность бота — до отправки. Без TG_BOT_TOKEN TgGrammyClient бота не
   * создаёт (onModuleInit), и sendVideo упал бы уже внутри — сбой ушёл бы в
   * «исход неизвестен», хотя поста точно нет. Обычная ошибка здесь — отказ:
   * повтор и предел попыток. `typeof` — getBot есть у клиента всегда; его нет
   * только у заглушек клиента в тестах, где бот считается поднятым.
   *
   * fence — жетон строки telegram из захвата: продление перед отправкой сверяет и его.
   */
  private async toTelegram(v: ShortVideo, s: ShortSettings, fence: number): Promise<PlatformResult> {
    if (!s.tgChannelChatId) throw new Error('канал Telegram не настроен (short_settings.tg_channel_chat_id)');
    if (typeof this.tg.getBot === 'function' && !this.tg.getBot()) throw new Error('бот Telegram не настроен — TG_BOT_TOKEN');
    if (!v.videoKey || !v.coverKey || !v.captions) throw new Error('у ролика нет файла, обложки или подписей');
    const [video, cover] = await Promise.all([downloadShortFile(this.storage, v.videoKey), downloadShortFile(this.storage, v.coverKey)]);
    const options = {
      caption: v.captions.telegram,
      // cover (Bot API 8.3): thumbnail Telegram принимает только до 320 px и 200 КБ, кадр 1080×1920 он молча выбросил бы.
      cover: new InputFile(cover, 'cover.jpg'),
      supports_streaming: true,
      width: 1080,
      height: 1920,
      ...(v.durationMs ? { duration: Math.round(v.durationMs / 1000) } : {}),
    };
    // Перед необратимым шагом: ролик и строка ещё наши (скачивание могло затянуться), и живости хватит на всю
    // выгрузку. Обычная ошибка — отказ с жетоном: своя строка уйдёт в обычный повтор, чужую он не тронет.
    if (!(await this.keepAliveFenced(v, 'telegram', fence))) {
      throw new Error('ролик или строку Telegram забрала другая попытка либо продление шло слишком долго — не отправляю');
    }
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
   * YouTube: загрузка, когда владелец подключил канал и выбрал режим, иначе набор.
   * Набор вместо загрузки — и когда доступ пропал, и когда YouTube отказал на
   * последней попытке: ролик доходит до канала хотя бы руками. Если же на
   * последней попытке неизвестно, дошла ли загрузка, набора нет (дал бы дубль):
   * отказ с YOUTUBE_MAY_BE_OUT, ролик уходит в failed.
   *
   * fence — жетон строки YouTube из захвата (см. platform()): с ним идут и загрузка, и набор.
   */
  private async toYoutube(v: ShortVideo, fence: number): Promise<PlatformResult> {
    const yt = this.youtube;
    if (!yt) return this.youtubeKit(v, null, fence);
    const plan = await yt.uploadPlan(v.id);
    if (plan.kind === 'kit') return this.youtubeKit(v, plan.note, fence);
    const last = v.attempts >= MAX_PUBLISH_ATTEMPTS;
    try {
      const up = await yt.upload(v, plan.privacy, () => this.keepAliveFenced(v, 'youtube', fence), fence);
      return { status: 'published', externalId: up.videoId, url: up.url, privacy: up.resumed ? null : plan.privacy };
    } catch (e: any) {
      // Попытку сменила новая — ни набора, ни отказа: раньше веток ниже, иначе на последней попытке ушёл бы набор.
      if (e instanceof YoutubeAttemptSuperseded) throw e;
      if (e instanceof YoutubeAuthError) {
        const pending = e.pendingUpload ? `\n${PENDING_UPLOAD_NOTE}` : '';
        return this.youtubeKit(v, `Доступ к каналу YouTube пропал (${e.message}) — набор вместо загрузки. Переподключить: /youtube${pending}`, fence);
      }
      if (e instanceof YoutubeUploadExpired) {
        return this.youtubeKit(v, `${e.message} — набор вместо загрузки.\n${PENDING_UPLOAD_NOTE}`, fence);
      }
      if (e instanceof YoutubeMaybeUploaded) {
        throw new Error(last ? `${YOUTUBE_MAY_BE_OUT} (${e.message})` : `${e.message} — повторю, сначала спрошу YouTube о прошлой загрузке`);
      }
      if (last) {
        // Хвостовая точка причины Google иначе дала бы «quota.. Выложите».
        const reason = clip(String(e?.message ?? e), 300).replace(/[.\s]+$/, '');
        return this.youtubeKit(v, `Не смог загрузить на YouTube: ${reason}. Выложите вручную.`, fence);
      }
      throw e;
    }
  }

  /**
   * YouTube набором: владельцу — файл документом (без пережатия), заголовок,
   * описание, теги и кнопка «Выложил на YouTube». Заметка — почему набор
   * вместо загрузки. Повторяется как обычно: дубль набора в личке безвреден.
   *
   * Под жетоном строки (см. platform()): набор шлёт и записывает только попытка, которая
   * держит строку. Иначе проснувшаяся старая попытка прислала бы набор, пока новая грузит
   * ролик сама, — и ручная выкладка по набору дала бы дубль на канале. Отправок две — файл и
   * подпись, каждая до 500 с (таймаут grammy), поэтому продление с правилом KEEPALIVE_MAX_LAG_MS —
   * перед каждой. Не прошло перед подписью — файл уже в личке: своя строка уйдёт в повтор, и
   * следующая попытка пришлёт набор заново (второй файл безвреден), чужую строку не трогаем.
   *
   * Подпись — не всегда одна из этих двух отправок: при длинном описании (до YT_DESCRIPTION_MAX,
   * 5000 знаков) sendMessage сам режет текст на несколько сообщений (см. KEEPALIVE_MAX_LAG_MS) —
   * тогда граница в 10 минут не гарантирована, но запись набора всё равно идёт под жетоном строки.
   */
  private async youtubeKit(v: ShortVideo, note: string | null, fence: number): Promise<PlatformResult> {
    // Нет заметки — обычный набор (вручную без живой сессии, публикатор без сервиса YouTube), строки нет.
    // uploadPlan склеивает заметку и PENDING_UPLOAD_NOTE через \n — сырой перевод строки развёл бы
    // «YouTube набором» и «могла дойти» по разным строкам лога; · держит их в одной.
    if (note) this.logger.warn(`ролик ${v.id}: YouTube набором — ${clip(note.replace(/\s*\n+\s*/g, ' · '), 300)}`);
    const chatId = approverChatId();
    if (!chatId) throw new Error('BLOG_APPROVER_TG_ID не задан — набор для YouTube отправить некому');
    if (!v.videoKey || !v.captions) throw new Error('у ролика нет файла или подписей');
    const video = await downloadShortFile(this.storage, v.videoKey);
    if (!(await this.keepAliveFenced(v, 'youtube', fence))) {
      throw new YoutubeAttemptSuperseded('набор не шлю: ролик или строку YouTube забрала другая попытка либо продление шло слишком долго');
    }
    const mark = isStand() ? STAND_MARK : '';
    const yt = v.captions.youtube;
    await this.tg.sendDocument(chatId, video, `linkeon-${v.slug ?? v.id}.mp4`, {
      caption: clip(`${mark}Набор для YouTube Shorts — файл ролика${v.title ? ` «${v.title}»` : ''}.`, 1000),
    });
    if (!(await this.keepAliveFenced(v, 'youtube', fence))) {
      throw new YoutubeAttemptSuperseded('набор: файл ушёл, подпись не шлю — ролик или строку YouTube забрала другая попытка либо продление шло слишком долго');
    }
    const msg: any = await this.tg.sendMessage(
      chatId,
      // < и > YouTube отверг бы (400) — заменяем на ёлочки; теги уже чистит tidyTags при сборке подписей.
      `${mark}${note ? `${note}\n\n` : ''}YouTube — заголовок:\n${youtubeSafe(yt.title)}\n\nОписание:\n${youtubeSafe(yt.description)}\n\n` +
        `Теги: ${yt.tags.join(', ')}\n\nКогда выложите, нажмите кнопку и пришлите ссылку ответом.`,
      { reply_markup: buildYoutubeKeyboard(v.id) },
    );
    return { status: 'manual_pending', externalId: String(msg.message_id), url: null };
  }

  private async settle(v: ShortVideo, platforms: ShortPlatform[]): Promise<void> {
    const rows = (await this.rows(v.id)).filter((r) => platforms.includes(r.platform));
    if (rows.length && rows.every((r) => SETTLED.includes(r.status))) {
      await this.pg.query(
        `UPDATE short_video SET status = 'published', published_at = now(), last_error = NULL, updated_at = now()
          WHERE id = $1 AND status = 'publishing' AND attempts = $2`,
        [v.id, v.attempts],
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

  /**
   * Попытка не удалась: назад в `approved` под повтор или, когда попытки кончились, `failed` с сообщением владельцу.
   * С жетоном ролика: ролик, который уже держит новая попытка, старая не возвращает в очередь посреди её отправки.
   */
  private async finishAttempt(v: ShortVideo, message: string): Promise<void> {
    const text = message.slice(0, 1000);
    if (v.attempts >= MAX_PUBLISH_ATTEMPTS) {
      await this.pg.query(
        `UPDATE short_video SET status = 'failed', failed_from = 'publishing', last_error = $2,
                failure_notified = false, updated_at = now()
          WHERE id = $1 AND status = 'publishing' AND attempts = $3`,
        [v.id, text, v.attempts],
      );
    } else {
      // Тот же slot_at: строка та же, индекс одного ролика на слот её пропустит.
      await this.pg.query(
        `UPDATE short_video SET status = 'approved', last_error = $2, updated_at = now()
          WHERE id = $1 AND status = 'publishing' AND attempts = $3`,
        [v.id, text, v.attempts],
      );
    }
  }

  private async rows(id: string): Promise<ShortPublication[]> {
    const r = await this.pg.query(`SELECT * FROM short_publication WHERE short_id = $1`, [id]);
    return r.rows.map(rowToPublication);
  }
}
