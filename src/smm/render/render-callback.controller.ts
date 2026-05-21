// src/smm/render/render-callback.controller.ts
import {
  BadRequestException,
  Body,
  Controller,
  Logger,
  NotFoundException,
  Post,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { WorkerSecretGuard } from '../../common/guards/worker-secret.guard';
import { PgService } from '../../common/services/pg.service';
import { SmmBillingService } from '../billing/smm-billing.service';
import { RenderCallbackDto, RenderStateUpdateDto } from './render-callback.dto';

@Controller('smm/internal')
@UseGuards(WorkerSecretGuard)
@UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
export class RenderCallbackController {
  private readonly logger = new Logger(RenderCallbackController.name);

  constructor(
    private readonly pg: PgService,
    private readonly billing: SmmBillingService,
  ) {}

  @Post('render-state')
  async updateRenderState(@Body() dto: RenderStateUpdateDto): Promise<{ ok: true }> {
    const res = await this.pg.query(
      `UPDATE smm_video SET render_state = $1::jsonb, status = 'rendering'
       WHERE id = $2 RETURNING id`,
      [JSON.stringify(dto.renderState), dto.videoId],
    );
    if (res.rowCount === 0) throw new NotFoundException(`video ${dto.videoId} not found`);
    return { ok: true };
  }

  @Post('render-callback')
  async handleCallback(@Body() dto: RenderCallbackDto): Promise<{ ok: true }> {
    if (dto.status === 'ready') {
      if (!dto.mp4Url) throw new BadRequestException('mp4Url required when status=ready');
      const res = await this.pg.query(
        `UPDATE smm_video
            SET status = 'ready', mp4_url = $1, duration_sec = $2,
                size_bytes = $3, error_message = NULL
          WHERE id = $4 RETURNING id`,
        [dto.mp4Url, dto.durationSec ?? null, dto.sizeBytes ?? null, dto.videoId],
      );
      if (res.rowCount === 0) throw new NotFoundException(`video ${dto.videoId} not found`);
      this.logger.log(`Video ${dto.videoId} marked ready: ${dto.mp4Url}`);
    } else if (dto.status === 'escape_hatch_offered') {
      // Premium pipeline исчерпал 3 retries на одной из kling-сцен.
      // Не refund'им — юзер сам выберет действие через POST /videos/:id/escape-hatch.
      const res = await this.pg.query(
        `UPDATE smm_video
            SET status = 'escape_hatch_offered',
                render_state = jsonb_set(
                  coalesce(render_state, '{}'::jsonb),
                  '{escape_hatch}',
                  $1::jsonb
                )
          WHERE id = $2 RETURNING id`,
        [JSON.stringify(dto.escapeHatch ?? {}), dto.videoId],
      );
      if (res.rowCount === 0) throw new NotFoundException(`video ${dto.videoId} not found`);
      this.logger.log(`Video ${dto.videoId} escape hatch offered: ${JSON.stringify(dto.escapeHatch)}`);
    } else {
      const res = await this.pg.query(
        `UPDATE smm_video SET status = 'failed', error_message = $1
          WHERE id = $2 RETURNING id`,
        [dto.errorMessage ?? 'unknown render error', dto.videoId],
      );
      if (res.rowCount === 0) throw new NotFoundException(`video ${dto.videoId} not found`);
      await this.billing.refund({ videoId: dto.videoId, reason: 'render_failed' });
      this.logger.warn(`Video ${dto.videoId} marked failed, tokens refunded`);
    }
    return { ok: true };
  }
}
