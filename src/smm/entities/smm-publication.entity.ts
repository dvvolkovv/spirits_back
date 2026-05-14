// src/smm/entities/smm-publication.entity.ts
export type SmmPlatform =
  | 'telegram' | 'vk' | 'youtube' | 'tiktok' | 'instagram';

export type SmmPublicationStatus =
  | 'scheduled' | 'publishing' | 'published' | 'failed' | 'cancelled';

export interface SmmPublication {
  id: string;
  videoId: string;
  platform: SmmPlatform;
  scheduledAt: Date | null;
  status: SmmPublicationStatus;
  publishJobId: string | null;
  externalUrl: string | null;
  externalPostId: string | null;
  caption: string | null;
  errorMessage: string | null;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export function rowToPublication(row: any): SmmPublication {
  return {
    id: row.id,
    videoId: row.video_id,
    platform: row.platform,
    scheduledAt: row.scheduled_at ?? null,
    status: row.status,
    publishJobId: row.publish_job_id ?? null,
    externalUrl: row.external_url ?? null,
    externalPostId: row.external_post_id ?? null,
    caption: row.caption ?? null,
    errorMessage: row.error_message ?? null,
    publishedAt: row.published_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
