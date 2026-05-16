// worker/src/index.ts
import { config } from './config';
import { logger } from './logger';
import { startRenderWorker, startPublishWorker } from './consumer';
import { startCleanupCron } from './render/cleanup-cron';

async function main(): Promise<void> {
  logger.info({ apiUrl: config.apiUrl, redisUrl: config.redisUrl }, 'linkeon-smm-worker starting');
  const worker = startRenderWorker();
  const publishWorker = startPublishWorker();
  const cleanupTimer = startCleanupCron();

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutdown signal received');
    clearInterval(cleanupTimer);
    try {
      await worker.close();
    } catch (e: any) {
      logger.warn({ err: e.message }, 'worker close error');
    }
    try {
      await publishWorker.close();
    } catch (e: any) {
      logger.warn({ err: e.message }, 'publish worker close error');
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  logger.info('linkeon-smm-worker ready, consuming smm-render + smm-publish queues');
}

main().catch((err) => {
  logger.fatal({ err: err.message, stack: err.stack }, 'fatal worker startup error');
  process.exit(1);
});
