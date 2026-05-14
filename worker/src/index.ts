// worker/src/index.ts
import { config } from './config';
import { logger } from './logger';

async function main(): Promise<void> {
  logger.info({ apiUrl: config.apiUrl, redisUrl: config.redisUrl }, 'linkeon-smm-worker starting');
  // Consumer registration is added in Task 13. For now just verify config loads.
  logger.info('Worker ready (consumer not yet attached — see Task 13)');
}

main().catch((err) => {
  logger.fatal({ err: err.message }, 'fatal worker startup error');
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down');
  process.exit(0);
});
process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down');
  process.exit(0);
});
