// src/smm/publication/publish-queue.service.ts
import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Queue, JobsOptions } from 'bullmq';
import { SmmPlatform } from '../entities/smm-publication.entity';

export interface PublishJobPayload {
  publicationId: string;
  videoId: string;
  platform: SmmPlatform;
}

@Injectable()
export class PublishQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PublishQueueService.name);
  private queue!: Queue<PublishJobPayload>;

  onModuleInit(): void {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) throw new Error('REDIS_URL is not set');
    this.queue = new Queue<PublishJobPayload>('smm-publish', {
      connection: this.parseRedisUrl(redisUrl),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { age: 3600 * 24 * 7, count: 1000 },
        removeOnFail: { age: 3600 * 24 * 30 },
      },
    });
    this.logger.log('PublishQueueService initialized: queue=smm-publish');
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue?.close();
  }

  async enqueue(
    payload: PublishJobPayload,
    options?: JobsOptions,
  ): Promise<string> {
    const job = await this.queue.add(`publish:${payload.platform}:${payload.publicationId}`, payload, options);
    return job.id as string;
  }

  async cancel(jobId: string): Promise<boolean> {
    const job = await this.queue.getJob(jobId);
    if (!job) return false;
    await job.remove();
    return true;
  }

  async getJobState(jobId: string): Promise<string | null> {
    const job = await this.queue.getJob(jobId);
    if (!job) return null;
    return await job.getState();
  }

  getQueue(): Queue<PublishJobPayload> {
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
