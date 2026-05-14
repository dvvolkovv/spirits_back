// src/smm/billing/smm-pricing.service.ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PgService } from '../../common/services/pg.service';
import { SmmPricing, rowToPricing } from '../entities/smm-pricing.entity';
import { SmmTtsTier } from '../entities/smm-scenario.entity';

@Injectable()
export class SmmPricingService implements OnModuleInit {
  private readonly logger = new Logger(SmmPricingService.name);
  private cache = new Map<SmmTtsTier, SmmPricing>();

  constructor(private readonly pg: PgService) {}

  async onModuleInit(): Promise<void> {
    await this.refresh();
  }

  async refresh(): Promise<void> {
    const res = await this.pg.query(
      `SELECT id, tokens_cost, display_name, description, active, updated_at
         FROM smm_pricing WHERE active = true`,
    );
    const next = new Map<SmmTtsTier, SmmPricing>();
    for (const row of res.rows) {
      const p = rowToPricing(row);
      next.set(p.id, p);
    }
    this.cache = next;
    this.logger.log(`Loaded ${next.size} active tariffs`);
  }

  @Interval(5 * 60_000) // refresh every 5 min
  private async tick(): Promise<void> {
    try {
      await this.refresh();
    } catch (err) {
      this.logger.warn(`Failed to refresh pricing: ${(err as Error).message}`);
    }
  }

  getTariff(tier: SmmTtsTier): SmmPricing {
    const t = this.cache.get(tier);
    if (!t) throw new Error(`unknown SMM tariff: ${tier}`);
    return t;
  }

  listActive(): SmmPricing[] {
    return Array.from(this.cache.values());
  }
}
