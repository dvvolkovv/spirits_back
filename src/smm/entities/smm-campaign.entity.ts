// src/smm/entities/smm-campaign.entity.ts
export type SmmSourceMode = 'auto' | 'topic' | 'trends';
export type SmmCampaignStatus = 'drafting' | 'approved' | 'done' | 'cancelled';

export interface SmmCampaign {
  id: string;
  userId: string;
  conversationId: string | null;
  topic: string | null;
  sourceMode: SmmSourceMode;
  requestedCount: number;
  status: SmmCampaignStatus;
  createdAt: Date;
  updatedAt: Date;
}

export function rowToCampaign(row: any): SmmCampaign {
  return {
    id: row.id,
    userId: row.user_id,
    conversationId: row.conversation_id ?? null,
    topic: row.topic ?? null,
    sourceMode: row.source_mode,
    requestedCount: row.requested_count,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
