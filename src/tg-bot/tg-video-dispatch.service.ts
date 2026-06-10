import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import axios from 'axios';
import { PgService } from '../common/services/pg.service';
import { TgGrammyClient } from './tg-grammy.client';

// Видео из Kling/Veo доступно по временной ссылке; качаем сразу как только
// статус ready. Telegram Bot API лимитит загрузку 50МБ — для коротких клипов
// (5-10с) хватает с запасом.
const MAX_VIDEO_BYTES = 49 * 1024 * 1024;
const POLL_INTERVAL_MS = 5_000;
const BATCH_SIZE = 10;

@Injectable()
export class TgVideoDispatchService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TgVideoDispatchService.name);
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;

  constructor(
    private readonly pg: PgService,
    private readonly grammy: TgGrammyClient,
  ) {}

  onModuleInit() {
    // setInterval совпадает по ритму с VideoService.tick — типичная задержка
    // от 'ready' в БД до доставки в TG 0-5 секунд.
    this.timer = setInterval(() => {
      if (this.inFlight) return; // не накладываемся, если предыдущий tick ещё идёт
      this.inFlight = true;
      this.tick().catch(e => this.logger.warn(`tick failed: ${e.message}`)).finally(() => {
        this.inFlight = false;
      });
    }, POLL_INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    const r = await this.pg.query(
      `SELECT tg.job_id, tg.tg_chat_id, tg.tg_reply_to_message_id,
              vj.status, vj.video_url
         FROM tg_bot_video_jobs tg
         JOIN video_jobs vj ON vj.id = tg.job_id
        WHERE tg.delivery_status = 'pending'
          AND vj.status IN ('ready', 'failed')
        ORDER BY tg.created_at
        LIMIT $1`,
      [BATCH_SIZE],
    );
    if (r.rows.length === 0) return;
    for (const row of r.rows) {
      await this.deliver(row);
    }
  }

  private async deliver(row: {
    job_id: string;
    tg_chat_id: string;
    tg_reply_to_message_id: number | null;
    status: string;
    video_url: string | null;
  }): Promise<void> {
    const chatId = Number(row.tg_chat_id);
    const replyTo = row.tg_reply_to_message_id ?? undefined;
    try {
      if (row.status === 'failed' || !row.video_url) {
        await this.grammy.sendMessage(
          chatId,
          '⚠️ Не получилось сгенерировать видео.',
          replyTo ? { reply_to_message_id: replyTo } : {},
        );
      } else {
        await this.grammy.sendChatAction(chatId, 'upload_video').catch(() => {});
        const resp = await axios.get(row.video_url, {
          responseType: 'arraybuffer',
          timeout: 60_000,
          maxContentLength: MAX_VIDEO_BYTES,
        });
        const buf = Buffer.from(resp.data);
        await this.grammy.sendVideo(chatId, buf, replyTo ? { reply_to_message_id: replyTo } : {});
      }
      await this.pg.query(
        `UPDATE tg_bot_video_jobs SET delivery_status='sent', delivered_at=now() WHERE job_id=$1`,
        [row.job_id],
      );
      this.logger.log(`video job ${row.job_id} → chat ${chatId} (${row.status})`);
    } catch (e: any) {
      this.logger.warn(`failed to deliver video job ${row.job_id} → chat ${chatId}: ${e.message}`);
      // Помечаем failed чтобы не зацикливаться. Юзер не получает ничего; в идеале
      // бы повторить с backoff, но Kling URL временный — повтор через час бесполезен.
      await this.pg.query(
        `UPDATE tg_bot_video_jobs SET delivery_status='failed', delivery_error=$1, delivered_at=now() WHERE job_id=$2`,
        [String(e.message ?? 'unknown').slice(0, 500), row.job_id],
      );
      // Notice юзеру что не получилось
      try {
        await this.grammy.sendMessage(
          chatId,
          '⚠️ Видео сгенерировалось, но не получилось доставить — ссылка истекла.',
          replyTo ? { reply_to_message_id: replyTo } : {},
        );
      } catch { /* ignore */ }
    }
  }
}
