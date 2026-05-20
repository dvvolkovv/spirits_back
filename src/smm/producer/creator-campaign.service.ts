// src/smm/producer/creator-campaign.service.ts
import { Injectable } from '@nestjs/common';
import { PgService } from '../../common/services/pg.service';
import {
  SmmCreatorCampaign,
  SmmCreatorVoiceGender,
  SmmCreatorGenre,
  rowToCreatorCampaign,
} from '../entities/smm-creator-campaign.entity';

export interface UpsertCreatorCampaignInput {
  campaignId: string;
  ctaHandle: string;
  ctaLabel?: string;
  voiceGender: SmmCreatorVoiceGender;
  genre?: SmmCreatorGenre;
}

@Injectable()
export class CreatorCampaignService {
  constructor(private readonly pg: PgService) {}

  /**
   * Insert or update creator-mode settings (CTA, voice gender, genre) for a campaign.
   * Defaults: ctaLabel='Подписывайся', genre='dialog' — applied at DB level via
   * column defaults if not provided.
   */
  async upsert(input: UpsertCreatorCampaignInput): Promise<SmmCreatorCampaign> {
    const r = await this.pg.query(
      `INSERT INTO smm_creator_campaign
         (campaign_id, cta_handle, cta_label, voice_gender, genre)
       VALUES ($1, $2, COALESCE($3, 'Подписывайся'), $4, COALESCE($5, 'dialog'))
       ON CONFLICT (campaign_id) DO UPDATE SET
         cta_handle = EXCLUDED.cta_handle,
         cta_label = EXCLUDED.cta_label,
         voice_gender = EXCLUDED.voice_gender,
         genre = EXCLUDED.genre,
         updated_at = now()
       RETURNING *`,
      [input.campaignId, input.ctaHandle, input.ctaLabel ?? null, input.voiceGender, input.genre ?? null],
    );
    return rowToCreatorCampaign(r.rows[0]);
  }

  async getByCampaign(campaignId: string): Promise<SmmCreatorCampaign | null> {
    const r = await this.pg.query(
      `SELECT * FROM smm_creator_campaign WHERE campaign_id = $1`,
      [campaignId],
    );
    return r.rows[0] ? rowToCreatorCampaign(r.rows[0]) : null;
  }
}
