import { Injectable, Logger } from '@nestjs/common';
import { InputFile } from 'grammy';
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
/** Отправка ролика — секунды; ролик в publishing дольше — осиротевший: процесс умер посреди публикации. */
export const STUCK_PUBLISHING_MINUTES = 10;

/** Площадка своё отработала: вышла сама или ушла владельцу набором. */
const SETTLED = ['published', 'manual_pending', 'manual_done'];

interface PlatformResult {
  status: 'published' | 'manual_pending';
  externalId: string;
  url: string | null;
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

  /** Одобренные ролики, чей слот наступил. */
  async publishDue(): Promise<void> {
    const due = await this.pg.query(
      `SELECT id FROM short_video WHERE status = 'approved' AND slot_at <= now() ORDER BY slot_at LIMIT 3`,
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
   * один пост. Дальше — по площадкам: Telegram, затем набор YouTube (только
   * когда Telegram вышел). Итог — `published`, возврат в `approved` под
   * повтор или, когда попытки кончились, `failed` с сообщением владельцу.
   */
  async publish(id: string): Promise<void> {
    const claim = await this.pg.query(
      `UPDATE short_video SET status = 'publishing', attempts = attempts + 1, updated_at = now()
        WHERE id = $1 AND status = 'approved' AND slot_at <= now()
        RETURNING *`,
      [id],
    );
    if (!claim.rows.length) return;
    const v = rowToShort(claim.rows[0]);
    const settings = await this.settings.get();
    const platforms = settings.platforms.filter((p) => SUPPORTED_PLATFORMS.includes(p));
    for (const p of platforms) {
      await this.pg.query(
        `INSERT INTO short_publication (short_id, platform, status) VALUES ($1, $2, 'pending')
         ON CONFLICT (short_id, platform) DO NOTHING`,
        [v.id, p],
      );
    }
    if (platforms.includes('telegram')) await this.platform(v, 'telegram', () => this.toTelegram(v, settings));
    const telegramDone = !platforms.includes('telegram') || (await this.rows(v.id)).some((r) => r.platform === 'telegram' && r.status === 'published');
    if (platforms.includes('youtube') && telegramDone) await this.platform(v, 'youtube', () => this.youtubeKit(v));
    await this.settle(v, platforms);
  }

  /**
   * Сторож: публикация, оборванная рестартом, иначе висела бы вечно. Площадка
   * в `publishing` становится `failed` и уйдёт повтором — пост в Telegram при
   * этом может выйти второй раз, если оборвался ответ, а не отправка. Блог
   * живёт с тем же риском (STUCK_PUBLISHING_MINUTES в blog.cron.ts).
   */
  async rearmStuck(): Promise<void> {
    await this.pg.query(
      `UPDATE short_publication
          SET status = 'failed', last_error = 'отправка оборвалась — процесс перезапущен посреди публикации', updated_at = now()
        WHERE status = 'publishing' AND updated_at < now() - make_interval(mins => $1)`,
      [STUCK_PUBLISHING_MINUTES],
    );
    await this.pg.query(
      `UPDATE short_video SET status = 'approved', updated_at = now()
        WHERE status = 'publishing' AND updated_at < now() - make_interval(mins => $1)`,
      [STUCK_PUBLISHING_MINUTES],
    );
  }

  /** Площадка: захват строки (только pending/failed), отправка, отметка вместе с номером поста. */
  private async platform(v: ShortVideo, platform: ShortPlatform, send: () => Promise<PlatformResult>): Promise<void> {
    const claim = await this.pg.query(
      `UPDATE short_publication SET status = 'publishing', attempts = attempts + 1, updated_at = now()
        WHERE short_id = $1 AND platform = $2 AND status IN ('pending', 'failed')
        RETURNING *`,
      [v.id, platform],
    );
    if (!claim.rows.length) return;
    try {
      const out = await send();
      await this.pg.query(
        `UPDATE short_publication
            SET status = $3, external_id = $4, url = $5, last_error = NULL,
                published_at = CASE WHEN $3 = 'published' THEN now() ELSE published_at END, updated_at = now()
          WHERE short_id = $1 AND platform = $2 AND status = 'publishing'`,
        [v.id, platform, out.status, out.externalId, out.url],
      );
    } catch (e: any) {
      this.logger.error(`ролик ${v.id}, ${platform}: ${e.message}`);
      await this.pg.query(
        `UPDATE short_publication SET status = 'failed', last_error = $3, updated_at = now()
          WHERE short_id = $1 AND platform = $2 AND status = 'publishing'`,
        [v.id, platform, String(e?.message ?? e).slice(0, 500)],
      );
    }
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
    const msg: any = await this.tg.sendVideo(Number(s.tgChannelChatId), video, {
      caption: v.captions.telegram,
      thumbnail: new InputFile(cover, 'cover.jpg'),
      supports_streaming: true,
      width: 1080,
      height: 1920,
      ...(v.durationMs ? { duration: Math.round(v.durationMs / 1000) } : {}),
    });
    const messageId = Number(msg.message_id);
    return {
      status: 'published',
      externalId: String(messageId),
      url: buildPostUrl({ id: Number(msg.chat?.id ?? s.tgChannelChatId), username: msg.chat?.username }, messageId),
    };
  }

  /**
   * YouTube, пока Google не проверил приложение: владельцу — файл документом
   * (без пережатия), заголовок, описание, теги и кнопка «Выложил на YouTube».
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
    if (rows.every((r) => SETTLED.includes(r.status))) {
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
    const message = `публикация: ${problems}`.slice(0, 1000);
    if (v.attempts >= MAX_PUBLISH_ATTEMPTS) {
      await this.pg.query(
        `UPDATE short_video SET status = 'failed', failed_from = 'publishing', last_error = $2,
                failure_notified = false, updated_at = now()
          WHERE id = $1 AND status = 'publishing'`,
        [v.id, message],
      );
    } else {
      // Тот же slot_at: строка та же, индекс одного ролика на слот её пропустит.
      await this.pg.query(
        `UPDATE short_video SET status = 'approved', last_error = $2, updated_at = now()
          WHERE id = $1 AND status = 'publishing'`,
        [v.id, message],
      );
    }
  }

  private async rows(id: string): Promise<ShortPublication[]> {
    const r = await this.pg.query(`SELECT * FROM short_publication WHERE short_id = $1`, [id]);
    return r.rows.map(rowToPublication);
  }
}
