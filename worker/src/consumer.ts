// worker/src/consumer.ts
import { Worker, Job } from 'bullmq';
import { config } from './config';
import { logger } from './logger';
import { apiClient } from './api-client';
import { runRenderPipeline } from './render/pipeline';
import { runPublishPipeline } from './publish/pipeline';

export interface RenderJobPayload {
  videoId: string;
  scenarioId: string;
}

export interface PublishJobPayload {
  publicationId: string;
  videoId: string;
  platform: 'telegram' | 'vk' | 'youtube' | 'tiktok' | 'instagram';
}

function redisConn() {
  const u = new URL(config.redisUrl);
  return {
    host: u.hostname,
    port: parseInt(u.port || '6379', 10),
    password: u.password || undefined,
    db: u.pathname && u.pathname !== '/' ? parseInt(u.pathname.slice(1), 10) : 0,
  };
}

export function startRenderWorker(): Worker<RenderJobPayload> {
  const worker = new Worker<RenderJobPayload>(
    'smm-render',
    async (job: Job<RenderJobPayload>) => {
      logger.info({ jobId: job.id, videoId: job.data.videoId }, 'render job picked up');
      const result = await runRenderPipeline({ videoId: job.data.videoId });
      await apiClient.sendCallback({
        videoId: job.data.videoId,
        status: result.status,
        mp4Url: result.mp4Url,
        durationSec: result.durationSec,
        sizeBytes: result.sizeBytes,
        errorMessage: result.errorMessage,
      });
      return result;
    },
    {
      connection: redisConn(),
      concurrency: 2,                // 2 parallel renders (Chromium-bound)
      lockDuration: 10 * 60 * 1000,  // 10 min — Remotion can be slow
    },
  );

  worker.on('completed', (job, result) => {
    logger.info({ jobId: job.id, result }, 'render job completed');
  });
  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err: err.message }, 'render job failed');
  });
  worker.on('error', (err) => {
    logger.error({ err: err.message }, 'render worker error');
  });

  return worker;
}

export function startPublishWorker(): Worker<PublishJobPayload> {
  const worker = new Worker<PublishJobPayload>(
    'smm-publish',
    async (job: Job<PublishJobPayload>) => {
      logger.info({ jobId: job.id, publicationId: job.data.publicationId, platform: job.data.platform }, 'publish job picked up');
      const result = await runPublishPipeline({ publicationId: job.data.publicationId });
      await apiClient.sendPublicationCallback({
        publicationId: job.data.publicationId,
        status: result.status,
        externalUrl: result.externalUrl,
        externalPostId: result.externalPostId,
        errorMessage: result.errorMessage,
      });
      return result;
    },
    {
      connection: redisConn(),
      concurrency: 3,
      lockDuration: 5 * 60 * 1000,
    },
  );

  worker.on('completed', (job, result) => {
    logger.info({ jobId: job.id, result }, 'publish job completed');
  });
  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err: err.message }, 'publish job failed');
  });
  worker.on('error', (err) => {
    logger.error({ err: err.message }, 'publish worker error');
  });

  return worker;
}
