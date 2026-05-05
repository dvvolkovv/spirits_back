import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

@Injectable()
export class AvatarService {
  private readonly logger = new Logger(AvatarService.name);
  private s3: S3Client | null = null;

  constructor(private readonly pg: PgService) {
    if (process.env.AWS_ACCESS_KEY_ID) {
      const config: any = {
        region: process.env.AWS_REGION || 'us-east-1',
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        },
      };
      // MinIO / custom S3-compatible endpoint
      if (process.env.AWS_ENDPOINT) {
        config.endpoint = process.env.AWS_ENDPOINT;
        config.forcePathStyle = process.env.AWS_FORCE_PATH_STYLE === 'true';
      }
      this.s3 = new S3Client(config);
    }
  }

  async getAvatar(userId: string): Promise<{ url: string } | null> {
    // Check profile_data first
    const res = await this.pg.query(
      'SELECT profile_data FROM ai_profiles_consolidated WHERE user_id = $1',
      [userId],
    );
    const avatarUrl = res.rows[0]?.profile_data?.avatar_url;
    if (avatarUrl) return { url: avatarUrl };

    // Check local file
    const path = require('path');
    const fs = require('fs');
    const localPath = path.join(process.cwd(), 'public', 'avatars', `${userId}.jpg`);
    if (fs.existsSync(localPath)) {
      return { url: `/static/avatars/${userId}.jpg` };
    }
    return null;
  }

  async uploadAvatar(userId: string, buffer: Buffer, mimetype: string): Promise<{ url: string }> {
    const path = require('path');
    const fs = require('fs');

    // Save locally
    const dir = path.join(process.cwd(), 'public', 'avatars');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const filename = `${userId}.jpg`;
    fs.writeFileSync(path.join(dir, filename), buffer);
    const url = `/static/avatars/${filename}`;

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
    const path = require('path');
    const fs = require('fs');
    const localPath = path.join(process.cwd(), 'public', 'agent-avatars', `${agentId}.jpg`);
    if (fs.existsSync(localPath)) {
      return `/static/agent-avatars/${agentId}.jpg`;
    }
    return null;
  }
}
