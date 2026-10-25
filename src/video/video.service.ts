// src/video/video.service.ts
import {
  Injectable, Logger, BadRequestException, ForbiddenException,
  NotFoundException, ConflictException, OnModuleInit, OnModuleDestroy, Optional,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PgService } from '../common/services/pg.service';
import { RedisService } from '../common/services/redis.service';
import { sendTelegramAlert } from '../common/telegram-alert';
import { VeoService } from '../misc/veo.service';
import {
  CreateVideoJobDto, VideoJobRow, ComposedPlan, VideoModel,
  isVeoModel, computeVeoQuote, computeVeoConcatQuote, computeOwnVoiceSurcharge,
  needsVeoConcat, VEO_BASE_SEC, VEO_EXTEND_SEC,
} from './video.dto';
import { VoiceAvatarService } from '../voice-avatar/voice-avatar.service';
import { jobCostRefunded } from './job-refund';
import { assertFetchableMedia, fetchMediaBytes } from '../common/net/own-media';
import { isUnsafeUrlError } from '../common/net/safe-fetch';
import { S3Client, PutObjectCommand, DeleteObjectCommand, CreateBucketCommand, PutBucketPolicyCommand } from '@aws-sdk/client-s3';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export class InsufficientTokensError extends Error {
  status = 402;
  constructor(public balance: number, public required: number) {
    super('insufficient_tokens');
  }
}

