// src/smm/producer/approval.service.ts
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PgService } from '../../common/services/pg.service';
import { SmmBillingService } from '../billing/smm-billing.service';
import { SmmPremiumGenerationService } from '../billing/smm-premium-generation.service';
import { InsufficientTokensError } from '../billing/insufficient-tokens.error';
import { RenderQueueService } from '../render/render-queue.service';
import { PremiumGenre } from '../entities/smm-scenario.entity';

/** Стоимость premium-режима в токенах сверх TTS-тарифа. */
function premiumTokensCost(klingSceneCount: number): number {
  if (klingSceneCount <= 1) return 100_000;
  return 180_000;
}

export interface ApproveScenariosInput {
  userId: string;
  scenarioIds: string[];
}

export interface ApproveResult {
  approved: Array<{ scenarioId: string; videoId: string; jobId: string }>;
  failed: Array<{ scenarioId: string; reason: 'insufficient_tokens' | 'not_found' | 'wrong_status' | 'error'; detail?: string }>;
}

@Injectable()
export class ApprovalService {
  private readonly logger = new Logger(ApprovalService.name);

  constructor(
    private readonly pg: PgService,
    private readonly billing: SmmBillingService,
    private readonly premiumGen: SmmPremiumGenerationService,
    private readonly queue: RenderQueueService,
  ) {}

  /**
   * For each scenarioId:
   *   1. Load scenario, ensure status='pending_review' or 'regenerating'
   *   2. Create smm_video row (status='queued')
   *   3. SmmBillingService.charge → deducts tokens, inserts ledger
   *   4. Enqueue render job
   *   5. Mark scenario status='approved', video.render_job_id = jobId
   * If charge fails with InsufficientTokensError, video row is deleted (no orphan).
   */
  async approveScenarios(input: ApproveScenariosInput): Promise<ApproveResult> {
    const result: ApproveResult = { approved: [], failed: [] };

    for (const scenarioId of input.scenarioIds) {
      try {
        const scRes = await this.pg.query(
          `SELECT id, tts_tier, status, premium_genre, kling_scene_count
             FROM smm_scenario WHERE id = $1`, [scenarioId]);
        if (scRes.rows.length === 0) {
          result.failed.push({ scenarioId, reason: 'not_found' });
          continue;
        }
        const row = scRes.rows[0];
        if (!['pending_review', 'regenerating'].includes(row.status)) {
          result.failed.push({ scenarioId, reason: 'wrong_status', detail: row.status });
          continue;
        }

        // Create video row in pre-charge state. We use a temp status 'queued'
        // and set tokens_charged=0; billing will overwrite to charged amount.
        const vRes = await this.pg.query(
          `INSERT INTO smm_video (scenario_id, status, tokens_charged)
           VALUES ($1, 'queued', 0) RETURNING id`,
          [scenarioId],
        );
        const videoId = vRes.rows[0].id;

        try {
          await this.billing.charge({
            userId: input.userId,
            videoId,
            tier: row.tts_tier,
          });
        } catch (err: any) {
          // Roll back the video row so we don't orphan one
          await this.pg.query(`DELETE FROM smm_video WHERE id = $1`, [videoId]);
          if (err instanceof InsufficientTokensError) {
            result.failed.push({ scenarioId, reason: 'insufficient_tokens' });
            continue;
          }
          throw err;
        }

        // Premium: списываем дополнительные токены за kling-сцены.
        // Если списание фейлится — откатываем TTS-charge и видео-строку.
        const premiumGenre: PremiumGenre | null = row.premium_genre ?? null;
        const klingSceneCount: number = Number(row.kling_scene_count ?? 0);
        if (premiumGenre && klingSceneCount > 0) {
          try {
            await this.premiumGen.charge({
              userId: input.userId,
              videoId,
              genre: premiumGenre,
              sceneCount: klingSceneCount,
              tokensCost: premiumTokensCost(klingSceneCount),
            });
            this.logger.log(`Premium charge ${premiumTokensCost(klingSceneCount)} tokens for video ${videoId} (genre=${premiumGenre}, scenes=${klingSceneCount})`);
          } catch (err: any) {
            // Refund TTS charge + drop video, чтобы не висело висяком
            await this.billing.refund({ videoId, reason: 'premium_charge_failed' });
            await this.pg.query(`DELETE FROM smm_video WHERE id = $1`, [videoId]);
            if (err instanceof InsufficientTokensError) {
              result.failed.push({ scenarioId, reason: 'insufficient_tokens', detail: 'premium scenes require extra tokens' });
              continue;
            }
            if (/rate.limit/i.test(err.message ?? '')) {
              result.failed.push({ scenarioId, reason: 'error', detail: 'rate_limit_exceeded' });
              continue;
            }
            throw err;
          }
        }

        const jobId = await this.queue.enqueue({ videoId, scenarioId });

        await this.pg.query(
          `UPDATE smm_scenario SET status = 'approved' WHERE id = $1`,
          [scenarioId]);
        await this.pg.query(
          `UPDATE smm_video SET render_job_id = $1 WHERE id = $2`,
          [jobId, videoId]);

        result.approved.push({ scenarioId, videoId, jobId });
        this.logger.log(`Approved scenario ${scenarioId} → video ${videoId} → job ${jobId}`);
      } catch (err: any) {
        result.failed.push({ scenarioId, reason: 'error', detail: err.message });
        this.logger.error(`Failed to approve scenario ${scenarioId}: ${err.message}`);
      }
    }

    return result;
  }

  /**
   * Mark scenario as 'rejected' (without billing impact — nothing was charged).
   */
  async rejectScenario(scenarioId: string): Promise<void> {
    const r = await this.pg.query(
      `UPDATE smm_scenario SET status = 'rejected' WHERE id = $1 AND status = 'pending_review' RETURNING id`,
      [scenarioId]);
    if (r.rowCount === 0) {
      const check = await this.pg.query(`SELECT status FROM smm_scenario WHERE id = $1`, [scenarioId]);
      if (check.rows.length === 0) throw new NotFoundException(`scenario ${scenarioId}`);
      // Otherwise it was already approved/rejected — no-op
    }
  }

  /**
   * Mark a video as 'approved' (admin liked the rendered MP4).
   */
  async approveVideo(videoId: string): Promise<void> {
    const r = await this.pg.query(
      `UPDATE smm_video SET status = 'approved' WHERE id = $1 AND status = 'ready' RETURNING id`,
      [videoId]);
    if (r.rowCount === 0) {
      const check = await this.pg.query(`SELECT status FROM smm_video WHERE id = $1`, [videoId]);
      if (check.rows.length === 0) throw new NotFoundException(`video ${videoId}`);
      throw new Error(`video ${videoId} is in status ${check.rows[0].status}, not 'ready'`);
    }
  }

  /**
   * Mark a video as 'rejected'. No billing impact.
   */
  async rejectVideo(videoId: string, reason?: string): Promise<void> {
    const r = await this.pg.query(
      `UPDATE smm_video SET status = 'rejected', error_message = $1 WHERE id = $2 RETURNING id`,
      [reason ?? null, videoId]);
    if (r.rowCount === 0) throw new NotFoundException(`video ${videoId}`);
  }
}
