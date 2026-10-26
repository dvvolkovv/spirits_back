import 'dotenv/config';
import path from 'node:path';
import pg from 'pg';
import { captureScene } from '../capture/run-capture';
import { parseConfig } from '../config';
import { renderRun } from '../render/run-render';
import { pgQueue } from './db';
import { pruneOld, runOne, type JobDeps } from './jobs';
import { s3Storage } from './storage';

/**
 * Рабочий процесс студии: забирает задания capture и render из short_video,
 * по одному за раз (спека: «по одному заданию за раз»).
 *   npm run worker            — цикл; без заданий — пауза IDLE_MS
 *   npm run worker -- --once  — одно задание и выход (стенд в плане 2)
 * SIGTERM/SIGINT — дождаться текущего задания и выйти; брошенное задание
 * вернётся в очередь по истечении аренды.
 */
const IDLE_MS = 15_000;
const KEEP_DAYS = 7;

const cfg = parseConfig(process.env, { capture: true, tts: true, worker: true });
const pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: 2 });
const log = (line: string): void => console.log(`${new Date().toISOString()} ${line}`);
const deps: JobDeps = {
  queue: pgQueue(pool),
  storage: s3Storage(cfg.minio!),
  workRoot: path.resolve('out', 'jobs'),
  capture: (scene, runDir, minAnswerChars) => captureScene(scene, cfg, runDir, minAnswerChars),
  render: (runDir) => renderRun(runDir),
  log,
};

let stopping = false;
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    stopping = true;
    log(`worker: ${sig} — закончу текущее задание и выйду`);
  });
}

const once = process.argv.includes('--once');
const pruned = pruneOld(deps.workRoot, KEEP_DAYS);
if (pruned) log(`worker: удалено старых рабочих папок — ${pruned}`);
log(`worker: старт${once ? ' (одно задание)' : ''}`);
try {
  while (!stopping) {
    const did = await runOne(deps);
    if (once) {
      if (!did) log('worker: заданий нет');
      break;
    }
    if (!did) await new Promise((resolve) => setTimeout(resolve, IDLE_MS));
  }
} finally {
  await pool.end();
}
// Браузер съёмки и рендер могли оставить хэндлы — выходим явно.
process.exit(0);
