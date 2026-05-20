import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { StorageService } from '../common/services/storage.service';

const ASSETS_BUCKET = 'linkeon-assets';

@Injectable()
export class AvatarService {
  private readonly logger = new Logger(AvatarService.name);

  constructor(
    private readonly pg: PgService,
    private readonly storage: StorageService,
  ) {}

  async getAvatar(userId: string): Promise<{ url: string } | null> {
    // Check profile_data first — holds canonical avatar URL (now a MinIO link).
    const res = await this.pg.query(
      'SELECT profile_data FROM ai_profiles_consolidated WHERE user_id = $1',
      [userId],
    );
    const avatarUrl = res.rows[0]?.profile_data?.avatar_url;
    if (avatarUrl) return { url: avatarUrl };

    // Legacy fallback: local file from before the MinIO migration.
    const path = require('path');
    const fs = require('fs');
    const localPath = path.join(process.cwd(), 'public', 'avatars', `${userId}.jpg`);
    if (fs.existsSync(localPath)) {
      return { url: `/static/avatars/${userId}.jpg` };
    }
    return null;
  }

  async uploadAvatar(userId: string, buffer: Buffer, mimetype: string): Promise<{ url: string }> {
    const ext = /png/i.test(mimetype) ? 'png'
      : /webp/i.test(mimetype) ? 'webp'
      : 'jpg';
    const url = await this.storage.upload({
      bucket: ASSETS_BUCKET,
      key: `avatars/users/${userId}.${ext}`,
      body: buffer,
      contentType: mimetype || 'image/jpeg',
      cacheControl: 'public, max-age=2592000',
    });

    await this.pg.query(
      `UPDATE ai_profiles_consolidated
       SET profile_data = COALESCE(profile_data, '{}'::jsonb) || $1::jsonb,
           updated_at = now()
       WHERE user_id = $2`,
      [JSON.stringify({ avatar_url: url }), userId],
    );
    return { url };
  }

  async getAgentAvatar(agentId: string): Promise<string | null> {
    // After backfill all agent avatars live in MinIO at the canonical path.
    // Return the URL directly without HEAD/list checks (one extra S3 round-trip
    // per avatar request is too costly when N agents render simultaneously).
    // If the object doesn't exist, MinIO returns 404 and the frontend `<img onError>`
    // handler hides the broken image (see AssistantSelection.tsx).
    return this.storage.publicUrl(ASSETS_BUCKET, `avatars/agents/${agentId}.jpg`);
  }
}
