import fs from 'node:fs';
import path from 'node:path';
import { StudioError, toStudioError } from '../errors';
import type { RenderResult } from '../render/run-render';
import type { CaptureResult, Scene } from '../types';
import type { Job, JobKind, Queue } from './db';
import type { Storage } from './storage';

export interface JobDeps {
  queue: Queue;
  storage: Storage;
  /** Рабочие папки заданий: <workRoot>/<id>/capture-<попытка>, render-<попытка>. */
  workRoot: string;
  capture: (scene: Scene, runDir: string, minAnswerChars: number) => Promise<CaptureResult>;
  render: (runDir: string) => Promise<RenderResult>;
  log: (line: string) => void;
}

/** Ключи MinIO — контракт с API: видео и обложку он шлёт в Telegram отсюда. */
export const shotKey = (id: string, attempt: number, name: string): string => `shorts/${id}/capture-${attempt}/${name}`;
export const videoKey = (id: string): string => `shorts/${id}/video.mp4`;
export const coverKey = (id: string): string => `shorts/${id}/cover.jpg`;

/** Итог или сбой не записан: аренда истекла, и задание теперь не за этим захватом. */
const GONE = 'задание забрал другой процесс — итог не записан';

/** @returns false — итог не записан: задание забрал другой процесс */
export async function runCapture(job: Job, d: JobDeps): Promise<boolean> {
  if (!job.scene) throw new StudioError('no_input', 'у ролика нет сцены', false);
  const runDir = path.join(d.workRoot, job.id, `capture-${job.attempts}`);
  const result = await d.capture(job.scene, runDir, await d.queue.minAnswerChars());
  const questionShotKey = shotKey(job.id, job.attempts, 'question.png');
  const answerShotKey = shotKey(job.id, job.attempts, 'answer.png');
  await d.storage.put(questionShotKey, path.join(runDir, result.questionShot), 'image/png');
  await d.storage.put(answerShotKey, path.join(runDir, result.answerShot), 'image/png');
  const { questionShot: _q, answerShot: _a, ...rest } = result;
  return d.queue.completeCapture(job, { ...rest, questionShotKey, answerShotKey });
}

/** @returns false — итог не записан: задание забрал другой процесс */
export async function runRender(job: Job, d: JobDeps): Promise<boolean> {
  if (!job.capture || !job.script) throw new StudioError('no_input', 'у ролика нет съёмки или сценария', false);
  const runDir = path.join(d.workRoot, job.id, `render-${job.attempts}`);
  fs.mkdirSync(runDir, { recursive: true });
  await d.storage.get(job.capture.questionShotKey, path.join(runDir, 'question.png'));
  await d.storage.get(job.capture.answerShotKey, path.join(runDir, 'answer.png'));
  const { questionShotKey: _q, answerShotKey: _a, ...rest } = job.capture;
  fs.writeFileSync(path.join(runDir, 'capture.json'), JSON.stringify({ ...rest, questionShot: 'question.png', answerShot: 'answer.png' }, null, 2));
  fs.writeFileSync(path.join(runDir, 'script.json'), JSON.stringify(job.script, null, 2));

  const r = await d.render(runDir);
  if (r.problems.length) throw new StudioError('video_invalid', `проверка файла не прошла: ${r.problems.join('; ')}`, true);
  await d.storage.put(videoKey(job.id), r.video, 'video/mp4');
  await d.storage.put(coverKey(job.id), r.cover, 'image/jpeg');
  const out = { videoKey: videoKey(job.id), coverKey: coverKey(job.id), durationMs: Math.round(r.durationSec * 1000) };
  return d.queue.completeRender(job, out);
}

/** Сборка — первой: ролик ближе к концу пути и к владельцу. */
const ORDER: JobKind[] = ['render', 'capture'];

/** Одно задание: взять, выполнить, при сбое — отдать очереди с кодом. @returns false — заданий нет */
export async function runOne(d: JobDeps): Promise<boolean> {
  for (const kind of ORDER) {
    const job = await d.queue.claim(kind);
    if (!job) continue;
    d.log(`${kind} ${job.id}: попытка ${job.attempts}`);
    try {
      const written = kind === 'capture' ? await runCapture(job, d) : await runRender(job, d);
      d.log(`${kind} ${job.id}: ${written ? 'готово' : GONE}`);
    } catch (e) {
      const err = toStudioError(e);
      const outcome = await d.queue.fail(job, err);
      d.log(`${kind} ${job.id}: ${err.code} — ${err.message} → ${outcome === 'gone' ? GONE : outcome}`);
    }
    return true;
  }
  return false;
}

/** Рабочие папки заданий старше days — удалить. @returns сколько удалено */
export function pruneOld(workRoot: string, days: number, now = Date.now()): number {
  if (!fs.existsSync(workRoot)) return 0;
  let removed = 0;
  for (const name of fs.readdirSync(workRoot)) {
    const dir = path.join(workRoot, name);
    const st = fs.statSync(dir);
    if (st.isDirectory() && now - st.mtimeMs > days * 86_400_000) {
      fs.rmSync(dir, { recursive: true, force: true });
      removed += 1;
    }
  }
  return removed;
}
