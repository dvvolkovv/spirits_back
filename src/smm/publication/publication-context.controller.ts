// src/smm/publication/publication-context.controller.ts
import { Controller, Get, NotFoundException, Param, UseGuards } from '@nestjs/common';
import { WorkerSecretGuard } from '../../common/guards/worker-secret.guard';
import { PgService } from '../../common/services/pg.service';
import { decryptCredentials } from '../social-accounts/credentials.crypto';
import { rowToPublication } from '../entities/smm-publication.entity';
import { rowToVideo } from '../entities/smm-video.entity';

@Controller('smm/internal')
@UseGuards(WorkerSecretGuard)
export class PublicationContextController {
  constructor(private readonly pg: PgService) {}

  /**
   * Returns everything the worker needs to publish:
   *   - publication row (with platform, caption, scheduled_at, ...)
   *   - video row (with mp4_url)
   *   - social account (decrypted credentials)
   */
  @Get('publication-context/:publicationId')
  async getContext(@Param('publicationId') publicationId: string): Promise<{
    publication: ReturnType<typeof rowToPublication>;
    video: ReturnType<typeof rowToVideo>;
    account: { id: string; platform: string; displayName: string; credentials: Record<string, unknown> };
  }> {
    const pRes = await this.pg.query(
      `SELECT * FROM smm_publication WHERE id = $1`, [publicationId],
    );
    if (pRes.rows.length === 0) throw new NotFoundException(`publication ${publicationId} not found`);
    const publication = rowToPublication(pRes.rows[0]);

    const vRes = await this.pg.query(
      `SELECT v.*, c.user_id
         FROM smm_video v
         JOIN smm_scenario s ON s.id = v.scenario_id
         JOIN smm_campaign c ON c.id = s.campaign_id
        WHERE v.id = $1`, [publication.videoId],
    );
    if (vRes.rows.length === 0) throw new NotFoundException(`video ${publication.videoId} not found`);
    const videoRow = vRes.rows[0];
    const video = rowToVideo(videoRow);
    const userId: string = videoRow.user_id;

    // Pick the active social account for this user + platform.
    // NULL user_id = global account (Phase 1A); takes lower priority than user-specific.
    const aRes = await this.pg.query(
      `SELECT id, platform, display_name, credentials
         FROM smm_social_account
        WHERE platform = $1 AND status = 'active'
          AND (user_id = $2 OR user_id IS NULL)
        ORDER BY user_id NULLS LAST LIMIT 1`,
      [publication.platform, userId],
    );
    if (aRes.rows.length === 0) {
      throw new NotFoundException(`no active ${publication.platform} account for user ${userId}`);
    }
    const accountRow = aRes.rows[0];
    const credentials = decryptCredentials(accountRow.credentials);

    return {
      publication,
      video,
      account: {
        id: accountRow.id,
        platform: accountRow.platform,
        displayName: accountRow.display_name,
        credentials,
      },
    };
  }
}
