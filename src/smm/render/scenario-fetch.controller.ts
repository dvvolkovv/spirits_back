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

export interface RenderJobContext {
  video: SmmVideo;
  scenario: SmmScenario;
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

    return { video, scenario };
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
