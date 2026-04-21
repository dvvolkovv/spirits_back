// src/video/video.service.ts
import {
  Injectable, Logger, BadRequestException, ForbiddenException,
  NotFoundException, ConflictException,
} from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { KlingService } from '../misc/kling.service';
import {
  CreateVideoJobDto, VideoJobRow, computeTokenCost,
  VideoMode, VideoModel, VideoQuality,
} from './video.dto';

export class InsufficientTokensError extends Error {
  status = 402;
  constructor(public balance: number, public required: number) {
    super('insufficient_tokens');
  }
}

@Injectable()
export class VideoService {
  private readonly logger = new Logger(VideoService.name);
  private readonly MAX_CONCURRENT_PER_USER = 3;

  constructor(
    private readonly pg: PgService,
    private readonly kling: KlingService,
  ) {}

  async createJob(
    userId: string,
    dto: CreateVideoJobDto,
  ): Promise<{ jobId: string; status: string; tokensSpent: number }> {
    const mode = dto.mode;
    const model = (dto.model ?? 'kling-v1-6') as VideoModel;
    const quality = (dto.quality ?? 'std') as VideoQuality;
    const duration = (dto.duration ?? 5) as 5 | 10;

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
    const cost = computeTokenCost(mode, model, quality, duration);

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
          source_image_url, source_video_id, camera_type, camera_config, audio_url, tokens_spent, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'pending')
         RETURNING id`,
        [
          userId, mode, model, quality, duration,
          dto.prompt ?? null, dto.negativePrompt ?? null, dto.cfgScale ?? null,
          dto.sourceImageUrl ?? null, dto.sourceVideoId ?? null,
          dto.cameraType ?? null,
          dto.cameraConfig ? JSON.stringify(dto.cameraConfig) : null,
          dto.audioUrl ?? null,
          cost,
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
          model, imageUrl: dto.sourceImageUrl!, prompt: dto.prompt,
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
      return { jobId, status: 'processing', tokensSpent: cost };
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

  // Stub — real S3 deletion wired up in a later task (Task 7).
  private async deleteS3Objects(_jobId: string): Promise<void> {
    /* intentional stub */
  }
}
