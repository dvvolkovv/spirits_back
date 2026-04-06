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
    const res = await this.pg.query(
      'SELECT profile_data FROM ai_profiles_consolidated WHERE user_id = $1',
      [userId],
    );
    const avatarUrl = res.rows[0]?.profile_data?.avatar_url;
    if (!avatarUrl) return null;
    return { url: avatarUrl };
  }

  async uploadAvatar(userId: string, buffer: Buffer, mimetype: string): Promise<{ url: string }> {
    if (!this.s3 || !process.env.AWS_S3_BUCKET) {
      throw new Error('S3 not configured');
    }
    const key = `avatars/${userId}.jpg`;
    await this.s3.send(new PutObjectCommand({
      Bucket: process.env.AWS_S3_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: mimetype,
    }));
    const url = `https://${process.env.AWS_S3_BUCKET}.s3.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com/${key}`;
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
    // agents table has no avatar_url column
    return null;
  }
}
