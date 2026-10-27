import 'dotenv/config';
import path from 'node:path';
import pg from 'pg';
import { generateKeyframe, startClip, waitClip, type GoogleDeps } from '../animate/google';
import { animateRun } from '../animate/run-animate';
import { recognize } from '../animate/stt';
import { captureScene } from '../capture/run-capture';
import { parseConfig } from '../config';
import { renderRun } from '../render/run-render';
import { LEASE_MINUTES, pgQueue } from './db';
import { pruneOld, runOne, type JobDeps } from './jobs';
import { watchStop } from './stop';
import { s3Storage } from './storage';

/**
 * Рабочий процесс студии: забирает задания capture, animate и render из
 * short_video, по одному за раз (спека: «по одному заданию за раз»). Оживлению
 * нужен ключ Google (GOOGLE_AI_API_KEY): без него процесс не стартует — громче,
 * чем ролики, молча падающие на этапе animate.
 *   npm run worker            — цикл; без заданий — пауза IDLE_MS
 *   npm run worker -- --once  — одно задание и выход (стенд в плане 2)
 * Остановка (сообщение shutdown от PM2, вручную — SIGTERM/SIGINT; stop.ts) —
 * дождаться текущего задания и выйти; брошенное задание вернётся в очередь по
 * истечении аренды.
 */
const IDLE_MS = 15_000;
const KEEP_DAYS = 7;
/**
 * Срок одного задания — на 2 минуты короче аренды. Зависший рендер или съёмку
 * изнутри не прервать (Chromium, Remotion), поэтому по сроку процесс выходит:
 * раньше, чем аренда истечёт и задание заберёт другой процесс, — двух сборок
 * одного ролика сразу не бывает. Задание вернётся в очередь по истечении
 * аренды, третья такая попытка уйдёт в failed (claimJob, db.ts).
 */
const JOB_DEADLINE_MS = (LEASE_MINUTES - 2) * 60_000;

const cfg = parseConfig(process.env, { capture: true, tts: true, worker: true, animate: true });
const google: GoogleDeps = { apiKey: cfg.googleKey };
const stt = { apiKey: cfg.speechkitKey, folderId: cfg.speechkitFolder };
const pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: 2 });
const log = (line: string): void => console.log(`${new Date().toISOString()} ${line}`);
const deps: JobDeps = {
  queue: pgQueue(pool),
  storage: s3Storage(cfg.minio!),
  workRoot: path.resolve('out', 'jobs'),
  capture: (scene, runDir, minAnswerChars) => captureScene(scene, cfg, runDir, minAnswerChars),
  animate: (runDir, hooks) =>
    animateRun(runDir, {
      keyframe: (prompt, refs) => generateKeyframe(google, prompt, refs),
      startClip: (prompt, image) => startClip(google, prompt, image),
      waitClip: (id) => waitClip(google, id),
      recognize: (ogg) => recognize(ogg, stt),
      maxOmniSeconds: hooks.maxOmniSeconds,
      onSave: hooks.onSave,
      onFile: hooks.onFile,
      onDiscard: hooks.onDiscard,
      log,
    }),
  render: (runDir) => renderRun(runDir),
  log,
};

const stopping = watchStop(process, log);

const once = process.argv.includes('--once');
const pruned = pruneOld(deps.workRoot, KEEP_DAYS);
if (pruned) log(`worker: удалено старых рабочих папок — ${pruned}`);
log(`worker: старт${once ? ' (одно задание)' : ''}`);
try {
  while (!stopping()) {
    const deadline = setTimeout(() => {
      log(`worker: задание не уложилось в ${LEASE_MINUTES - 2} мин — выхожу, задание вернётся в очередь по истечении аренды`);
      process.exit(1);
    }, JOB_DEADLINE_MS);
    let did: boolean;
    try {
      did = await runOne(deps);
    } finally {
      clearTimeout(deadline);
    }
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
