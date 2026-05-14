// src/smm/entities/smm-pricing.entity.ts
import { SmmTtsTier } from './smm-scenario.entity';

export interface SmmPricing {
  id: SmmTtsTier;
  tokensCost: number;
  displayName: string;
  description: string | null;
  active: boolean;
  updatedAt: Date;
}

export function rowToPricing(row: any): SmmPricing {
  return {
    id: row.id,
    tokensCost: row.tokens_cost,
    displayName: row.display_name,
    description: row.description ?? null,
    active: row.active,
    updatedAt: row.updated_at,
  };
}
