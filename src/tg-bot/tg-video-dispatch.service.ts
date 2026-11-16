import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import axios from 'axios';
import { PgService } from '../common/services/pg.service';
import { TgGrammyClient } from './tg-grammy.client';
import { tgText, ownerTgLanguage } from './tg-i18n';

// Готовое видео качаем сразу, как только статус ready. Telegram Bot API
// лимитит загрузку 50МБ — для коротких клипов (до 10с) хватает с запасом.
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
      `SELECT tg.job_id,tg.tg_chat_id,tg.tg_reply_to_message_id,
              vj.status, vj.video_url, c.owner_user_id, tg.config_id
         FROM tg_bot_video_jobs tg
         JOIN video_jobs vj ON vj.id = tg.job_id
         JOIN tg_bot_configs c ON c.id=tg.config_id AND c.status IN ('active','silent')
         JOIN user_id u ON u.internal_id=vj.user_id AND u.state='active'
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

  private async isActiveDelivery(jobId: string): Promise<boolean> {
    const active = await this.pg.query(
      `SELECT 1 FROM tg_bot_video_jobs tg
         JOIN video_jobs vj ON vj.id=tg.job_id
         JOIN tg_bot_configs c ON c.id=tg.config_id AND c.status IN ('active','silent')
         JOIN user_id u ON u.internal_id=vj.user_id AND u.state='active'
       WHERE tg.job_id=$1 AND tg.delivery_status='pending'
       LIMIT 1`,
      [jobId],
    );
    return active.rows.length === 1;
  }

  /** Ошибка самого fence — не operational failure и не повод для fallback сообщения. */
  private async activeOrFalse(jobId: string): Promise<boolean> {
    try {
      return await this.isActiveDelivery(jobId);
    } catch {
      return false;
    }
  }

  private completionGuard(): string {
    return `tg.delivery_status IN ('pending','sending')
      AND tg.delivery_error IS DISTINCT FROM 'account_deleted'
      AND EXISTS (
        SELECT 1 FROM video_jobs vj
        JOIN tg_bot_configs c ON c.id=tg.config_id AND c.status IN ('active','silent')
        JOIN user_id u ON u.internal_id=vj.user_id AND u.state='active'
        WHERE vj.id=tg.job_id
      )`;
  }

  private async deliver(row: {
    job_id: string;
    tg_chat_id: string;
    tg_reply_to_message_id: number | null;
    status: string;
    video_url: string | null;
    owner_user_id?: string | null;
    config_id?: string | null;
  }): Promise<void> {
    const chatId = Number(row.tg_chat_id);
    // Язык — владельца бота (язык его профиля).
    const lang = await ownerTgLanguage(this.pg, row.owner_user_id);
    const replyTo = row.tg_reply_to_message_id ?? undefined;
    // Сообщение, на которое отвечаем, могли удалить за 1–3 минуты генерации —
    // тогда видео всё равно уходит, просто без ответа.
    const replyOpts = replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {};
    if (!await this.activeOrFalse(row.job_id)) return;

    if (row.status === 'failed' || !row.video_url) {
      try {
        await this.grammy.sendMessage(chatId, tgText(lang, 'video_failed'), replyOpts);
      } catch (error: any) {
        await this.handleOperationalFailure(row, error, lang, replyOpts);
        return;
      }
    } else {
      await this.grammy.sendChatAction(chatId, 'upload_video').catch(() => {});
      if (!await this.activeOrFalse(row.job_id)) return;
      let buf: Buffer;
      try {
        const resp = await axios.get(row.video_url, {
          responseType: 'arraybuffer',
          timeout: 60_000,
          maxContentLength: MAX_VIDEO_BYTES,
        });
        buf = Buffer.from(resp.data);
      } catch (error: any) {
        await this.handleOperationalFailure(row, error, lang, replyOpts);
        return;
      }
      if (!await this.activeOrFalse(row.job_id)) return;
      try {
        await this.grammy.sendVideo(chatId, buf, replyOpts);
      } catch (error: any) {
        await this.handleOperationalFailure(row, error, lang, replyOpts);
        return;
      }
    }

    await this.pg.query(
      `UPDATE tg_bot_video_jobs tg SET delivery_status='sent',delivered_at=now()
       WHERE tg.job_id=$1 AND ${this.completionGuard()}`,
      [row.job_id],
    );
    this.logger.log(`video job ${row.job_id} → chat ${chatId} (${row.status})`);
  }

  private async handleOperationalFailure(
    row: { job_id: string; tg_chat_id: string; tg_reply_to_message_id: number | null; status: string },
    error: any,
    lang: Parameters<typeof tgText>[0],
    replyOpts: Record<string, unknown>,
  ): Promise<void> {
    const chatId = Number(row.tg_chat_id);
    this.logger.warn(`failed to deliver video job ${row.job_id} → chat ${chatId}: ${error?.message}`);
    // Сюда попадают только ошибки axios/Grammy. Fence ошибки обрабатываются
    // отдельно в activeOrFalse и никогда не превращаются в video_expired.
    if (!await this.activeOrFalse(row.job_id)) return;
    try {
      await this.grammy.sendMessage(chatId, tgText(lang, 'video_expired'), replyOpts);
    } catch { /* ignore */ }
    await this.pg.query(
      `UPDATE tg_bot_video_jobs tg
       SET delivery_status='failed',delivery_error=$1,delivered_at=now()
       WHERE tg.job_id=$2 AND ${this.completionGuard()}`,
      [String(error?.message ?? 'unknown').slice(0, 500), row.job_id],
    );
  }
}
