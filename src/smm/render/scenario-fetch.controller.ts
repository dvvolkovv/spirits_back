// src/smm/render/scenario-fetch.controller.ts
import {
  Controller,
  Get,
  Logger,
  NotFoundException,
  Param,
  UseGuards,
} from '@nestjs/common';
import { WorkerSecretGuard } from '../../common/guards/worker-secret.guard';
import { PgService } from '../../common/services/pg.service';
import { rowToScenario, SmmScenario } from '../entities/smm-scenario.entity';
import { rowToVideo, SmmVideo } from '../entities/smm-video.entity';

export interface RenderJobCampaignInfo {
  isLinkeonOfficial: boolean;
  ctaHandle?: string;
  ctaLabel?: string;
}

export interface RenderJobContext {
  video: SmmVideo;
  scenario: SmmScenario;
  campaign: RenderJobCampaignInfo;
}

@Controller('smm/internal')
@UseGuards(WorkerSecretGuard)
export class ScenarioFetchController {
  private readonly logger = new Logger(ScenarioFetchController.name);

  constructor(private readonly pg: PgService) {}

  @Get('render-context/:videoId')
  async getContext(@Param('videoId') videoId: string): Promise<RenderJobContext> {
    const vRes = await this.pg.query(`SELECT * FROM smm_video WHERE id = $1`, [videoId]);
    if (vRes.rows.length === 0) throw new NotFoundException(`video ${videoId} not found`);
    const video = rowToVideo(vRes.rows[0]);

    const sRes = await this.pg.query(
      `SELECT * FROM smm_scenario WHERE id = $1`,
      [video.scenarioId],
    );
    if (sRes.rows.length === 0) throw new NotFoundException(`scenario ${video.scenarioId} not found`);
    const scenario = rowToScenario(sRes.rows[0]);

    // Campaign meta: is_linkeon_official toggles CTA branding; for creator-mode
    // pull cta_handle + cta_label from smm_creator_campaign.
    const cRes = await this.pg.query(
      `SELECT is_linkeon_official FROM smm_campaign WHERE id = $1`,
      [scenario.campaignId],
    );
    if (cRes.rows.length === 0) throw new NotFoundException(`campaign ${scenario.campaignId} not found`);
    const isLinkeonOfficial = !!cRes.rows[0].is_linkeon_official;

    const campaign: RenderJobCampaignInfo = { isLinkeonOfficial };
    if (!isLinkeonOfficial) {
      const ccRes = await this.pg.query(
        `SELECT cta_handle, cta_label FROM smm_creator_campaign WHERE campaign_id = $1`,
        [scenario.campaignId],
      );
      if (ccRes.rows.length > 0) {
        campaign.ctaHandle = ccRes.rows[0].cta_handle ?? undefined;
        campaign.ctaLabel = ccRes.rows[0].cta_label ?? undefined;
      }
    }

    return { video, scenario, campaign };
  }

  @Get('music-tracks')
  async listMusicTracks(): Promise<Array<{
    id: string; title: string; mood: string; durationSec: number; publicUrl: string;
  }>> {
    const r = await this.pg.query(`SELECT * FROM smm_music_track ORDER BY mood, id`);
    const base = (process.env.MINIO_PUBLIC_URL || '').replace(/\/$/, '');
    const bucket = process.env.MINIO_BUCKET_MUSIC || 'linkeon-smm-music';
    return r.rows.map((row: any) => ({
      id: row.id,
      title: row.title,
      mood: row.mood,
      durationSec: row.duration_sec,
      publicUrl: `${base}/${bucket}/${row.storage_key}`,
    }));
  }
}
