// src/smm/billing/smm-billing.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../../common/services/pg.service';
import { SmmPricingService } from './smm-pricing.service';
import { InsufficientTokensError } from './insufficient-tokens.error';
import { SmmTtsTier } from '../entities/smm-scenario.entity';

export interface ChargeInput {
  userId: string;
  videoId: string;
  tier: SmmTtsTier;
}

export interface RefundInput {
  videoId: string;
  reason: string;
}

@Injectable()
export class SmmBillingService {
  private readonly logger = new Logger(SmmBillingService.name);

  constructor(
    private readonly pg: PgService,
    private readonly pricing: SmmPricingService,
  ) {}

  /**
   * Атомарно списать tokens у юзера в счёт ролика.
   * - SELECT FOR UPDATE на балансе → защита от race
   * - INSERT в ledger в одной транзакции
   * - UPDATE smm_video.tokens_charged и status='queued'
   *
   * Бросает InsufficientTokensError если баланса не хватает.
   */
  async charge(input: ChargeInput): Promise<void> {
    const tariff = this.pricing.getTariff(input.tier);
    const cost = tariff.tokensCost;

    const client = await this.pg.getClient();
    try {
      await client.query('BEGIN');
      const balRes = await client.query(
        `SELECT tokens FROM ai_profiles_consolidated WHERE user_id = $1 FOR UPDATE`,
        [input.userId],
      );
      if (balRes.rows.length === 0) {
        throw new Error(`User ${input.userId} not found in ai_profiles_consolidated`);
      }
      const balance: number = balRes.rows[0].tokens;
      if (balance < cost) {
        await client.query('ROLLBACK');
        throw new InsufficientTokensError(balance, cost);
      }
      await client.query(
        `UPDATE ai_profiles_consolidated
            SET tokens = tokens - $1, updated_at = now()
          WHERE user_id = $2`,
        [cost, input.userId],
      );
      await client.query(
        `UPDATE smm_video
            SET tokens_charged = $1, status = 'queued'
          WHERE id = $2`,
        [cost, input.videoId],
      );
      await client.query(
        `INSERT INTO smm_billing_ledger
            (user_id, video_id, amount, op, reason)
         VALUES ($1, $2, $3, 'charge', 'queued')`,
        [input.userId, input.videoId, cost],
      );
      await client.query('COMMIT');
      this.logger.log(`Charged ${cost} from ${input.userId} for video ${input.videoId}`);
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Возврат — только если был charge для этого video_id и ещё не было refund.
   * Идемпотентен: повторный вызов не возвращает деньги повторно.
   */
  async refund(input: RefundInput): Promise<void> {
    const client = await this.pg.getClient();
    try {
      await client.query('BEGIN');

      // Find the original charge for this video
      const chargeRes = await client.query(
        `SELECT user_id, amount FROM smm_billing_ledger
          WHERE video_id = $1 AND op = 'charge'
          ORDER BY created_at LIMIT 1`,
        [input.videoId],
      );
      if (chargeRes.rows.length === 0) {
        await client.query('ROLLBACK');
        this.logger.warn(`refund: no prior charge for video ${input.videoId}, no-op`);
        return;
      }
      const { user_id: userId, amount } = chargeRes.rows[0];

      // Check if refund already exists
      const refundRes = await client.query(
        `SELECT 1 FROM smm_billing_ledger
          WHERE video_id = $1 AND op = 'refund' LIMIT 1`,
        [input.videoId],
      );
      if (refundRes.rows.length > 0) {
        await client.query('ROLLBACK');
        this.logger.warn(`refund: already refunded video ${input.videoId}, no-op`);
        return;
      }

      // Apply refund
      await client.query(
        `UPDATE ai_profiles_consolidated
            SET tokens = tokens + $1, updated_at = now()
          WHERE user_id = $2`,
        [amount, userId],
      );
      await client.query(
        `INSERT INTO smm_billing_ledger
            (user_id, video_id, amount, op, reason)
         VALUES ($1, $2, $3, 'refund', $4)`,
        [userId, input.videoId, -amount, input.reason],
      );

      await client.query('COMMIT');
      this.logger.log(`Refunded ${amount} to ${userId} for video ${input.videoId}, reason: ${input.reason}`);
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw err;
    } finally {
      client.release();
    }
  }
}
