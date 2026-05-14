// src/smm/render/render-queue.service.ts
import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Queue, JobsOptions } from 'bullmq';

export interface RenderJobPayload {
  videoId: string;
  scenarioId: string;
}

@Injectable()
export class RenderQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RenderQueueService.name);
  private queue!: Queue<RenderJobPayload>;

  onModuleInit(): void {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) throw new Error('REDIS_URL is not set');
    this.queue = new Queue<RenderJobPayload>('smm-render', {
      connection: this.parseRedisUrl(redisUrl),
      defaultJobOptions: {
        attempts: 1, // worker manages own retry via render_state
        removeOnComplete: { age: 3600 * 24 * 7, count: 1000 },
        removeOnFail: { age: 3600 * 24 * 30 },
      },
    });
    this.logger.log('RenderQueueService initialized: queue=smm-render');
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue?.close();
  }

  async enqueue(
    payload: RenderJobPayload,
    options?: JobsOptions,
  ): Promise<string> {
    const job = await this.queue.add(`render:${payload.videoId}`, payload, options);
    return job.id as string;
  }

  async getJobState(jobId: string): Promise<string | null> {
    const job = await this.queue.getJob(jobId);
    if (!job) return null;
    return await job.getState();
  }

  /**
   * Internal: returns the underlying queue for advanced operations (peek/count in tests).
   */
  getQueue(): Queue<RenderJobPayload> {
    return this.queue;
  }

  private parseRedisUrl(url: string): { host: string; port: number; password?: string; db?: number } {
    const u = new URL(url);
    return {
      host: u.hostname,
      port: parseInt(u.port || '6379', 10),
      password: u.password || undefined,
      db: u.pathname && u.pathname !== '/' ? parseInt(u.pathname.slice(1), 10) : 0,
    };
  }
}