@Injectable()
export class VideoService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VideoService.name);
  private readonly MAX_CONCURRENT_PER_USER = 3;

  // Хранилище ассетов видео — СВОЙ MinIO (не Yandex S3). Раньше клиент смотрел
  // на storage.yandexcloud.net с пустыми AWS_* → загрузка фото падала с
  // "X-Amz-Credential malformed" (500 → фронт "upload failed"). MinIO S3-
  // совместим: тот же S3Client с endpoint/кредами MinIO и path-style. Готовое
  // видео отдаётся отдельно из локального /static/videos; здесь — загруженные
  // пользователем фото/аудио, авто-стиллы, превью, rehost.
  private s3 = new S3Client({
    region: 'us-east-1', // MinIO игнорирует регион, но SDK его требует
    endpoint: process.env.MINIO_ENDPOINT ?? 'http://127.0.0.1:9000',
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.MINIO_ACCESS_KEY ?? '',
      secretAccessKey: process.env.MINIO_SECRET_KEY ?? '',
    },
  });
  private readonly s3Bucket = process.env.MINIO_BUCKET_VIDEOS || 'linkeon-smm-videos';

  private s3PublicUrl(key: string): string {
    const base = (process.env.MINIO_PUBLIC_URL ?? 'https://my.linkeon.io/smm-media').replace(/\/$/, '');
    return `${base}/${this.s3Bucket}/${key}`;
  }

  // Самопровизионинг бакета: на проде linkeon-smm-videos уже есть (SMM), но на
  // test/новом окружении его нет (NoSuchBucket → 500). Создаём при первой
  // загрузке; ТОЛЬКО для созданного нами ставим public-read (существующий
  // прод-бакет с его политикой не трогаем).
  private bucketReady = false;
  private async ensureBucket(): Promise<void> {
    if (this.bucketReady) return;
    try {
      await this.s3.send(new CreateBucketCommand({ Bucket: this.s3Bucket }));
      await this.s3.send(new PutBucketPolicyCommand({
        Bucket: this.s3Bucket,
        Policy: JSON.stringify({
          Version: '2012-10-17',
          Statement: [{ Effect: 'Allow', Principal: '*', Action: ['s3:GetObject'], Resource: [`arn:aws:s3:::${this.s3Bucket}/*`] }],
        }),
      }));
      this.logger.log(`Created MinIO bucket ${this.s3Bucket} (public-read)`);
    } catch (e: any) {
      const code = e?.name || e?.Code || '';
      if (!/BucketAlready/i.test(code)) this.logger.warn(`ensureBucket(${this.s3Bucket}): ${e.message}`);
    }
    this.bucketReady = true;
  }

  constructor(
    private readonly pg: PgService,
    private readonly veo: VeoService,
    private readonly voice: VoiceAvatarService,
    @Optional() private readonly redis?: RedisService,
  ) {}

  /**
   * Отказы провайдера, которые означают «кончились деньги», а не сбой рендера:
   * Google отвечает 429 с исчерпанной квотой.
   */
  private static readonly PROVIDER_OUT_OF_MONEY =
    /insufficient balance|exceeded your current quota|insufficient_quota/i;

  /** Метка «видео сломано деньгами». Без TTL: снимается только починкой. */
  private static readonly PROVIDER_BROKEN_KEY = 'video:provider-broken-since';

  /**
   * Подтвердить, что видео снова работает.
   *
   * Без этого цикл разомкнут: тревога уходит, а дальше тишина — и она читается
   * одинаково и когда починили, и когда никто ничего не сделал.
   *
   * Признак починки — успешная задача ПОСЛЕ момента тревоги. Просто «прошло
   * время» не годится: провайдер мог остаться пустым, а задач могло не быть
   * вовсе.
   *
   * Никогда не бросает и без Redis молчит: состояние «было сломано» хранить
   * негде, а выдумывать восстановление нельзя.
   */
  async checkProviderRecovered(): Promise<void> {
    try {
      if (!this.redis) return;
      const brokenSince = await this.redis.get(VideoService.PROVIDER_BROKEN_KEY);
      if (!brokenSince) return;

      const since = Number(brokenSince);
      if (!Number.isFinite(since)) {
        await this.redis.del(VideoService.PROVIDER_BROKEN_KEY);
        return;
      }

      const r = await this.pg.query(
        `SELECT count(*)::int AS n FROM video_jobs
          WHERE status = 'ready' AND updated_at > to_timestamp($1 / 1000.0)`,
        [since],
      );
      if (Number(r.rows[0]?.n ?? 0) === 0) return;

      await this.redis.del(VideoService.PROVIDER_BROKEN_KEY);
      const downMin = Math.round((Date.now() - since) / 60000);
      await sendTelegramAlert(
        `🎬✅ Видео снова работает — задача прошла целиком.\n\n` +
        `Простой длился примерно ${downMin} мин.`,
      );
    } catch (e: any) {
      this.logger.warn(`проверка восстановления видео не удалась: ${e.message}`);
    }
  }

  /**
   * Пометить, что видео сломано деньгами провайдера.
   *
   * Своего сообщения НЕ шлём: о провалах уже сообщает QualityMonitorService —
   * он с июля считает падения по balance/quota за 60 минут и пишет
   * «⚠️ КАЧЕСТВО: платный провайдер отказывает пользователям» в тот же чат.
   * Первая редакция этого метода слала второе сообщение о том же событии —
   * то есть плодила ровно ту усталость от алертов, против которой затевалась.
   *
   * Метка нужна для другого: у монитора нет понятия «починилось», и без неё
   * нечем подтвердить восстановление (см. checkProviderRecovered). Живёт без
   * TTL — снимается только фактом успешной задачи; на dedup-ключе с TTL
   * починка через сутки осталась бы без подтверждения.
   *
   * Никогда не бросает: метод прицеплен к возврату денег, и падение Redis не
   * должно этот возврат ронять.
   */
  private async noteProviderOutOfMoney(reason: string): Promise<void> {
    try {
      if (!VideoService.PROVIDER_OUT_OF_MONEY.test(String(reason))) return;
      if (!this.redis) return;
      if (await this.redis.get(VideoService.PROVIDER_BROKEN_KEY)) return;
      await this.redis.set(
        VideoService.PROVIDER_BROKEN_KEY,
        JSON.stringify({ since: Date.now(), provider: 'veo' }),
      );
      this.logger.warn(`видео сломано деньгами провайдера: ${String(reason).slice(0, 200)}`);
    } catch (e: any) {
      this.logger.warn(`не смог пометить отказ провайдера: ${e.message}`);
    }
  }

  /**
   * Разобрать метку «сломано». Старый формат — голое число, новый — JSON.
   * Метки первого дня деплоя записаны числом, и терять их нельзя: именно на них
   * держится напоминание.
   */
  private static parseBrokenMarker(raw: string): { since: number; provider: string } | null {
    const asNumber = Number(raw);
    if (Number.isFinite(asNumber) && asNumber > 0) return { since: asNumber, provider: 'unknown' };
    try {
      const o = JSON.parse(raw);
      const since = Number(o?.since);
      if (!Number.isFinite(since)) return null;
      return { since, provider: String(o?.provider ?? 'unknown') };
    } catch {
      return null;
    }
  }

  /**
   * Напоминание «видео всё ещё не работает».
   *
   * QualityMonitorService считает провалы за последние 60 минут, поэтому его
   * сигнал затухает сам, как только пользователи перестают пробовать: 13.08.2026
   * одно падение дало одно сообщение, дальше запросов не было — и неделю никто
   * не вспоминал о поломке. Это напоминание висит на метке, а не на потоке
   * задач, поэтому молчать из-за отсутствия попыток не может.
   *
   * Снимает метку только успешная задача (checkProviderRecovered): спросить
   * квоту Google напрямую нечем. Метки Kling — наследие снятого провайдера,
   * их убираем молча: напоминать о нём больше незачем.
   */
  @Cron('0 40 */12 * * *') // каждые 12 часов
  async remindProviderStillBroken(now: number = Date.now()): Promise<void> {
    try {
      if (!this.redis) return;
      const raw = await this.redis.get(VideoService.PROVIDER_BROKEN_KEY);
      if (!raw) return;

      const marker = VideoService.parseBrokenMarker(raw);
      if (!marker) {
        await this.redis.del(VideoService.PROVIDER_BROKEN_KEY);
        return;
      }

      if (marker.provider === 'kling') {
        await this.redis.del(VideoService.PROVIDER_BROKEN_KEY);
        return;
      }

      await sendTelegramAlert(
        `🎬🚨 Видео всё ещё не работает — уже ${VideoService.humanDuration(now - marker.since)}.\n\n` +
        `Провайдер: ${marker.provider}. Пока счёт не пополнен, каждая попытка падает, ` +
        `а токены возвращаются пользователю.`,
      );
    } catch (e: any) {
      this.logger.warn(`напоминание о поломке видео не удалось: ${e.message}`);
    }
  }

  private static humanDuration(ms: number): string {
    const hours = Math.round(ms / 3600_000);
    if (hours < 48) return `${hours} ч`;
    return `${Math.round(hours / 24)} дн`;
  }

  async createJob(
    userId: string,
    dto: CreateVideoJobDto,
  ): Promise<{ jobId: string; status: string; tokensSpent: number }> {
    // Единственный движок — Google (до 22.10.2026 Veo 3.1, теперь Gemini Omni
    // Flash, см. misc/veo.service.ts): text2video и image2video, длинные
    // ролики он собирает сам. Kling снят 22.10.2026 — провайдер вывел
    // kling-v1-6 из эксплуатации, пакет сгорел, а живых роликов на нём с июля
    // не было. Вместе с ним ушли режимы extend и lipsync: у Veo их нет, и
    // createVeoJob отвечает на них 400 до списания токенов.
    return this.createVeoJob(userId, { ...dto, model: dto.model ?? 'veo-3.1-fast' });
  }

  async getJob(userId: string, jobId: string): Promise<VideoJobRow> {
    const res = await this.pg.query(
      `SELECT * FROM video_jobs WHERE id=$1`,
      [jobId],
    );
    const row = res.rows[0] as VideoJobRow | undefined;
    if (!row) throw new NotFoundException('job not found');
    if (row.user_id !== userId) throw new ForbiddenException('not your job');
    return row;
  }

  async listJobs(
    userId: string,
    opts: { status?: string; limit?: number } = {},
  ): Promise<VideoJobRow[]> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const params: any[] = [userId];
    let where = `user_id=$1`;
    if (opts.status) {
      params.push(opts.status);
      where += ` AND status=$${params.length}`;
    }
    params.push(limit);
    const res = await this.pg.query(
      `SELECT * FROM video_jobs WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
      params,
    );
    return res.rows as VideoJobRow[];
  }

  async deleteJob(userId: string, jobId: string): Promise<void> {
    const row = await this.getJob(userId, jobId); // ownership enforced here
    if (row.status === 'processing' || row.status === 'pending') {
      throw new ConflictException('cannot delete active job — wait for completion');
    }
    if (row.video_url || row.thumbnail_url) {
      try {
        await this.deleteS3Objects(row.id);
      } catch (e: any) {
        this.logger.warn(`S3 cleanup failed for ${row.id}: ${e.message}`);
      }
    }
    await this.pg.query(`DELETE FROM video_jobs WHERE id=$1`, [jobId]);
  }

  private async deleteS3Objects(jobId: string): Promise<void> {
    await Promise.allSettled([
      this.s3.send(new DeleteObjectCommand({ Bucket: this.s3Bucket, Key: `videos/${jobId}.mp4` })),
      this.s3.send(new DeleteObjectCommand({ Bucket: this.s3Bucket, Key: `videos/${jobId}.jpg` })),
    ]);
  }

  // ================= POLLER =================
  private pollTimer: NodeJS.Timeout | null = null;
  private readonly POLL_INTERVAL_MS = 5000;
  private readonly JOB_TIMEOUT_MINUTES = 15;

  async onModuleInit() {
    // 002 migration — adds target_duration_sec + composed_plan for long-form
    // video. Reused for any future video schema changes. IF NOT EXISTS so it's
    // idempotent across restarts.
    const candidates = [
      path.join(__dirname, 'migrations', '002_composed_video.sql'),
      path.join(__dirname, '..', '..', 'src', 'video', 'migrations', '002_composed_video.sql'),
    ];
    for (const p of candidates) {
      try {
        if (fs.existsSync(p)) {
          await this.pg.query(fs.readFileSync(p, 'utf8'));
          this.logger.log(`video migration 002 applied from ${p}`);
          break;
        }
      } catch (e: any) {
        this.logger.error(`video migration 002 failed (${p}): ${e.message}`);
      }
    }

    // 003 — own_voice flag (видео голосом оригинала, 96cba3f7). Idempotent.
    for (const p of [
      path.join(__dirname, 'migrations', '003_own_voice.sql'),
      path.join(__dirname, '..', '..', 'src', 'video', 'migrations', '003_own_voice.sql'),
    ]) {
      try {
        if (fs.existsSync(p)) {
          await this.pg.query(fs.readFileSync(p, 'utf8'));
          this.logger.log(`video migration 003 applied from ${p}`);
          break;
        }
      } catch (e: any) {
        this.logger.error(`video migration 003 failed (${p}): ${e.message}`);
      }
    }

    // 004 — стоимость кадра-заготовки, чтобы возврат за провал мог вернуть и её.
    for (const p of [
      path.join(__dirname, 'migrations', '004_image_tokens.sql'),
      path.join(__dirname, '..', '..', 'src', 'video', 'migrations', '004_image_tokens.sql'),
    ]) {
      try {
        if (fs.existsSync(p)) {
          await this.pg.query(fs.readFileSync(p, 'utf8'));
          this.logger.log(`video migration 004 applied from ${p}`);
          break;
        }
      } catch (e: any) {
        this.logger.error(`video migration 004 failed (${p}): ${e.message}`);
      }
    }

    this.pollTimer = setInterval(
      () => this.tick().catch((e) => this.logger.error(`tick error: ${e.message}`)),
      this.POLL_INTERVAL_MS,
    );
    this.logger.log('VideoService poller started (tick=5s)');
  }

  onModuleDestroy() {
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  // Задачи, которые этот процесс опрашивает прямо сейчас. setInterval не ждёт
  // предыдущий тик, а ответ Omni на готовый шаг несёт сам ролик (мегабайты
  // base64) и потом ffmpeg — без метки следующий тик брал ту же задачу и
  // обрабатывал готовый шаг второй раз: двойная запись клипа, двойной запуск
  // следующего (платного) шага.
  private readonly polling = new Set<string>();

  private async tick() {
    await this.expireStaleJobs();
    const res = await this.pg.query(
      `SELECT * FROM video_jobs WHERE status='processing' ORDER BY updated_at ASC LIMIT 20`,
    );
    const jobs = (res.rows as VideoJobRow[]).filter((job) => !this.polling.has(job.id));
    await Promise.all(
      jobs.map(async (job) => {
        this.polling.add(job.id);
        try {
          await this.pollJob(job);
        } catch (e: any) {
          this.logger.error(`pollJob ${job.id} error: ${e.message}`);
        } finally {
          this.polling.delete(job.id);
        }
      }),
    );

    // Замыкаем цикл: если висит метка «сломано деньгами», а задачи снова
    // проходят — подтвердить починку. Без метки метод ничего не делает и в
    // базу не ходит, так что тик от этого не тяжелеет.
    await this.checkProviderRecovered();
  }

  private async expireStaleJobs() {
    // Long-form Veo jobs (a chain of segments) legitimately take longer than
    // 15 min. For them we allow 8 min per segment + 5 min for concat/upload,
    // capped at 60 min hard ceiling. Otherwise the original 15 min applies.
    // The same timeout closes (with a refund) any non-Veo job left in flight.
    const stale = await this.pg.query(
      `SELECT id, user_id, tokens_spent, composed_plan,
              CASE
                WHEN composed_plan IS NOT NULL
                  THEN LEAST(60, 5 + 8 * COALESCE((composed_plan->>'segments_total')::int, 1))
                ELSE $1::int
              END AS budget_min
       FROM video_jobs
       WHERE status='processing'
       FOR UPDATE SKIP LOCKED`,
      [this.JOB_TIMEOUT_MINUTES],
    );
    for (const row of stale.rows as Array<{ id: string; user_id: string; tokens_spent: number; budget_min: number; composed_plan: any }>) {
      const ageMinutes = await this.pg.query(
        `SELECT EXTRACT(EPOCH FROM (now() - created_at))/60 AS m FROM video_jobs WHERE id=$1`,
        [row.id],
      );
      const ageMin = Number((ageMinutes.rows[0] as any)?.m ?? 0);
      if (ageMin > row.budget_min) {
        await this.failAndRefund(row.id, row.user_id, Number(row.tokens_spent),
          `timeout (${Math.round(ageMin)} > ${row.budget_min} min)`);
      }
    }
  }

  private async pollJob(job: VideoJobRow) {
    // Задачи других движков (Kling снят) здесь не опрашиваются: если такая
    // осталась в работе, её закроет с возвратом expireStaleJobs.
    if (!isVeoModel(job.model)) return;
    await this.pollVeoJob(job);
  }

  /**
   * Пометить задачу провалившейся и вернуть за неё токены.
   *
   * Пометка идёт ПЕРВОЙ и только с `status <> 'failed'`: она же и защита от
   * повторного возврата. Поллер зовёт этот метод из нескольких мест, и без
   * условия вторая попытка вернула бы деньги ещё раз.
   *
   * Возвращаем и стоимость кадра-заготовки: text2video без картинки сначала
   * рисует кадр (отдельное списание 'image'), и при провале анимации человек
   * остаётся без ролика, но с оплаченной заготовкой.
   *
   * Стоимость ролика не возвращаем, если её уже вернули (jobCostRefunded):
   * перезапуск из поддержки возвращает списание новой задачи сразу, и её
   * провал иначе вернул бы его второй раз. Статус 'failed' ставится всё равно.
   */
  private async failAndRefund(jobId: string, userId: string, tokens: number, reason: string) {
    const client = await this.pg.getClient();
    let refunded = 0;
    try {
      await client.query('BEGIN');
      const marked = await client.query(
        `UPDATE video_jobs SET status='failed', error_message=$1, updated_at=now()
          WHERE id=$2 AND status <> 'failed'
          RETURNING image_tokens_spent`,
        [String(reason).slice(0, 500), jobId],
      );
      if (marked.rowCount === 0) {
        await client.query('ROLLBACK');
        this.logger.warn(`failAndRefund: задача ${jobId} уже провалена, возврат не повторяем`);
        return;
      }
      const stillTokens = Number(marked.rows[0]?.image_tokens_spent ?? 0);
      // Строка задачи уже под блокировкой (UPDATE выше): перезапуск, который
      // её тоже блокирует, либо уже закоммитил свой возврат, либо дождётся нас.
      const videoTokens = (await jobCostRefunded(client, userId, jobId)) ? 0 : Number(tokens);
      if (videoTokens === 0 && Number(tokens) > 0) {
        this.logger.warn(
          `failAndRefund: задача ${jobId} — перезапуск, её стоимость (${tokens}) уже вернул перезапуск; повторно не возвращаем`,
        );
      }
      refunded = videoTokens + stillTokens;
      if (refunded > 0) {
        await client.query(
          `SELECT add_user_tokens($1, $2, 'refund', $3, $4::jsonb)`,
          [userId, refunded, 'Возврат за видео',
           JSON.stringify({
             job_id: jobId, reason: String(reason).slice(0, 200),
             video_tokens: videoTokens, still_tokens: stillTokens,
           })],
        );
      }
      await client.query('COMMIT');
      // Метка «сломано деньгами» — по ней потом подтвердится починка.
      // Сообщение о самом провале шлёт QualityMonitorService, здесь молчим.
      await this.noteProviderOutOfMoney(reason);
    } catch (e: any) {
      try { await client.query('ROLLBACK'); } catch {}
      this.logger.error(`failAndRefund txn error: ${e.message}`);
    } finally {
      client.release();
    }
    this.logger.warn(`Video job ${jobId} failed, refunded ${refunded} tokens: ${reason}`);
  }

  async uploadUserAsset(
    userId: string,
    kind: 'image',
    buffer: Buffer,
    mimeType: string,
    origName: string,
  ): Promise<string> {
    // Аудио принимали только под lipsync Kling — он снят вместе с режимом.
    if (!/^image\//.test(mimeType)) throw new BadRequestException(`bad mime type for ${kind}: ${mimeType}`);
    const maxBytes = 10 * 1024 * 1024;
    if (buffer.byteLength > maxBytes) {
      throw new BadRequestException(`file too large (max ${maxBytes / 1024 / 1024} MB)`);
    }
    const extMatch = origName.match(/\.([a-z0-9]{2,5})$/i);
    const ext = extMatch ? extMatch[1].toLowerCase() : 'jpg';
    const key = `video-uploads/${userId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    await this.ensureBucket();
    await this.s3.send(new PutObjectCommand({
      Bucket: this.s3Bucket,
      Key: key,
      Body: buffer,
      ContentType: mimeType,
    }));
    return this.s3PublicUrl(key);
  }

  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async cleanupOldFailedJobs() {
    const res = await this.pg.query(
      `DELETE FROM video_jobs
       WHERE status='failed' AND created_at < now() - interval '30 days'
       RETURNING id`,
    );
    if (res.rowCount && res.rowCount > 0) {
      this.logger.log(`Cleanup: deleted ${res.rowCount} failed video jobs`);
    }
  }

  private async extractAndUploadThumbnail(jobId: string, videoUrl: string): Promise<string | null> {
    const tmpPath = path.join(os.tmpdir(), `thumb_${jobId}.jpg`);
    try {
      await new Promise<void>((resolve, reject) => {
        const ff = spawn('ffmpeg', ['-y', '-i', videoUrl, '-ss', '0', '-vframes', '1', '-q:v', '2', tmpPath]);
        let stderr = '';
        ff.stderr.on('data', (d) => { stderr += d.toString(); });
        ff.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-400)}`)));
        ff.on('error', reject);
      });
      const buf = fs.readFileSync(tmpPath);
      const key = `videos/${jobId}.jpg`;
      await this.s3.send(new PutObjectCommand({
        Bucket: this.s3Bucket, Key: key, Body: buf,
        ContentType: 'image/jpeg', ACL: 'public-read',
      }));
      return this.s3PublicUrl(key);
    } catch (e: any) {
      this.logger.warn(`thumbnail extract failed for ${jobId}: ${e.message}`);
      return null;
    } finally {
      try { fs.unlinkSync(tmpPath); } catch {}
    }
  }

  // ================= VEO 3.1 PROVIDER =================

  // Скачать до 3 референс-фото в base64 для Veo referenceImages (Ingredients).
  private async fetchReferenceImagesB64(urls: string[]): Promise<Array<{ b64: string; mime: string }>> {
    const out: Array<{ b64: string; mime: string }> = [];
    for (const u of (urls || []).slice(0, 3)) {
      const p = await this.fetchPortraitB64(u);
      if (p) out.push({ b64: p.b64, mime: p.mime });
    }
    return out;
  }

  // Ссылки на фото приходят от человека или модели (sourceImageUrl[s]) —
  // качаем через fetchMediaBytes: своё (/static/, наш MinIO) напрямую, чужое —
  // с защитой от SSRF. Относительные '/…' он сам достраивает до нашего сайта.
  private async fetchPortraitB64(url: string): Promise<{ b64: string; mime: string } | null> {
    try {
      const media = await fetchMediaBytes(url, { maxBytes: 12 * 1024 * 1024, timeoutMs: 30000, allowHttp: true });
      const mime = media.contentType || 'image/jpeg';
      return { b64: media.data.toString('base64'), mime };
    } catch (e: any) {
      this.logger.warn(`Veo portrait fetch failed: ${e.message}`);
      return null;
    }
  }

  // Veo генерит видео сегментами по 8с (база + extend'ы), и каждый сегмент —
  // отдельный prompt. Если во все сегменты класть один и тот же текст с репликой,
  // Veo проговаривает её ЗАНОВО в каждом куске (жалоба владельца: речь повторяется
  // каждые 8с). Поэтому распределяем предложения промпта по сегментам, чтобы речь
  // прозвучала один раз на всю длину. Хвостовые сегменты без текста получают
  // продолжение БЕЗ речи (естественная пауза), а не повтор.
  private veoContinuationPrompt(): string {
    return 'Continue the previous shot seamlessly: the same person and setting, natural lifelike motion — subtle head movement, blinking, calm facial expression. The person has finished speaking: no new dialogue, and do not repeat any earlier spoken words.';
  }

  // Любая кавычка-пара: гильеметы «», типографские "" „", прямые "".
  private static readonly QUOTE_RE = /«([^»]+)»|“([^”]+)”|„([^“"]+)[“"]|"([^"]+)"/g;

  // Ёфикатор: восстанавливает «ё» в ОДНОЗНАЧНЫХ словах (взлет→взлёт). Veo иначе
  // читает «е». Словарь — безопасный список eyo (только слова без омографов;
  // «полет/полёт» НЕ входит, ошибок не вводим). Данные лежат как .txt в репо
  // (src/video/yo-safe.txt) — НЕ зависим от ESM-пакета eyo-kernel (на проде
  // Node 20, require(ESM) упал бы). Карта формы-без-ё → формы-с-ё строится 1 раз.
  private static _yoMap: Map<string, string> | null = null;

  private loadYoMap(): Map<string, string> {
    if (VideoService._yoMap) return VideoService._yoMap;
    const map = new Map<string, string>();
    try {
      const candidates = [
        path.join(__dirname, 'yo-safe.txt'),
        path.join(__dirname, '..', '..', 'src', 'video', 'yo-safe.txt'),
      ];
      const file = candidates.find((p) => fs.existsSync(p));
      if (file) {
        const txt = fs.readFileSync(file, 'utf8');
        for (const raw of txt.split('\n')) {
          const line = raw.trim();
          if (!line) continue;
          // Формат: «основа» либо «основа(оконч1|оконч2|...)». Формы = основа и
          // основа+каждое окончание.
          const m = line.match(/^([^(]+)(?:\(([^)]*)\))?$/);
          if (!m) continue;
          const base = m[1];
          const forms = [base];
          if (m[2]) for (const e of m[2].split('|')) forms.push(base + e);
          for (const f of forms) {
            const key = f.replace(/ё/g, 'е').replace(/Ё/g, 'Е').toLowerCase();
            if (key !== f.toLowerCase()) map.set(key, f.toLowerCase());
          }
        }
      } else {
        this.logger.warn('yo-safe.txt not found — ёфикация отключена');
      }
    } catch (e: any) {
      this.logger.warn(`yo dict load failed: ${e.message}`);
    }
    VideoService._yoMap = map;
    return map;
  }

  private yofy(text: string): string {
    if (!text) return text;
    const map = this.loadYoMap();
    if (map.size === 0) return text;
    return text.replace(/[а-яёА-ЯЁ]+/g, (w: string) => {
      const v = map.get(w.toLowerCase());
      if (!v) return w;
      // Восстановить регистр первой буквы (реплики обычно не капсом целиком).
      return /^[А-ЯЁ]/.test(w) ? v.charAt(0).toUpperCase() + v.slice(1) : v;
    });
  }

  private buildVeoSegmentPrompts(prompt: string, segments: number): string[] {
    const clean = String(prompt || '').trim();
    if (segments <= 1) return [clean];

    // Собираем ВСЕ реплики в кавычках (это то, что персонаж проговаривает).
    const quotes: string[] = [];
    const qre = new RegExp(VideoService.QUOTE_RE.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = qre.exec(clean))) {
      const q = (m[1] || m[2] || m[3] || m[4] || '').trim();
      if (q) quotes.push(q);
    }
    if (quotes.length === 0) {
      // Нет реплики в кавычках — база несёт всё, хвосты продолжают без речи.
      const out = [clean];
      for (let i = 1; i < segments; i++) out.push(this.veoContinuationPrompt());
      return out;
    }

    // Полный сценарий речи. Если есть сводный блок «Spoken dialogue / реплика /
    // весь текст: «…»» — он авторитетен (полный список); иначе склеиваем
    // уникальные реплики по порядку (раскадровка по beat'ам). Это и был баг
    // (бэклог: повтор фразы на стыке клипов у katya) — раньше брали ТОЛЬКО первую
    // кавычку и считали её всей репликой, а остаток дублировался в каждый клип.
    let fullScript = '';
    const sd = clean.match(/(?:spoken dialogue|реплик[аи]|полный текст|весь текст|говорит)[^«“"„]{0,60}?[«“"„]([^»”"]+)[»”"]/i);
    if (sd && sd[1].trim()) {
      fullScript = sd[1].trim();
    } else {
      const uniq: string[] = [];
      for (const q of quotes) if (!uniq.includes(q)) uniq.push(q);
      fullScript = uniq.join(' ');
    }

    // ВЫРЕЗАЕМ всю речь из тела промпта (и метку Spoken dialogue), чтобы полный
    // текст не «утекал» в каждый клип. Визуальные/тайминговые/тон-указания
    // (без слов) остаются — они нужны для картинки.
    let body = clean
      .replace(/(?:spoken dialogue|реплика|полный текст|весь текст)[^\n«“"„]*[:：]?/gi, '')
      .replace(new RegExp(VideoService.QUOTE_RE.source, 'g'), '')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    const scriptSentences = fullScript
      .split(/(?<=[.!?。！？…])\s+/).map((s) => s.trim()).filter(Boolean);
    const perSeg = Math.max(1, Math.ceil(scriptSentences.length / segments));

    const out: string[] = [];
    for (let i = 0; i < segments; i++) {
      const chunk = scriptSentences.slice(i * perSeg, (i + 1) * perSeg);
      if (chunk.length) {
        out.push(
          `${body}\n\n=== РЕЧЬ В ЭТОМ ФРАГМЕНТЕ (СТРОГО) ===\n` +
          `Персонаж произносит вслух ровно и ТОЛЬКО эти слова, одной непрерывной речью, ` +
          `без повторов и без любых других реплик: «${chunk.join(' ')}»`,
        );
      } else {
        out.push(
          `${body}\n\n=== РЕЧЬ В ЭТОМ ФРАГМЕНТЕ (СТРОГО) ===\n` +
          `Персонаж МОЛЧИТ: продолжает сцену естественно (моргание, лёгкие движения головы, ` +
          `спокойное выражение), БЕЗ речи и без повтора ранее сказанного.`,
        );
      }
    }
    return out;
  }

  private async createVeoJob(
    userId: string,
    dto: CreateVideoJobDto,
  ): Promise<{ jobId: string; status: string; tokensSpent: number }> {
    if (!this.veo.isConfigured()) throw new BadRequestException('Veo is not configured (GOOGLE_AI_API_KEY)');
    // Внутренние вызовы (чат, TG-бот, поддержка) идут мимо валидации DTO, а
    // модель там пишет LLM или берётся из старой строки, — проверяем здесь.
    if (!isVeoModel(String(dto.model))) {
      throw new BadRequestException(`unsupported video model: ${dto.model} (only veo-3.1-fast, veo-3.1)`);
    }
    const model = dto.model as VideoModel;
    const mode = dto.mode;
    if (mode !== 'text2video' && mode !== 'image2video') {
      throw new BadRequestException('Veo supports mode text2video or image2video');
    }
    let prompt = String(dto.prompt ?? '').trim();
    if (!prompt) throw new BadRequestException('Veo requires a prompt');

    // A (фидбэк katya): формат и разрешение Veo вместо захардкоженных 16:9/720p.
    // Формат — из dto, иначе авто-детект «вертикальное/reels» из исходного
    // промпта, иначе 16:9. Разрешение — из dto, иначе 1080p (детализация кожи;
    // 720p выглядел «пластиково»). Детектим ДО нормализации — по словам юзера.
    const aspectRatio: '16:9' | '9:16' = dto.aspectRatio === '9:16' || dto.aspectRatio === '16:9'
      ? dto.aspectRatio
      : (/вертикал|vertical|\breels\b|рилс|9:16|сторис|stories|tiktok|тикток|shorts|шортс/i.test(prompt) ? '9:16' : '16:9');
    const resolution: '720p' | '1080p' = dto.resolution === '720p' ? '720p' : '1080p';

    // Нормализация промпта (баг владельца 2026-06-05): ассистент иногда шлёт в
    // Veo ТОЛЬКО реплику (голый сценарий без сцены/«говорит в камеру»/субтитров).
    // Из «фото + голая речь» Veo делает вырожденную базу, и extend на ней падает
    // с "internal server issue". Если в промпте нет визуального обрамления —
    // оборачиваем речь в talking-head шаблон (речь в кавычках), тогда сегментер
    // корректно распределит реплику и сохранит сцену+субтитры в каждом сегменте.
    const SCENE_RE = /camera|кадр|\bscene\b|сцен|background|\bфон\b|wearing|\bодет|lighting|освещ|portrait|talking|\bspeaks?\b|в камеру|\bvideo\b|\bвидео\b|\bsuit\b|костюм|office|офис|9:16|16:9|subtitle|субтитр|vertical|вертикал|\bshot\b|says:|говорит/i;
    if (!SCENE_RE.test(prompt)) {
      const who = dto.mode === 'image2video'
        ? 'The person from the reference photo'
        : 'A confident professional in their 40s';
      prompt = `Talking-head business video-card. ${who} looks directly into the camera in a clean modern office with soft cinematic lighting and shallow depth of field, natural perfectly lip-synced speech, calm confident tone, slight smile. He speaks in his native language and says: "${prompt}" Burned-in subtitles at the bottom of the frame, in sync with the speech.`;
      this.logger.log('Veo prompt normalized (bare speech → talking-head frame)');
    }

    const target = Math.round(dto.targetDurationSec ?? 8);
    if (target < 4 || target > 60) throw new BadRequestException('Veo length must be 4–60 seconds');

    // Склейка независимых 8с-клипов вместо цепочки продлений (автоматизация
    // ручной склейки — фидбэк katya): вертикаль длиннее 8с и горизонталь, чья
    // цепочка не помещается в 40с Omni, см. needsVeoConcat. Каждый клип —
    // полная база (цена N×base). Остальное идёт прежним путём (база + extend).
    const veoConcat = needsVeoConcat(aspectRatio, target);
    const quote = veoConcat ? computeVeoConcatQuote(model, target) : computeVeoQuote(model, target);
    let cost = quote.totalCost;

    // «Голосом оригинала» (96cba3f7): только при готовом клоне у юзера; добавляем
    // надбавку за speech-to-speech. На финализации Veo дорожка заменяется на голос
    // пользователя (applyOwnVoiceIfNeeded), при сбое — fallback на нативный голос.
    let ownVoice = false;
    let voiceDirection: string | null = null;
    if (dto.ownVoice) {
      const vr = await this.voice.getUserVoice(userId);
      if (!vr || vr.status !== 'ready' || !vr.elevenlabs_voice_id) {
        throw new BadRequestException('own voice not ready — upload a voice sample first');
      }
      ownVoice = true;
      cost += computeOwnVoiceSurcharge(target);
      // Авто-дескриптор голоса (профайлер): зададим голос Veo-рассказчика близким
      // к юзеру → у speech-to-speech минимум примеси (источник≈цель). Инжектим
      // в промпт ниже, до нарезки сегментов.
      voiceDirection = vr.voice_descriptor?.veo_voice_prompt || null;
    }

    // Цепочка продлений идёт в 720p (у Veo extend требовал вход 720p, у Omni
    // держим ради цены: продление стоит 63k за 7с, а 1080p в 1,5 раза дороже) —
    // поэтому 1080p в ней возможен ТОЛЬКО для односегментных роликов (≤8с). В
    // concat-режиме каждый клип — независимая база (extend нет), значит 1080p
    // доступен на любой длине — что ещё и помогает с «пластиковой» текстурой
    // (фидбэк katya #4).
    const effectiveResolution: '720p' | '1080p' = veoConcat
      ? resolution
      : (quote.segments > 1 ? '720p' : resolution);

    // До 3 референс-фото (Veo Ingredients) — сходство лица сильно лучше с
    // несколькими ракурсами (фидбэк katya: «нужно минимум 3 фото»).
    // referenceImages ведут идентичность по всему ролику И не ломают речь
    // (проверено: 3 фото + чёткий промпт с репликой → есть озвучка).
    // sourceImageUrls приоритетнее одиночного sourceImageUrl (back-compat).
    const toAbs = (u: string) => u.startsWith('/')
      ? (process.env.BACKEND_URL || 'https://my.linkeon.io').replace(/\/$/, '') + u
      : u;
    const refUrls: string[] = (
      Array.isArray(dto.sourceImageUrls) && dto.sourceImageUrls.length
        ? dto.sourceImageUrls
        : (dto.sourceImageUrl ? [dto.sourceImageUrl] : [])
    ).filter(Boolean).slice(0, 3).map(toAbs);
    if (mode === 'image2video' && refUrls.length === 0) {
      throw new BadRequestException('image2video requires sourceImageUrl(s)');
    }
    // Фото качаем мы сами (fetchPortraitB64), поэтому ссылку во внутреннюю
    // сеть отбиваем ДО списания: при скачивании она всё равно не пройдёт, но
    // молча — и человек заплатил бы за ролик без своего лица. Сетевые сбои
    // здесь не повод отказывать: фото пропустится, как и раньше.
    for (const u of refUrls) {
      try {
        await assertFetchableMedia(u, { allowHttp: true });
      } catch (e: any) {
        if (isUnsafeUrlError(e)) throw new BadRequestException(e.message);
      }
    }
    const imgUrlAbsolute: string | null = refUrls[0] ?? null;

    const active = await this.pg.query(
      `SELECT COUNT(*)::int AS n FROM video_jobs WHERE user_id=$1 AND status IN ('pending','processing')`,
      [userId],
    );
    if ((active.rows[0] as any).n >= this.MAX_CONCURRENT_PER_USER) {
      throw new ConflictException('too many concurrent jobs — wait for one to finish');
    }

    // Авто-ёфикация реплики: Veo читает «е» вместо «ё» (взлет→«взлет» вместо
    // «взлёт» — фидбэк katya). Безопасный словарь (eyo) правит только однозначные
    // слова, не вводя ошибок. Снимает целый класс е/ё-ошибок без ручной работы.
    prompt = this.yofy(prompt);

    // «Голосом оригинала»: добавляем голос-директиву из авто-дескриптора, чтобы
    // Veo-рассказчик звучал близко к юзеру (источник для последующего STS).
    if (ownVoice && voiceDirection) {
      prompt = `${prompt} VOICE DIRECTION (the narrator must speak in this voice): ${voiceDirection}`;
    }

    const segmentPrompts = this.buildVeoSegmentPrompts(prompt, quote.segments);
    const plan: ComposedPlan = {
      target_duration_sec: target,
      segments_total: quote.segments,
      segments_done: 0,
      segment_kling_video_ids: [],
      segment_video_urls: [],
      provider: 'veo',
      veo_tier: quote.tier,
      veo_aspect_ratio: aspectRatio,
      veo_resolution: effectiveResolution,
      veo_reference_images: refUrls,
      veo_last_interaction_id: null,
      veo_segment_prompts: segmentPrompts,
      veo_concat: veoConcat,
    };

    const client = await this.pg.getClient();
    let jobId: string;
    try {
      await client.query('BEGIN');
      const balRes = await client.query(`SELECT tokens FROM ai_profiles_consolidated WHERE user_id = $1 FOR UPDATE`, [userId]);
      const balance = Number((balRes.rows[0] as any)?.tokens ?? 0);
      if (balance < cost) { await client.query('ROLLBACK'); throw new InsufficientTokensError(balance, cost); }
      // Через процедуру — иначе списания нет в token_transactions. Баланс
      // проверен строкой выше под FOR UPDATE.
      await client.query(
        `SELECT consume_user_tokens($1, $2, $3, $4::jsonb)`,
        [userId, cost, 'Генерация видео', JSON.stringify({ mode, model, composed: true })],
      );
      const ins = await client.query(
        `INSERT INTO video_jobs (user_id, mode, model, quality, duration_sec, prompt, negative_prompt,
            source_image_url, tokens_spent, status, target_duration_sec, composed_plan, own_voice)
         VALUES ($1,$2,$3,'std',8,$4,$5,$6,$7,'pending',$8,$9,$10) RETURNING id`,
        [userId, mode, model, prompt, dto.negativePrompt ?? null, imgUrlAbsolute, cost, target, JSON.stringify(plan), ownVoice],
      );
      jobId = (ins.rows[0] as any).id as string;
      await client.query('COMMIT');
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch {}
      throw e;
    } finally {
      client.release();
    }

    try {
      // Портрет(ы) → referenceImages (Veo Ingredients): сходство по всему ролику.
      // С чётким промптом речь сохраняется (проверено 3 фото + реплика → есть звук).
      const refImages = await this.fetchReferenceImagesB64(refUrls);
      const operation = await this.veo.startGenerate({
        prompt: segmentPrompts[0] ?? prompt, durationSeconds: VEO_BASE_SEC,
        aspectRatio, resolution: effectiveResolution,
        referenceImagesB64: refImages, negativePrompt: dto.negativePrompt ?? undefined,
      });
      await this.pg.query(
        `UPDATE video_jobs SET kling_task_id=$1, status='processing', updated_at=now() WHERE id=$2`,
        [operation, jobId],
      );
      return { jobId, status: 'processing', tokensSpent: cost };
    } catch (e: any) {
      this.logger.error(`createVeoJob start error: ${e.message}`);
      await this.failAndRefund(jobId, userId, cost, `veo_start: ${String(e.message).slice(0, 300)}`);
      // e.message уже информативно (VeoService.describeError даёт дружелюбный
      // текст по квоте/контент-фильтру). Не оборачиваем в «Veo rejected the
      // request» — для дневного лимита это вводит в заблуждение.
      throw new BadRequestException(e?.message || 'Veo: не удалось запустить генерацию');
    }
  }

  private readonly MAX_VEO_EXTEND_ATTEMPTS = 6;
  // Сколько раз переотправлять сегмент при ТРАНЗИЕНТНОЙ ошибке рендера Veo
  // ("internal server issue"/5xx). Google такие просит повторить.
  private readonly MAX_VEO_OP_RETRIES = 3;

  // Переотправка текущего сегмента после транзиентной ошибки операции.
  // База (segments_done=0) — заново startGenerate (фото из source_image_url +
  // prompt[0]); extend — очищаем in-flight op, Phase 2 пере-extend'ит от
  // veo_last_interaction_id на следующем тике.
  private async restartVeoSegment(job: VideoJobRow, plan: ComposedPlan): Promise<void> {
    try {
      // Concat-режим (вертикаль): КАЖДЫЙ сегмент — независимая база, поэтому
      // транзиентный ретрай переотправляет текущий клип заново (а не сбрасывает
      // extend, которого здесь нет).
      if (plan.veo_concat) {
        const refUrls = plan.veo_reference_images?.length
          ? plan.veo_reference_images
          : (job.source_image_url ? [job.source_image_url] : []);
        const refImages = await this.fetchReferenceImagesB64(refUrls);
        const op = await this.veo.startGenerate({
          prompt: plan.veo_segment_prompts?.[plan.segments_done] ?? job.prompt ?? '', durationSeconds: VEO_BASE_SEC,
          aspectRatio: plan.veo_aspect_ratio ?? '9:16', resolution: plan.veo_resolution ?? '720p',
          referenceImagesB64: refImages,
          negativePrompt: job.negative_prompt ?? undefined,
        });
        await this.pg.query(
          `UPDATE video_jobs SET kling_task_id=$1, composed_plan=$2, updated_at=now() WHERE id=$3`,
          [op, JSON.stringify(plan), job.id],
        );
        return;
      }
      if (plan.segments_done === 0) {
        const refUrls = plan.veo_reference_images?.length
          ? plan.veo_reference_images
          : (job.source_image_url ? [job.source_image_url] : []);
        const refImages = await this.fetchReferenceImagesB64(refUrls);
        const op = await this.veo.startGenerate({
          prompt: plan.veo_segment_prompts?.[0] ?? job.prompt ?? '', durationSeconds: VEO_BASE_SEC,
          aspectRatio: plan.veo_aspect_ratio ?? '16:9', resolution: plan.veo_resolution ?? '720p',
          referenceImagesB64: refImages,
          negativePrompt: job.negative_prompt ?? undefined,
        });
        await this.pg.query(
          `UPDATE video_jobs SET kling_task_id=$1, composed_plan=$2, updated_at=now() WHERE id=$3`,
          [op, JSON.stringify(plan), job.id],
        );
      } else {
        // extend: сбрасываем in-flight op → Phase 2 пере-extend'ит на след. тике.
        await this.pg.query(
          `UPDATE video_jobs SET kling_task_id=NULL, composed_plan=$1, updated_at=now() WHERE id=$2`,
          [JSON.stringify(plan), job.id],
        );
      }
    } catch (e: any) {
      await this.failAndRefund(job.id, job.user_id, Number(job.tokens_spent), `veo_retry: ${String(e.message).slice(0, 200)}`);
    }
  }

  private async pollVeoJob(job: VideoJobRow) {
    const plan = job.composed_plan;
    if (!plan) { await this.failAndRefund(job.id, job.user_id, Number(job.tokens_spent), 'veo job missing plan'); return; }

    // Phase 1 — an operation (base or extend) is in flight: poll it.
    if (job.kling_task_id) {
      const st = await this.veo.getOperation(job.kling_task_id);
      if (!st.done) return;
      if (st.error || !st.video) {
        const err = st.error ?? 'no video';
        // Транзиентная ошибка рендеринга Google: операция принята (generate/
        // extend вернули ok), но рендер упал с "internal server issue"/5xx и
        // Google просит повторить. Переотправляем ТОТ ЖЕ сегмент, а не валим всю
        // задачу. Не-транзиентные (RAI-контент-фильтр, квота, "no video") — fail.
        const transient = st.error && /internal server|internal error|try again|temporarily|unavailable|backend error|please retry|deadline exceeded|\b50[0-3]\b/i.test(err);
        const retries = (plan.veo_op_retries ?? 0) + 1;
        if (transient && retries <= this.MAX_VEO_OP_RETRIES) {
          plan.veo_op_retries = retries;
          this.logger.warn(`Veo job ${job.id}: segment ${plan.segments_done + 1} transient op error (retry ${retries}/${this.MAX_VEO_OP_RETRIES}): ${err.slice(0, 120)}`);
          await this.restartVeoSegment(job, plan);
          return;
        }
        await this.failAndRefund(job.id, job.user_id, Number(job.tokens_spent), `veo: ${err}`);
        return;
      }
      // --- Concat-режим: клип готов — пишем в part-файл, продвигаем счётчик и
      // СНИМАЕМ in-flight op. Сама склейка (финализация) выполняется отдельным
      // тиком под оптимистичным локом (см. ниже) — иначе два тика планировщика
      // запускают два параллельных ffmpeg в один output.
      if (plan.veo_concat) {
        try {
          fs.writeFileSync(this.veoPartPath(job.id, plan.segments_done), st.video);
        } catch (e: any) {
          await this.failAndRefund(job.id, job.user_id, Number(job.tokens_spent), `veo_clip_save: ${String(e.message).slice(0, 200)}`);
          return;
        }
        plan.segments_done += 1;
        plan.current_segment_attempt = 0;
        plan.veo_op_retries = 0;
        await this.pg.query(
          `UPDATE video_jobs SET kling_task_id=NULL, composed_plan=$1, updated_at=now() WHERE id=$2`,
          [JSON.stringify(plan), job.id],
        );
        return;
      }

      // Segment finished. The extend output is the FULL cumulative video, so
      // the latest step is the whole clip so far — no ffmpeg concat.
      plan.segments_done += 1;
      plan.veo_last_interaction_id = job.kling_task_id;
      plan.current_segment_attempt = 0;
      plan.veo_op_retries = 0;

      if (plan.segments_done >= plan.segments_total) {
        // Claim finalization атомарно: applyOwnVoiceIfNeeded добавляет ~15с, и
        // следующий 5-сек тик поллера успевает повторно войти в финал того же
        // 'processing'-джоба → двойной STS+remux. Оптимистичный лок как в
        // concat-пути (concat_started_at). Второй тик видит claim и выходит.
        const claim = await this.pg.query(
          `UPDATE video_jobs
              SET composed_plan = composed_plan || jsonb_build_object('finalize_started_at', to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')),
                  updated_at = now()
            WHERE id = $1 AND (composed_plan->>'finalize_started_at') IS NULL
            RETURNING id`,
          [job.id],
        );
        if ((claim.rowCount ?? 0) === 0) {
          this.logger.debug(`Veo job ${job.id}: finalize already in flight, skipping`);
          return;
        }
        // Final segment — trim to exact target, store, mark ready.
        try {
          const url = await this.storeVeoFinal(job.id, st.video, plan.target_duration_sec);
          let thumbUrl: string | null = null;
          try { thumbUrl = await this.extractAndUploadThumbnail(job.id, url); } catch { /* nice-to-have */ }
          await this.applyOwnVoiceIfNeeded(job.id, job.user_id);
          await this.pg.query(
            `UPDATE video_jobs SET status='ready', video_url=$1, thumbnail_url=$2, composed_plan=$3, updated_at=now() WHERE id=$4`,
            [url, thumbUrl, JSON.stringify(plan), job.id],
          );
          this.logger.log(`Veo job ${job.id} ready (${plan.target_duration_sec}s, ${plan.segments_total} segments): ${url}`);
        } catch (e: any) {
          this.logger.error(`Veo job ${job.id} finalize failed: ${e.message}`);
          await this.failAndRefund(job.id, job.user_id, Number(job.tokens_spent), `veo_finalize: ${String(e.message).slice(0, 200)}`);
        }
        return;
      }

      // More segments needed — clear the in-flight op and persist progress.
      // The next extend starts on a later tick from veo_last_interaction_id.
      // kling_task_id=NULL marks the "between segments" state; pollJob still
      // routes veo jobs here.
      await this.pg.query(
        `UPDATE video_jobs SET kling_task_id=NULL, composed_plan=$1, updated_at=now() WHERE id=$2`,
        [JSON.stringify(plan), job.id],
      );
      return;
    }

    // Phase 2 (concat-режим, ФИНАЛИЗАЦИЯ): все клипы готовы — склеиваем. Берём
    // оптимистичный лок concat_started_at атомарным UPDATE,
    // чтобы параллельный тик не запустил второй ffmpeg в тот же output.
    if (plan.veo_concat && plan.segments_done >= plan.segments_total) {
      const claim = await this.pg.query(
        `UPDATE video_jobs
            SET composed_plan = composed_plan || jsonb_build_object('concat_started_at', to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')),
                updated_at = now()
          WHERE id = $1 AND (composed_plan->>'concat_started_at') IS NULL
          RETURNING id`,
        [job.id],
      );
      if ((claim.rowCount ?? 0) === 0) {
        this.logger.debug(`Veo job ${job.id}: concat already in flight, skipping`);
        return;
      }
      try {
        const parts = Array.from({ length: plan.segments_total }, (_, i) => this.veoPartPath(job.id, i));
        const url = await this.composeVeoClips(
          job.id, parts, plan.target_duration_sec,
          plan.veo_aspect_ratio ?? '9:16', plan.veo_resolution ?? '720p',
        );
        let thumbUrl: string | null = null;
        try { thumbUrl = await this.extractAndUploadThumbnail(job.id, url); } catch { /* nice-to-have */ }
        await this.applyOwnVoiceIfNeeded(job.id, job.user_id);
        await this.pg.query(
          `UPDATE video_jobs SET status='ready', video_url=$1, thumbnail_url=$2, updated_at=now() WHERE id=$3`,
          [url, thumbUrl, job.id],
        );
        this.cleanupVeoParts(job.id);
        this.logger.log(`Veo job ${job.id} ready (concat ${plan.segments_total}×8s vertical, ${plan.target_duration_sec}s): ${url}`);
      } catch (e: any) {
        this.logger.error(`Veo job ${job.id} concat failed: ${e.message}`);
        await this.failAndRefund(job.id, job.user_id, Number(job.tokens_spent), `veo_concat: ${String(e.message).slice(0, 200)}`);
        this.cleanupVeoParts(job.id);
      }
      return;
    }

    // Phase 2 (concat-режим): просто запускаем следующий НЕЗАВИСИМЫЙ 8с-клип
    // (та же тройка фото для сходства + своя порция реплики) — мы не extend'им
    // предыдущий клип, а генерим новый с нуля.
    if (plan.veo_concat && plan.segments_done > 0 && plan.segments_done < plan.segments_total) {
      try {
        const refImages = await this.fetchReferenceImagesB64(
          plan.veo_reference_images?.length ? plan.veo_reference_images : (job.source_image_url ? [job.source_image_url] : []),
        );
        const op = await this.veo.startGenerate({
          prompt: plan.veo_segment_prompts?.[plan.segments_done] ?? job.prompt ?? '', durationSeconds: VEO_BASE_SEC,
          aspectRatio: plan.veo_aspect_ratio ?? '9:16', resolution: plan.veo_resolution ?? '720p',
          referenceImagesB64: refImages, negativePrompt: job.negative_prompt ?? undefined,
        });
        plan.current_segment_attempt = 0;
        await this.pg.query(
          `UPDATE video_jobs SET kling_task_id=$1, composed_plan=$2, updated_at=now() WHERE id=$3`,
          [op, JSON.stringify(plan), job.id],
        );
        this.logger.log(`Veo job ${job.id}: generating clip ${plan.segments_done + 1}/${plan.segments_total} (concat)`);
      } catch (e: any) {
        const attempt = (plan.current_segment_attempt ?? 0) + 1;
        if (attempt >= this.MAX_VEO_EXTEND_ATTEMPTS) {
          await this.failAndRefund(job.id, job.user_id, Number(job.tokens_spent), `veo_clip: ${String(e.message).slice(0, 200)}`);
          this.cleanupVeoParts(job.id);
          return;
        }
        plan.current_segment_attempt = attempt;
        await this.pg.query(`UPDATE video_jobs SET composed_plan=$1, updated_at=now() WHERE id=$2`, [JSON.stringify(plan), job.id]);
        this.logger.warn(`Veo job ${job.id} clip start failed (attempt ${attempt}, will retry): ${e.message}`);
      }
      return;
    }

    // Phase 2 — between segments: extend the last finished step. Omni keeps the
    // previous video on its side (previous_interaction_id), so unlike Veo there
    // is no file to wait for — the extend starts on the very next tick.
    if (plan.segments_done > 0 && plan.segments_done < plan.segments_total && plan.veo_last_interaction_id) {
      try {
        // Prompt сегмента: своя порция речи (распределена при создании). Если
        // распределения нет (старое задание) — продолжение без повтора реплики,
        // НЕ полный job.prompt (он и вызывал повтор речи каждые 8с).
        const segPrompt = plan.veo_segment_prompts?.[plan.segments_done] ?? this.veoContinuationPrompt();
        const op = await this.veo.startExtend({
          prompt: segPrompt,
          previousInteractionId: plan.veo_last_interaction_id,
          durationSeconds: VEO_EXTEND_SEC,
          aspectRatio: plan.veo_aspect_ratio ?? '16:9',
          resolution: plan.veo_resolution ?? '720p',
        });
        plan.current_segment_attempt = 0;
        await this.pg.query(
          `UPDATE video_jobs SET kling_task_id=$1, composed_plan=$2, updated_at=now() WHERE id=$3`,
          [op, JSON.stringify(plan), job.id],
        );
        this.logger.log(`Veo job ${job.id}: extending segment ${plan.segments_done + 1}/${plan.segments_total}`);
      } catch (e: any) {
        const attempt = (plan.current_segment_attempt ?? 0) + 1;
        if (attempt >= this.MAX_VEO_EXTEND_ATTEMPTS) {
          await this.failAndRefund(job.id, job.user_id, Number(job.tokens_spent), `veo_extend: ${String(e.message).slice(0, 200)}`);
          return;
        }
        plan.current_segment_attempt = attempt;
        await this.pg.query(`UPDATE video_jobs SET composed_plan=$1, updated_at=now() WHERE id=$2`, [JSON.stringify(plan), job.id]);
        this.logger.warn(`Veo job ${job.id} extend start failed (attempt ${attempt}, will retry): ${e.message}`);
      }
      return;
    }
  }

  // --- Concat-режим (вертикаль): склейка независимых 8с-клипов ---

  // Staging-путь part-файла клипа. Лежит под public/videos/_veoconcat/<jobId>/,
  // т.е. на персистентном диске (переживает рестарт между тиками планировщика).
  private veoConcatDir(jobId: string): string {
    const publicDir = process.env.PUBLIC_DIR ? process.env.PUBLIC_DIR : path.resolve(process.cwd(), 'public');
    return path.join(publicDir, 'videos', '_veoconcat', jobId);
  }
  private veoPartPath(jobId: string, idx: number): string {
    const dir = this.veoConcatDir(jobId);
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `seg_${String(idx).padStart(2, '0')}.mp4`);
  }
  private cleanupVeoParts(jobId: string): void {
    try { fs.rmSync(this.veoConcatDir(jobId), { recursive: true, force: true }); } catch {}
  }

  // Размер кадра под формат+разрешение Veo (для нормализации перед concat).
  private veoFrameDims(aspect: '16:9' | '9:16', resolution: '720p' | '1080p'): [number, number] {
    if (aspect === '9:16') return resolution === '1080p' ? [1080, 1920] : [720, 1280];
    return resolution === '1080p' ? [1920, 1080] : [1280, 720];
  }

  // Склейка готовых локальных клипов в один вертикальный ролик С СОХРАНЕНИЕМ
  // ЗВУКА. Каждый клип нормализуется по видео (scale+pad+fps+SAR) и аудио
  // (aresample 48k/stereo/fltp), затем concat=...:a=1. Итог режется до target.
  private async composeVeoClips(
    jobId: string,
    partPaths: string[],
    targetDurationSec: number,
    aspect: '16:9' | '9:16',
    resolution: '720p' | '1080p',
  ): Promise<string> {
    for (const p of partPaths) {
      if (!fs.existsSync(p)) throw new Error(`missing clip part ${path.basename(p)}`);
    }
    const [W, H] = this.veoFrameDims(aspect, resolution);
    const tmpDir = path.join(os.tmpdir(), `veoconcat_${jobId}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
      const n = partPaths.length;
      const vChains = partPaths.map((_, i) =>
        `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
        `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,format=yuv420p[v${i}]`,
      );
      const aChains = partPaths.map((_, i) =>
        `[${i}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=N/SR/TB[a${i}]`,
      );
      const concatInputs = partPaths.map((_, i) => `[v${i}][a${i}]`).join('');
      const filter = [...vChains, ...aChains].join(';') + ';' +
        concatInputs + `concat=n=${n}:v=1:a=1[v][a]`;

      const outPath = path.join(tmpDir, 'output.mp4');
      await new Promise<void>((resolve, reject) => {
        const args = [
          '-y',
          ...partPaths.flatMap((p) => ['-i', p]),
          '-filter_complex', filter,
          '-map', '[v]', '-map', '[a]',
          '-t', String(targetDurationSec),
          '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
          '-pix_fmt', 'yuv420p',
          '-c:a', 'aac', '-b:a', '192k',
          '-movflags', '+faststart',
          outPath,
        ];
        const ff = spawn('ffmpeg', args);
        let stderr = '';
        ff.stderr.on('data', (d) => { stderr += d.toString(); });
        ff.on('close', (code) => {
          if (code === 0) return resolve();
          const errLines = stderr.split('\n')
            .filter((l) => /error|invalid|cannot|no such|failed|unable/i.test(l) && !/^\[libx264/.test(l))
            .slice(-8).join(' | ');
          reject(new Error(`ffmpeg exit ${code}: ${(errLines || stderr.slice(-400)).slice(0, 400)}`));
        });
        ff.on('error', reject);
      });

      const publicDir = process.env.PUBLIC_DIR ? process.env.PUBLIC_DIR : path.resolve(process.cwd(), 'public');
      const videosDir = path.join(publicDir, 'videos');
      fs.mkdirSync(videosDir, { recursive: true });
      fs.copyFileSync(outPath, path.join(videosDir, `${jobId}.mp4`));
      const backend = (process.env.BACKEND_URL || 'https://my.linkeon.io').replace(/\/$/, '');
      return `${backend}/static/videos/${jobId}.mp4`;
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  }

  // Write the Veo mp4, ffmpeg-trim to the exact requested length (the native
  // extend chain overshoots in 7s steps), serve from public/videos via Nginx.
  // Замена аудиодорожки Veo на голос пользователя (96cba3f7): extract → STS →
  // remux поверх готового public/videos/{jobId}.mp4. Тайминг/липсинк сохраняются
  // (STS не меняет длительность). Best-effort: при ЛЮБОМ сбое оставляем нативный
  // голос Veo (ролик не теряется) — только пишем в лог.
  private async applyOwnVoiceIfNeeded(jobId: string, userId: string): Promise<void> {
    let flagged = false;
    try {
      const r = await this.pg.query(`SELECT own_voice FROM video_jobs WHERE id=$1`, [jobId]);
      flagged = !!(r.rows[0] as any)?.own_voice;
    } catch { return; }
    if (!flagged) return;

    const voice = await this.voice.getUserVoice(userId);
    if (!voice || voice.status !== 'ready' || !voice.elevenlabs_voice_id) {
      this.logger.warn(`own_voice: job ${jobId} flagged but user ${userId} has no ready voice — keeping native Veo audio`);
      return;
    }
    const publicDir = process.env.PUBLIC_DIR ? process.env.PUBLIC_DIR : path.resolve(process.cwd(), 'public');
    const finalPath = path.join(publicDir, 'videos', `${jobId}.mp4`);
    if (!fs.existsSync(finalPath)) {
      this.logger.warn(`own_voice: final file missing for ${jobId} (${finalPath}) — keeping native`);
      return;
    }
    const tmpDir = path.join(os.tmpdir(), `ov_${jobId}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
      const srcAudio = path.join(tmpDir, 'src.mp3');
      await this.runFfmpeg(['-y', '-i', finalPath, '-vn', '-ac', '1', '-ar', '44100', '-b:a', '192k', srcAudio]);
      const converted = await this.voice.convert(voice.elevenlabs_voice_id, fs.readFileSync(srcAudio));
      const convAudio = path.join(tmpDir, 'voice.mp3');
      fs.writeFileSync(convAudio, converted);
      const outPath = path.join(tmpDir, 'out.mp4');
      await this.runFfmpeg(['-y', '-i', finalPath, '-i', convAudio, '-map', '0:v:0', '-map', '1:a:0',
        '-c:v', 'copy', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', outPath]);
      fs.copyFileSync(outPath, finalPath);
      this.logger.log(`own_voice applied to job ${jobId} (voice ${voice.elevenlabs_voice_id})`);
    } catch (e: any) {
      this.logger.error(`own_voice failed for ${jobId} (keeping native Veo audio): ${e.message}`);
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  }

  private runFfmpeg(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const ff = spawn('ffmpeg', args);
      let stderr = '';
      ff.stderr.on('data', (d) => { stderr += d.toString(); });
      ff.on('error', reject);
      ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-300)}`))));
    });
  }

  private async storeVeoFinal(jobId: string, input: Buffer, targetSec: number): Promise<string> {
    const tmpDir = path.join(os.tmpdir(), `veo_${jobId}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
      const inPath = path.join(tmpDir, 'in.mp4');
      fs.writeFileSync(inPath, input);
      const outPath = path.join(tmpDir, 'out.mp4');
      await new Promise<void>((resolve, reject) => {
        const ff = spawn('ffmpeg', ['-y', '-i', inPath, '-t', String(targetSec), '-c', 'copy', '-movflags', '+faststart', outPath]);
        let stderr = '';
        ff.stderr.on('data', (d) => { stderr += d.toString(); });
        ff.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-300)}`)));
        ff.on('error', reject);
      });
      const publicDir = process.env.PUBLIC_DIR ? process.env.PUBLIC_DIR : path.resolve(process.cwd(), 'public');
      const videosDir = path.join(publicDir, 'videos');
      fs.mkdirSync(videosDir, { recursive: true });
      const finalPath = path.join(videosDir, `${jobId}.mp4`);
      fs.copyFileSync(outPath, finalPath);
      const backend = (process.env.BACKEND_URL || 'https://my.linkeon.io').replace(/\/$/, '');
      return `${backend}/static/videos/${jobId}.mp4`;
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  }
}
