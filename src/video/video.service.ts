// src/video/video.service.ts
import {
  Injectable, Logger, BadRequestException, ForbiddenException,
  NotFoundException, ConflictException, OnModuleInit, OnModuleDestroy,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PgService } from '../common/services/pg.service';
import { KlingService } from '../misc/kling.service';
import { MiscService } from '../misc/misc.service';
import { VeoService } from '../misc/veo.service';
import {
  CreateVideoJobDto, VideoJobRow, ComposedPlan, computeTokenCost, computeComposedQuote,
  VideoMode, VideoModel, VideoQuality,
  isVeoModel, veoTier, computeVeoQuote,
} from './video.dto';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import axios from 'axios';
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

  private s3 = new S3Client({
    region: process.env.AWS_REGION ?? 'ru-central1',
    endpoint: process.env.AWS_ENDPOINT ?? 'https://storage.yandexcloud.net',
    forcePathStyle: process.env.AWS_FORCE_PATH_STYLE === 'true',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? '',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? '',
    },
  });
  private readonly s3Bucket = process.env.AWS_S3_BUCKET || 'linkeon.io';

  private s3PublicUrl(key: string): string {
    const endpoint = (process.env.AWS_ENDPOINT ?? 'https://storage.yandexcloud.net').replace(/\/$/, '');
    if (process.env.AWS_FORCE_PATH_STYLE === 'true') {
      return `${endpoint}/${this.s3Bucket}/${key}`;
    }
    const host = endpoint.replace(/^https?:\/\//, '');
    return `https://${this.s3Bucket}.${host}/${key}`;
  }

  constructor(
    private readonly pg: PgService,
    private readonly kling: KlingService,
    private readonly misc: MiscService,
    private readonly veo: VeoService,
  ) {}

  async createJob(
    userId: string,
    dto: CreateVideoJobDto,
  ): Promise<{ jobId: string; status: string; tokensSpent: number; stillImageUrl?: string; imageTokensSpent?: number }> {
    // Veo 3.1 (Google) is a separate provider — long-form talking head with
    // native audio + portrait, one continuous video (no Kling auto-still /
    // ffmpeg concat). Route before any Kling-specific setup.
    if (isVeoModel(dto.model ?? '')) {
      return this.createVeoJob(userId, dto);
    }

    // Auto-chain: text2video без sourceImageUrl → сначала Nano Banana (std),
    // потом image2video на сгенерированной картинке. Image2video у Kling даёт
    // стабильно лучше композицию и меньше «шевелится фон», чем text2video.
    // Цепочка живёт здесь (в сервисе), чтобы и UI-форма /webhook/video/jobs,
    // и MCP-инструмент generate_video из чата отрабатывали одинаково.
    let autoStillUrl: string | undefined;
    let autoStillTokens = 0;
    if (dto.mode === 'text2video' && !dto.sourceImageUrl) {
      const imgPrompt = String(dto.prompt ?? '').slice(0, 2000);
      if (!imgPrompt) throw new BadRequestException('text2video requires prompt');
      const imgResult = await this.misc.generateImage(userId, { prompt: imgPrompt, quality: 'std' });
      const imgUrl = imgResult?.images?.[0]?.url;
      if (!imgUrl) throw new Error('auto image step failed (no url)');
      autoStillUrl = imgUrl;
      autoStillTokens = Number(imgResult.tokensSpent || 0);
      dto = { ...dto, mode: 'image2video', sourceImageUrl: imgUrl };
    }

    const mode = dto.mode;
    // Veo models already returned above, so this path is Kling-only.
    const model = (dto.model ?? 'kling-v1-6') as 'kling-v1-6' | 'kling-v2-master';
    const quality = (dto.quality ?? 'std') as VideoQuality;

    // --- composed long-form video planning ---
    // When the user asks for > 10s, we chain a base 10s + N × extend 5s and
    // ffmpeg-concat. Only text2video and image2video are valid entry modes.
    let composedTarget: number | null = null;
    let composedPlan: ComposedPlan | null = null;
    if (typeof dto.targetDurationSec === 'number' && dto.targetDurationSec > 10) {
      if (mode !== 'text2video' && mode !== 'image2video') {
        throw new BadRequestException('long video requires mode text2video or image2video');
      }
      if (dto.targetDurationSec > 60) {
        throw new BadRequestException('long video max length is 60 seconds');
      }
      composedTarget = Math.round(dto.targetDurationSec);
      const quote = computeComposedQuote(mode, model, quality, composedTarget);
      composedPlan = {
        target_duration_sec: composedTarget,
        segments_total: quote.segments,
        segments_done: 0,
        segment_kling_video_ids: [],
        segment_video_urls: [],
      };
    }
    const duration = composedPlan ? 10 : ((dto.duration ?? 5) as 5 | 10);

    // --- mode-specific validation ---
    if (mode === 'image2video' && !dto.sourceImageUrl) {
      throw new BadRequestException('image2video requires sourceImageUrl');
    }
    if ((mode === 'extend' || mode === 'lipsync') && !dto.sourceVideoId) {
      throw new BadRequestException(`${mode} requires sourceVideoId`);
    }
    if (mode === 'lipsync' && model !== 'kling-v1-6') {
      throw new BadRequestException('lip-sync is supported only on kling-v1-6');
    }
    if (mode === 'extend' && duration !== 5) {
      throw new BadRequestException('extend always produces 5s');
    }

    // --- ownership check for source video ---
    // On successful jobs we overwrite kling_task_id with the Kling-side video_id (done in pollJob, future task)
    // so we can reuse it here as the upstream id for extend/lipsync.
    let sourceKlingVideoId: string | null = null;
    if (dto.sourceVideoId) {
      const row = await this.pg.query(
        `SELECT id, user_id, status, kling_task_id, mode FROM video_jobs WHERE id = $1`,
        [dto.sourceVideoId],
      );
      const src = row.rows[0] as VideoJobRow | undefined;
      if (!src) throw new NotFoundException('source video not found');
      if (src.user_id !== userId) throw new ForbiddenException('not your video');
      if (src.status !== 'ready') throw new ConflictException('source video is not ready');
      sourceKlingVideoId = src.kling_task_id;
      if (!sourceKlingVideoId) throw new ConflictException('source video has no Kling id');
    }

    // --- concurrent-job guard ---
    const active = await this.pg.query(
      `SELECT COUNT(*)::int AS n FROM video_jobs WHERE user_id=$1 AND status IN ('pending','processing')`,
      [userId],
    );
    if ((active.rows[0] as any).n >= this.MAX_CONCURRENT_PER_USER) {
      throw new ConflictException('too many concurrent jobs — wait for one to finish');
    }

    // --- cost ---
    // For composed jobs the entire planned chain is reserved up-front so the
    // user can't run out of tokens mid-chain. On failure we refund this full
    // amount (existing failAndRefund handles it via tokens_spent).
    const cost = composedPlan
      ? computeComposedQuote(mode as 'text2video' | 'image2video', model, quality, composedPlan.target_duration_sec).totalCost
      : computeTokenCost(mode, model, quality, duration);

    // --- normalize image URL to absolute (Kling rejects relative paths) ---
    let imgUrlAbsolute: string | null = null;
    if (mode === 'image2video' && dto.sourceImageUrl) {
      let imgUrl = dto.sourceImageUrl;
      if (imgUrl.startsWith('/')) {
        const base = (process.env.BACKEND_URL || 'https://my.linkeon.io').replace(/\/$/, '');
        imgUrl = base + imgUrl;
      }
      imgUrlAbsolute = imgUrl;
    }

    // --- transactional deduction + insert ---
    const client = await this.pg.getClient();
    let jobId: string;
    try {
      await client.query('BEGIN');

      const balRes = await client.query(
        `SELECT tokens FROM ai_profiles_consolidated WHERE user_id = $1 FOR UPDATE`,
        [userId],
      );
      const balance = Number((balRes.rows[0] as any)?.tokens ?? 0);
      if (balance < cost) {
        await client.query('ROLLBACK');
        throw new InsufficientTokensError(balance, cost);
      }

      await client.query(
        `UPDATE ai_profiles_consolidated SET tokens = tokens - $1 WHERE user_id = $2`,
        [cost, userId],
      );

      const ins = await client.query(
        `INSERT INTO video_jobs
         (user_id, mode, model, quality, duration_sec, prompt, negative_prompt, cfg_scale,
          source_image_url, source_video_id, camera_type, camera_config, audio_url, tokens_spent, status,
          target_duration_sec, composed_plan)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'pending',$15,$16)
         RETURNING id`,
        [
          userId, mode, model, quality, duration,
          dto.prompt ?? null, dto.negativePrompt ?? null, dto.cfgScale ?? null,
          imgUrlAbsolute ?? dto.sourceImageUrl ?? null, dto.sourceVideoId ?? null,
          dto.cameraType ?? null,
          dto.cameraConfig ? JSON.stringify(dto.cameraConfig) : null,
          dto.audioUrl ?? null,
          cost,
          composedTarget,
          composedPlan ? JSON.stringify(composedPlan) : null,
        ],
      );
      jobId = (ins.rows[0] as any).id as string;

      await client.query('COMMIT');
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch {}
      throw e;
    } finally {
      client.release();
    }

    // --- call Kling (outside txn; failure => refund + mark failed) ---
    try {
      const cameraControl = dto.cameraType
        ? { type: dto.cameraType, config: dto.cameraConfig }
        : undefined;
      let taskId: string;

      if (mode === 'text2video') {
        ({ taskId } = await this.kling.createText2VideoTask({
          model, prompt: dto.prompt ?? '', negativePrompt: dto.negativePrompt,
          cfgScale: dto.cfgScale, mode: quality, duration, cameraControl,
        }));
      } else if (mode === 'image2video') {
        ({ taskId } = await this.kling.createImage2VideoTask({
          model, imageUrl: imgUrlAbsolute!, prompt: dto.prompt,
          negativePrompt: dto.negativePrompt, cfgScale: dto.cfgScale,
          mode: quality, duration, cameraControl,
        }));
      } else if (mode === 'extend') {
        ({ taskId } = await this.kling.createVideoExtendTask({
          videoId: sourceKlingVideoId!, prompt: dto.prompt,
          negativePrompt: dto.negativePrompt, cfgScale: dto.cfgScale,
        }));
      } else {
        ({ taskId } = await this.kling.createLipSyncTask({
          videoId: sourceKlingVideoId!,
          audioUrl: dto.audioUrl,
          audioType: dto.audioUrl ? 'url' : 'text',
          text: dto.prompt,
        }));
      }

      await this.pg.query(
        `UPDATE video_jobs SET kling_task_id=$1, status='processing', updated_at=now() WHERE id=$2`,
        [taskId, jobId],
      );
      return {
        jobId,
        status: 'processing',
        tokensSpent: cost + autoStillTokens,
        ...(autoStillUrl ? { stillImageUrl: autoStillUrl, imageTokensSpent: autoStillTokens } : {}),
      };
    } catch (e: any) {
      this.logger.error(`createJob Kling error: ${e.message}`);
      // refund + mark failed in a short transaction
      const refundClient = await this.pg.getClient();
      try {
        await refundClient.query('BEGIN');
        await refundClient.query(
          `UPDATE ai_profiles_consolidated SET tokens = tokens + $1 WHERE user_id = $2`,
          [cost, userId],
        );
        await refundClient.query(
          `UPDATE video_jobs SET status='failed', error_message=$1, updated_at=now() WHERE id=$2`,
          [`kling_create: ${String(e.message).slice(0, 480)}`, jobId],
        );
        await refundClient.query('COMMIT');
      } catch (err) {
        try { await refundClient.query('ROLLBACK'); } catch {}
        this.logger.error(`refund txn failed: ${(err as any).message}`);
      } finally {
        refundClient.release();
      }
      throw new BadRequestException(`Kling rejected the request: ${e.message}`);
    }
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

    this.pollTimer = setInterval(
      () => this.tick().catch((e) => this.logger.error(`tick error: ${e.message}`)),
      this.POLL_INTERVAL_MS,
    );
    this.logger.log('VideoService poller started (tick=5s)');
  }

  onModuleDestroy() {
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  private async tick() {
    await this.expireStaleJobs();
    const res = await this.pg.query(
      `SELECT * FROM video_jobs WHERE status='processing' ORDER BY updated_at ASC LIMIT 20`,
    );
    const jobs = res.rows as VideoJobRow[];
    await Promise.all(
      jobs.map((job) =>
        this.pollJob(job).catch((e) => this.logger.error(`pollJob ${job.id} error: ${e.message}`)),
      ),
    );
  }

  private async expireStaleJobs() {
    // Composed long-form jobs legitimately take much longer than 15 min
    // (4 segments × ~8 min each). For them we allow 8 min per segment +
    // 5 min for concat/upload, capped at 60 min hard ceiling.
    // For simple jobs the original 15 min still applies.
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
    // Veo first — its chain has a "between segments" state with no in-flight
    // operation (kling_task_id=null) that must still be polled to start the
    // next extend once the prior clip is processed.
    if (isVeoModel(job.model)) { await this.pollVeoJob(job); return; }
    if (!job.kling_task_id) return;
    // For composed jobs the current Kling call is a base text2video/image2video
    // for segment 1, then a Kling 'extend' for segments 2..N. We query the
    // matching path based on which segment is in flight.
    const currentMode: VideoMode = job.composed_plan && job.composed_plan.segments_done > 0
      ? 'extend'
      : job.mode;
    const res = await this.kling.getVideoTaskStatus(job.kling_task_id, currentMode);

    if (res.status === 'succeed' && res.videoUrl) {
      if (job.composed_plan) {
        await this.advanceComposedJob(job, res.videoId ?? null, res.videoUrl);
      } else {
        await this.finalizeSimpleJob(job, res.videoId ?? null, res.videoUrl);
      }
    } else if (res.status === 'failed') {
      if (job.composed_plan && this.isTransientKlingError(res.error)) {
        const retried = await this.retryComposedSegment(job, res.error ?? '');
        if (retried) return;
      }
      await this.failAndRefund(job.id, job.user_id, Number(job.tokens_spent), res.error ?? 'failed');
    }
    // 'submitted' / 'processing' — no-op until next tick
  }

  // Kling extends sporadically fail with "Internal error" without any
  // structural problem (verified twice in testing). One retry recovers
  // most of these. We never retry the base segment — those failures are
  // typically real (bad prompt, content moderation, etc.).
  private readonly MAX_SEGMENT_RETRIES = 1;
  private isTransientKlingError(msg: string | undefined): boolean {
    if (!msg) return false;
    return /internal error|timeout|rate limit|service unavailable|temporarily/i.test(msg);
  }

  private async retryComposedSegment(job: VideoJobRow, error: string): Promise<boolean> {
    const plan = job.composed_plan!;
    // Only retry mid-chain (after we already have at least one segment).
    if (plan.segments_done === 0) return false;
    const attempt = (plan.current_segment_attempt ?? 0) + 1;
    if (attempt > this.MAX_SEGMENT_RETRIES) {
      this.logger.warn(`Composed job ${job.id}: segment ${plan.segments_done + 1} exhausted retries (${attempt - 1})`);
      return false;
    }
    const lastVideoId = plan.segment_kling_video_ids[plan.segment_kling_video_ids.length - 1];
    if (!lastVideoId) return false;
    try {
      const { taskId } = await this.kling.createVideoExtendTask({
        videoId: lastVideoId,
        prompt: job.prompt ?? undefined,
        negativePrompt: job.negative_prompt ?? undefined,
        cfgScale: job.cfg_scale ?? undefined,
      });
      plan.current_segment_attempt = attempt;
      await this.pg.query(
        `UPDATE video_jobs SET kling_task_id=$1, composed_plan=$2, updated_at=now() WHERE id=$3`,
        [taskId, JSON.stringify(plan), job.id],
      );
      this.logger.warn(`Composed job ${job.id}: segment ${plan.segments_done + 1} retry ${attempt}/${this.MAX_SEGMENT_RETRIES} after Kling error: ${error.slice(0, 100)}`);
      return true;
    } catch (e: any) {
      this.logger.error(`Composed job ${job.id}: retry submission failed: ${e.message}`);
      return false;
    }
  }

  private async finalizeSimpleJob(job: VideoJobRow, klingVideoId: string | null, klingVideoUrl: string) {
    let finalVideoUrl = klingVideoUrl;
    let thumbUrl: string | null = null;
    try {
      finalVideoUrl = await this.rehostToS3(job.id, klingVideoUrl);
      thumbUrl = await this.extractAndUploadThumbnail(job.id, finalVideoUrl);
    } catch (s3err: any) {
      this.logger.warn(`Video job ${job.id}: S3 rehost failed (${s3err.message}), using Kling CDN URL directly`);
      finalVideoUrl = klingVideoUrl;
      thumbUrl = null;
    }
    await this.pg.query(
      `UPDATE video_jobs
          SET status='ready', video_url=$1, thumbnail_url=$2,
              kling_task_id = COALESCE($3, kling_task_id),
              updated_at=now()
        WHERE id=$4`,
      [finalVideoUrl, thumbUrl, klingVideoId, job.id],
    );
    this.logger.log(`Video job ${job.id} ready: ${finalVideoUrl}`);
  }

  private async advanceComposedJob(job: VideoJobRow, klingVideoId: string | null, klingVideoUrl: string) {
    const plan: ComposedPlan = job.composed_plan!;
    // Record the just-finished segment. Reset retry counter — the next
    // segment starts with a clean budget.
    plan.segment_kling_video_ids.push(klingVideoId ?? '');
    plan.segment_video_urls.push(klingVideoUrl);
    plan.segments_done += 1;
    plan.current_segment_attempt = 0;

    this.logger.log(`Composed job ${job.id}: segment ${plan.segments_done}/${plan.segments_total} done`);

    if (plan.segments_done < plan.segments_total) {
      // Fire the next extend. Kling extends always take a Kling video_id of
      // the previous segment, not a public URL.
      if (!klingVideoId) {
        await this.failAndRefund(job.id, job.user_id, Number(job.tokens_spent),
          'missing Kling video_id on intermediate segment');
        return;
      }
      try {
        const { taskId } = await this.kling.createVideoExtendTask({
          videoId: klingVideoId,
          prompt: job.prompt ?? undefined,
          negativePrompt: job.negative_prompt ?? undefined,
          cfgScale: job.cfg_scale ?? undefined,
        });
        await this.pg.query(
          `UPDATE video_jobs SET kling_task_id=$1, composed_plan=$2, updated_at=now() WHERE id=$3`,
          [taskId, JSON.stringify(plan), job.id],
        );
      } catch (e: any) {
        this.logger.error(`Composed job ${job.id} extend failed at segment ${plan.segments_done}: ${e.message}`);
        await this.failAndRefund(job.id, job.user_id, Number(job.tokens_spent),
          `extend failed: ${String(e.message).slice(0, 200)}`);
      }
      return;
    }

    // All segments done — concat + trim + upload as the final job's video.
    //
    // Concurrency: pollJob is called every 5s for every 'processing' job.
    // composeFinalVideo takes 30-120s (download segments + ffmpeg + S3 upload),
    // so without a lock the next tick re-enters with the same job, both pollers
    // download into the same tmpDir, the first one's `finally rmSync` nukes
    // files the second one is about to read → ENOENT seg_NN.mp4 spam.
    // We take an optimistic lock via composed_plan.concat_started_at and
    // RETURNING — only the winner runs concat.
    const lockRes = await this.pg.query(
      `UPDATE video_jobs
          SET composed_plan = composed_plan || jsonb_build_object('concat_started_at', to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')),
              updated_at = now()
        WHERE id = $1
          AND status = 'processing'
          AND (composed_plan->>'concat_started_at') IS NULL
        RETURNING id`,
      [job.id],
    );
    if (lockRes.rowCount === 0) {
      // Another tick already took the lock. Bail out — that tick will set
      // status to ready/failed when it finishes.
      this.logger.debug(`Composed job ${job.id}: concat already in flight, skipping`);
      return;
    }
    try {
      const targetSec = plan.target_duration_sec;
      const finalUrl = await this.composeFinalVideo(job.id, plan.segment_video_urls, targetSec);
      let thumbUrl: string | null = null;
      try {
        thumbUrl = await this.extractAndUploadThumbnail(job.id, finalUrl);
      } catch { /* thumbnail is nice-to-have */ }
      await this.pg.query(
        `UPDATE video_jobs
            SET status='ready', video_url=$1, thumbnail_url=$2,
                composed_plan=$3, updated_at=now()
          WHERE id=$4`,
        [finalUrl, thumbUrl, JSON.stringify(plan), job.id],
      );
      this.logger.log(`Composed job ${job.id} ready (${targetSec}s, ${plan.segments_total} segments): ${finalUrl}`);
    } catch (e: any) {
      this.logger.error(`Composed job ${job.id} concat failed: ${e.message}`);
      await this.failAndRefund(job.id, job.user_id, Number(job.tokens_spent),
        `concat: ${String(e.message).slice(0, 200)}`);
    }
  }

  // Download all Kling segments, ffmpeg-concat with normalization (scale +
  // setsar + concat filter — robust to codec/timing/SAR differences between
  // Kling base 10s and extend 5s outputs, where concat demuxer was failing
  // with "Invalid data found when processing input"), trim to the exact
  // target duration, upload to S3, return the public URL.
  private async composeFinalVideo(jobId: string, segmentUrls: string[], targetDurationSec: number): Promise<string> {
    const tmpDir = path.join(os.tmpdir(), `composed_${jobId}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
      // 1. Download segments
      const localPaths: string[] = [];
      for (let i = 0; i < segmentUrls.length; i++) {
        const dst = path.join(tmpDir, `seg_${String(i).padStart(2, '0')}.mp4`);
        const resp = await axios.get(segmentUrls[i], { responseType: 'arraybuffer', timeout: 120000 });
        fs.writeFileSync(dst, Buffer.from(resp.data));
        localPaths.push(dst);
      }

      // 2. ffmpeg concat filter (NOT demuxer) — normalizes each segment to
      // 1280x720 / yuv420p / SAR 1 / 30fps before concat. Audio is dropped
      // because Kling base/extend videos are silent and adding an empty
      // track here would just bloat output without value.
      // The 16:9 1280×720 target matches Kling's default output; segments
      // already at this size get a no-op scale.
      const outPath = path.join(tmpDir, 'output.mp4');
      const n = localPaths.length;
      const filter =
        localPaths.map((_, i) =>
          `[${i}:v]scale=1280:720:force_original_aspect_ratio=decrease,` +
          `pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,` +
          `setsar=1,fps=30,format=yuv420p[v${i}]`,
        ).join(';') +
        ';' +
        localPaths.map((_, i) => `[v${i}]`).join('') +
        `concat=n=${n}:v=1:a=0[v]`;

      await new Promise<void>((resolve, reject) => {
        const args = [
          '-y',
          ...localPaths.flatMap((p) => ['-i', p]),
          '-filter_complex', filter,
          '-map', '[v]',
          '-t', String(targetDurationSec),
          '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
          '-pix_fmt', 'yuv420p',
          '-movflags', '+faststart',
          '-an',
          outPath,
        ];
        const ff = spawn('ffmpeg', args);
        let stderr = '';
        ff.stderr.on('data', (d) => { stderr += d.toString(); });
        ff.on('close', (code) => {
          if (code === 0) return resolve();
          // libx264 emits a wall of stats lines at the end of stderr that
          // crowd out the actual error. Pull the most diagnostic lines
          // (anything with "Error", "Invalid", "Conversion failed", "No such",
          // "Cannot") to surface the real cause.
          const errLines = stderr.split('\n')
            .filter((l) => /error|invalid|cannot|no such|failed|unable/i.test(l) && !/^\[libx264/.test(l))
            .slice(-8)
            .join(' | ');
          const msg = errLines || stderr.slice(-400);
          reject(new Error(`ffmpeg exit ${code}: ${msg.slice(0, 400)}`));
        });
        ff.on('error', reject);
      });

      // 3. Persist the composed mp4. We deliberately bypass S3 for composed
      // jobs because Yandex Object Storage signing has been silently failing
      // for video uploads in this deployment for a while (every existing
      // 'ready' simple job has a Kling-CDN video_url, meaning rehostToS3 was
      // hitting the catch path and falling back to klingUrl). Simple jobs are
      // OK with that fallback because Kling holds the original mp4 for a
      // while. Composed jobs CAN'T fall back — the mp4 lives only here.
      // So we write to public/videos and serve via Nginx /static/ (which is
      // already configured: location /static/ -> alias /home/dvolkov/spirits_back/public/).
      const publicDir = process.env.PUBLIC_DIR
        ? process.env.PUBLIC_DIR
        : path.resolve(process.cwd(), 'public');
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

  private async failAndRefund(jobId: string, userId: string, tokens: number, reason: string) {
    const client = await this.pg.getClient();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE ai_profiles_consolidated SET tokens = tokens + $1 WHERE user_id = $2`,
        [tokens, userId],
      );
      await client.query(
        `UPDATE video_jobs SET status='failed', error_message=$1, updated_at=now() WHERE id=$2`,
        [String(reason).slice(0, 500), jobId],
      );
      await client.query('COMMIT');
    } catch (e: any) {
      try { await client.query('ROLLBACK'); } catch {}
      this.logger.error(`failAndRefund txn error: ${e.message}`);
    } finally {
      client.release();
    }
    this.logger.warn(`Video job ${jobId} failed, refunded ${tokens} tokens: ${reason}`);
  }

  private async rehostToS3(jobId: string, klingUrl: string): Promise<string> {
    const resp = await axios.get(klingUrl, { responseType: 'stream', timeout: 120000 });
    const key = `videos/${jobId}.mp4`;
    await new Upload({
      client: this.s3,
      params: {
        Bucket: this.s3Bucket,
        Key: key,
        Body: resp.data,
        ContentType: 'video/mp4',
      },
    }).done();
    return this.s3PublicUrl(key);
  }

  async uploadUserAsset(
    userId: string,
    kind: 'image' | 'audio',
    buffer: Buffer,
    mimeType: string,
    origName: string,
  ): Promise<string> {
    const allowed = kind === 'image' ? /^image\//.test(mimeType) : /^audio\//.test(mimeType);
    if (!allowed) throw new BadRequestException(`bad mime type for ${kind}: ${mimeType}`);
    const maxBytes = kind === 'image' ? 10 * 1024 * 1024 : 20 * 1024 * 1024;
    if (buffer.byteLength > maxBytes) {
      throw new BadRequestException(`file too large (max ${maxBytes / 1024 / 1024} MB)`);
    }
    const extMatch = origName.match(/\.([a-z0-9]{2,5})$/i);
    const ext = extMatch ? extMatch[1].toLowerCase() : kind === 'image' ? 'jpg' : 'mp3';
    const key = `video-uploads/${userId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
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

  private async fetchPortraitB64(url: string): Promise<{ b64: string; mime: string } | null> {
    try {
      let u = url;
      if (u.startsWith('/')) {
        u = (process.env.BACKEND_URL || 'https://my.linkeon.io').replace(/\/$/, '') + u;
      }
      const resp = await axios.get(u, { responseType: 'arraybuffer', timeout: 30000, maxContentLength: 12 * 1024 * 1024 });
      const mime = (resp.headers['content-type'] as string) || 'image/jpeg';
      return { b64: Buffer.from(resp.data).toString('base64'), mime };
    } catch (e: any) {
      this.logger.warn(`Veo portrait fetch failed: ${e.message}`);
      return null;
    }
  }

  private async createVeoJob(
    userId: string,
    dto: CreateVideoJobDto,
  ): Promise<{ jobId: string; status: string; tokensSpent: number }> {
    if (!this.veo.isConfigured()) throw new BadRequestException('Veo is not configured (GOOGLE_AI_API_KEY)');
    const model = dto.model as VideoModel;
    const mode = dto.mode;
    if (mode !== 'text2video' && mode !== 'image2video') {
      throw new BadRequestException('Veo supports mode text2video or image2video');
    }
    const prompt = String(dto.prompt ?? '').trim();
    if (!prompt) throw new BadRequestException('Veo requires a prompt');

    const target = Math.round(dto.targetDurationSec ?? dto.duration ?? 8);
    if (target < 4 || target > 60) throw new BadRequestException('Veo length must be 4–60 seconds');

    const quote = computeVeoQuote(model, target);
    const cost = quote.totalCost;

    let imgUrlAbsolute: string | null = null;
    if (mode === 'image2video') {
      if (!dto.sourceImageUrl) throw new BadRequestException('image2video requires sourceImageUrl');
      imgUrlAbsolute = dto.sourceImageUrl.startsWith('/')
        ? (process.env.BACKEND_URL || 'https://my.linkeon.io').replace(/\/$/, '') + dto.sourceImageUrl
        : dto.sourceImageUrl;
    }

    const active = await this.pg.query(
      `SELECT COUNT(*)::int AS n FROM video_jobs WHERE user_id=$1 AND status IN ('pending','processing')`,
      [userId],
    );
    if ((active.rows[0] as any).n >= this.MAX_CONCURRENT_PER_USER) {
      throw new ConflictException('too many concurrent jobs — wait for one to finish');
    }

    const plan: ComposedPlan = {
      target_duration_sec: target,
      segments_total: quote.segments,
      segments_done: 0,
      segment_kling_video_ids: [],
      segment_video_urls: [],
      provider: 'veo',
      veo_tier: quote.tier,
      veo_last_uri: null,
    };

    const client = await this.pg.getClient();
    let jobId: string;
    try {
      await client.query('BEGIN');
      const balRes = await client.query(`SELECT tokens FROM ai_profiles_consolidated WHERE user_id = $1 FOR UPDATE`, [userId]);
      const balance = Number((balRes.rows[0] as any)?.tokens ?? 0);
      if (balance < cost) { await client.query('ROLLBACK'); throw new InsufficientTokensError(balance, cost); }
      await client.query(`UPDATE ai_profiles_consolidated SET tokens = tokens - $1 WHERE user_id = $2`, [cost, userId]);
      const ins = await client.query(
        `INSERT INTO video_jobs (user_id, mode, model, quality, duration_sec, prompt, negative_prompt,
            source_image_url, tokens_spent, status, target_duration_sec, composed_plan)
         VALUES ($1,$2,$3,'std',8,$4,$5,$6,$7,'pending',$8,$9) RETURNING id`,
        [userId, mode, model, prompt, dto.negativePrompt ?? null, imgUrlAbsolute, cost, target, JSON.stringify(plan)],
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
      let imageB64: string | undefined; let imageMime: string | undefined;
      if (imgUrlAbsolute) {
        const p = await this.fetchPortraitB64(imgUrlAbsolute);
        if (!p) throw new Error('could not fetch portrait image');
        imageB64 = p.b64; imageMime = p.mime;
      }
      const operation = await this.veo.startGenerate({
        prompt, tier: quote.tier, durationSeconds: 8,
        aspectRatio: '16:9', resolution: '720p',
        imageB64, imageMime, negativePrompt: dto.negativePrompt ?? undefined,
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

  private async pollVeoJob(job: VideoJobRow) {
    const plan = job.composed_plan;
    if (!plan) { await this.failAndRefund(job.id, job.user_id, Number(job.tokens_spent), 'veo job missing plan'); return; }
    const tier = plan.veo_tier || veoTier(job.model);

    // Phase 1 — an operation (base or extend) is in flight: poll it.
    if (job.kling_task_id) {
      const st = await this.veo.getOperation(job.kling_task_id);
      if (!st.done) return;
      if (st.error || !st.videoUri) {
        await this.failAndRefund(job.id, job.user_id, Number(job.tokens_spent), `veo: ${st.error ?? 'no video'}`);
        return;
      }
      // Segment finished. Veo's extend output is the FULL cumulative video, so
      // the latest uri is the whole clip so far — no ffmpeg concat.
      plan.segments_done += 1;
      plan.veo_last_uri = st.videoUri;
      plan.current_segment_attempt = 0;

      if (plan.segments_done >= plan.segments_total) {
        // Final segment — download, trim to exact target, store, mark ready.
        try {
          const buf = await this.veo.downloadVideo(st.videoUri);
          const url = await this.storeVeoFinal(job.id, buf, plan.target_duration_sec);
          let thumbUrl: string | null = null;
          try { thumbUrl = await this.extractAndUploadThumbnail(job.id, url); } catch { /* nice-to-have */ }
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
      // The next extend starts on a later tick, once the source clip is ACTIVE
      // (Veo rejects extends on a not-yet-processed video). kling_task_id=NULL
      // marks the "between segments" state; pollJob still routes veo jobs here.
      await this.pg.query(
        `UPDATE video_jobs SET kling_task_id=NULL, composed_plan=$1, updated_at=now() WHERE id=$2`,
        [JSON.stringify(plan), job.id],
      );
      return;
    }

    // Phase 2 — between segments: start the next extend once the last clip has
    // finished processing (state ACTIVE). Otherwise retry on a later tick.
    if (plan.segments_done > 0 && plan.segments_done < plan.segments_total && plan.veo_last_uri) {
      const state = await this.veo.getFileState(plan.veo_last_uri);
      if (state !== 'ACTIVE') return; // still processing — wait for the next tick
      try {
        const op = await this.veo.startExtend({
          prompt: job.prompt ?? 'continue the scene naturally',
          tier,
          videoUri: plan.veo_last_uri,
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

  // Write the Veo mp4, ffmpeg-trim to the exact requested length (the native
  // extend chain overshoots in 7s steps), serve from public/videos via Nginx.
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
