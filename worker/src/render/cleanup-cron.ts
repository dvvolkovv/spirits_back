// worker/src/render/cleanup-cron.ts
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { logger } from '../logger';

const SEVEN_DAYS_MS = 7 * 24 * 3600 * 1000;

export async function cleanupOldTempDirs(): Promise<void> {
  const tmpRoot = os.tmpdir();
  const entries = await fs.readdir(tmpRoot);
  const now = Date.now();
  for (const name of entries) {
    if (!name.startsWith('smm-job-')) continue;
    const full = path.join(tmpRoot, name);
    try {
      const stat = await fs.stat(full);
      if (now - stat.mtimeMs > SEVEN_DAYS_MS) {
        await fs.rm(full, { recursive: true, force: true });
        logger.info({ path: full }, 'cleaned up aged job dir');
      }
    } catch { /* ignore */ }
  }
}

export function startCleanupCron(): NodeJS.Timeout {
  // Run once at startup, then every 12 hours
  cleanupOldTempDirs().catch((e) => logger.warn({ err: e.message }, 'cleanup error'));
  return setInterval(() => {
    cleanupOldTempDirs().catch((e) => logger.warn({ err: e.message }, 'cleanup error'));
  }, 12 * 3600 * 1000);
}
