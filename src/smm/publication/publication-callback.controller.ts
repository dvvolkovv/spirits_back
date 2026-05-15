// src/smm/publication/publication-callback.controller.ts
import {
  BadRequestException, Body, Controller, Logger, NotFoundException, Post,
  UseGuards, UsePipes, ValidationPipe,
} from '@nestjs/common';
import { WorkerSecretGuard } from '../../common/guards/worker-secret.guard';
import { PgService } from '../../common/services/pg.service';
import { PublicationCallbackDto } from './publication-callback.dto';

@Controller('smm/internal')
@UseGuards(WorkerSecretGuard)
@UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
export class PublicationCallbackController {
  private readonly logger = new Logger(PublicationCallbackController.name);

  constructor(private readonly pg: PgService) {}

  @Post('publication-callback')
  async handleCallback(@Body() dto: PublicationCallbackDto): Promise<{ ok: true }> {
    if (dto.status === 'published') {
      if (!dto.externalUrl) throw new BadRequestException(`externalUrl required when status=published`);
      const r = await this.pg.query(
        `UPDATE smm_publication
            SET status = 'published',
                external_url = $1,
                external_post_id = $2,
                published_at = now(),
                error_message = NULL
          WHERE id = $3 RETURNING id`,
        [dto.externalUrl, dto.externalPostId ?? null, dto.publicationId],
      );
      if (r.rowCount === 0) throw new NotFoundException(`publication ${dto.publicationId}`);
      this.logger.log(`Publication ${dto.publicationId} → ${dto.externalUrl}`);
    } else {
      const r = await this.pg.query(
        `UPDATE smm_publication
            SET status = 'failed',
                error_message = $1
          WHERE id = $2 RETURNING id`,
        [dto.errorMessage ?? 'unknown error', dto.publicationId],
      );
      if (r.rowCount === 0) throw new NotFoundException(`publication ${dto.publicationId}`);
      this.logger.warn(`Publication ${dto.publicationId} failed: ${dto.errorMessage}`);
    }
    return { ok: true };
  }
}
