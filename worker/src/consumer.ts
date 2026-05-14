// worker/src/consumer.ts
import { Worker, Job } from 'bullmq';
import { config } from './config';
import { logger } from './logger';
import { apiClient } from './api-client';
import { runRenderPipeline } from './render/pipeline';

export interface RenderJobPayload {
  videoId: string;
  scenarioId: string;
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
