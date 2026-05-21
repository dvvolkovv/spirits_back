import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../../common/services/pg.service';
import {
  SmmPremiumGeneration, rowToPremiumGen,
} from '../entities/smm-premium-generation.entity';
import { PremiumGenre } from '../entities/smm-scenario.entity';
import { InsufficientTokensError } from './insufficient-tokens.error';

const RATE_LIMIT_PER_HOUR = 5;

export interface ChargeInput {
  userId: string;
  videoId: string;
  genre: PremiumGenre;
  sceneCount: number;
  tokensCost: number;
}

export interface RefundInput {
  generationId: string;
  refundTokens: number;
  status: 'partial_refund' | 'full_refund';
}

@Injectable()
export class SmmPremiumGenerationService {
  private readonly logger = new Logger(SmmPremiumGenerationService.name);

  constructor(private readonly pg: PgService) {}

  /** Throws Error if > RATE_LIMIT_PER_HOUR premium generations in the last hour. */
  async checkRateLimit(userId: string): Promise<void> {
    const r = await this.pg.query(
      `SELECT count(*)::int AS n FROM smm_premium_generation
        WHERE user_id = $1 AND created_at > now() - interval '1 hour'`,
      [userId],
    );
    if (r.rows[0].n >= RATE_LIMIT_PER_HOUR) {
      throw new Error(`rate limit exceeded: ${RATE_LIMIT_PER_HOUR}/hour`);
    }
  }

  /**
   * Atomically deducts tokens and creates an in_progress generation row.
   * Throws InsufficientTokensError if balance < tokensCost.
   */
  async charge(input: ChargeInput): Promise<SmmPremiumGeneration> {
    await this.checkRateLimit(input.userId);
    const client = await this.pg.getClient();
    try {
      await client.query('BEGIN');
      const bal = await client.query(
        `SELECT tokens FROM ai_profiles_consolidated WHERE user_id = $1 FOR UPDATE`,
        [input.userId],
      );
      if (bal.rows.length === 0) throw new Error(`user ${input.userId} not found`);
      const balance = Number(bal.rows[0].tokens);
      if (balance < input.tokensCost) {
        await client.query('ROLLBACK');
        throw new InsufficientTokensError(balance, input.tokensCost);
      }
      await client.query(
        `UPDATE ai_profiles_consolidated SET tokens = tokens - $1, updated_at = now() WHERE user_id = $2`,
        [input.tokensCost, input.userId],
      );
      const ins = await client.query(
        `INSERT INTO smm_premium_generation
            (video_id, user_id, genre, scene_count, tokens_charged, status)
         VALUES ($1, $2, $3, $4, $5, 'in_progress')
         RETURNING *`,
        [input.videoId, input.userId, input.genre, input.sceneCount, input.tokensCost],
      );
      await client.query('COMMIT');
      this.logger.log(`premium charge ${input.tokensCost} for ${input.userId} / video ${input.videoId}`);
      return rowToPremiumGen(ins.rows[0]);
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw e;
    } finally {
      client.release();
    }
  }

  /** Atomically refunds tokens and updates status. Idempotent on already-refunded rows. */
  async refund(input: RefundInput): Promise<void> {
    const client = await this.pg.getClient();
    try {
      await client.query('BEGIN');
      const r = await client.query(
        `SELECT user_id, tokens_charged, tokens_refunded, status FROM smm_premium_generation
          WHERE id = $1 FOR UPDATE`,
        [input.generationId],
      );
      if (r.rows.length === 0) throw new Error(`premium_gen ${input.generationId} not found`);
      const row = r.rows[0];
      if (row.status === 'full_refund' || row.status === 'partial_refund') {
        await client.query('ROLLBACK');
        return;
      }
      await client.query(
        `UPDATE ai_profiles_consolidated SET tokens = tokens + $1, updated_at = now() WHERE user_id = $2`,
        [input.refundTokens, row.user_id],
      );
      await client.query(
        `UPDATE smm_premium_generation
            SET tokens_refunded = $1, status = $2, completed_at = now()
          WHERE id = $3`,
        [input.refundTokens, input.status, input.generationId],
      );
      await client.query('COMMIT');
      this.logger.log(`premium refund ${input.refundTokens} for gen ${input.generationId} (${input.status})`);
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw e;
    } finally {
      client.release();
    }
  }

  async markCompleted(generationId: string, internalCostCents: number | null): Promise<void> {
    await this.pg.query(
      `UPDATE smm_premium_generation
          SET status = 'completed', internal_cost_cents = $1, completed_at = now()
        WHERE id = $2 AND status = 'in_progress'`,
      [internalCostCents, generationId],
    );
  }

  async findByVideoId(videoId: string): Promise<SmmPremiumGeneration | null> {
    const r = await this.pg.query(
      `SELECT * FROM smm_premium_generation WHERE video_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [videoId],
    );
    return r.rows.length === 0 ? null : rowToPremiumGen(r.rows[0]);
  }
}
