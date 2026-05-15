// worker/src/publish/pipeline.ts
import { apiClient } from '../api-client';
import { logger } from '../logger';
import { Platform, Publisher } from './publisher.interface';
import { telegramPublisher } from './publishers/telegram.publisher';
import { vkPublisher } from './publishers/vk.publisher';
import { youtubePublisher } from './publishers/youtube.publisher';
import { tiktokPublisher } from './publishers/tiktok.publisher';
import { instagramPublisher } from './publishers/instagram.publisher';

const PUBLISHERS: Record<Platform, Publisher> = {
  telegram: telegramPublisher,
  vk: vkPublisher,
  youtube: youtubePublisher,
  tiktok: tiktokPublisher,
  instagram: instagramPublisher,
};

export interface PipelineInput {
  publicationId: string;
}

export interface PipelineResult {
  status: 'published' | 'failed';
  externalUrl?: string;
  externalPostId?: string;
  errorMessage?: string;
}

export async function runPublishPipeline(input: PipelineInput): Promise<PipelineResult> {
  try {
    const ctx = await apiClient.getPublicationContext(input.publicationId);
    if (!ctx.video.mp4Url) {
      throw new Error(`video has no mp4_url (status not ready)`);
    }
    const publisher = PUBLISHERS[ctx.publication.platform];
    if (!publisher) throw new Error(`no publisher for platform ${ctx.publication.platform}`);

    logger.info(
      { publicationId: input.publicationId, platform: ctx.publication.platform,
        videoUrl: ctx.video.mp4Url, account: ctx.account.displayName },
      'publish pipeline start',
    );

    const result = await publisher.publish({
      platform: ctx.publication.platform,
      credentials: ctx.account.credentials,
      videoUrl: ctx.video.mp4Url,
      caption: ctx.publication.caption,
      accountDisplayName: ctx.account.displayName,
    });

    logger.info(
      { publicationId: input.publicationId, externalUrl: result.externalUrl },
      'publish pipeline ok',
    );
    return {
      status: 'published',
      externalUrl: result.externalUrl,
      externalPostId: result.externalPostId,
    };
  } catch (err: any) {
    logger.error(
      { publicationId: input.publicationId, err: err.message },
      'publish pipeline failed',
    );
    return { status: 'failed', errorMessage: err.message };
  }
}
