// src/smm/entities/smm-premium-generation.entity.ts
import { PremiumGenre } from './smm-scenario.entity';

export type PremiumGenStatus =
  | 'in_progress' | 'completed' | 'partial_refund' | 'full_refund';

export interface SmmPremiumGeneration {
  id: string;
  videoId: string;
  userId: string;
  genre: PremiumGenre;
  sceneCount: number;
  tokensCharged: number;
  tokensRefunded: number;
  status: PremiumGenStatus;
  internalCostCents: number | null;
  createdAt: Date;
  completedAt: Date | null;
}

export function rowToPremiumGen(row: any): SmmPremiumGeneration {
  return {
    id: row.id,
    videoId: row.video_id,
    userId: row.user_id,
    genre: row.genre,
    sceneCount: row.scene_count,
    tokensCharged: row.tokens_charged,
    tokensRefunded: row.tokens_refunded,
    status: row.status,
    internalCostCents: row.internal_cost_cents ?? null,
    createdAt: row.created_at,
    completedAt: row.completed_at ?? null,
  };
}
