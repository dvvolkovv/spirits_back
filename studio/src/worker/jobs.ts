import fs from 'node:fs';
import path from 'node:path';
import { StudioError, toStudioError } from '../errors';
import type { RenderResult } from '../render/run-render';
import { validateScript } from '../script';
import { SKIT_KINDS, type CaptureResult, type Scene, type ShortAnimation } from '../types';
import type { Job, JobKind, Queue } from './db';
import type { Storage } from './storage';

/** Что задание animate получает от рабочего процесса: предел секунд Omni и куда сохранять по ходу. */
export interface AnimateHooks {
  maxOmniSeconds: number;
  onSave(anim: ShortAnimation): Promise<void>;
  onFile(rel: string): Promise<void>;
  onDiscard(rel: string): Promise<void>;
}

/**
 * Паузы перед повторами записи animation в базу. Сбой записи id генерации —
 * не «задание не наше»: без повтора «Повторить» заплатило бы за запущенный клип.
 */
export const SAVE_RETRY_DELAYS_MS = [1_000, 3_000];

export interface JobDeps {
  queue: Queue;
  storage: Storage;
  /** Рабочие папки заданий: <workRoot>/<id>/capture-<попытка>, render-<попытка>, animate (одна на все попытки). */
  workRoot: string;
  capture: (scene: Scene, runDir: string, minAnswerChars: number) => Promise<CaptureResult>;
  animate: (runDir: string, hooks: AnimateHooks) => Promise<ShortAnimation>;
  render: (runDir: string) => Promise<RenderResult>;
  log: (line: string) => void;
  /** Паузы повторов записи animation в базу; по умолчанию SAVE_RETRY_DELAYS_MS (тестам — короче). */
  saveRetryDelaysMs?: number[];
}

/** Ключи MinIO — контракт с API: видео и обложку он шлёт в Telegram отсюда. */
export const shotKey = (id: string, attempt: number, name: string): string => `shorts/${id}/capture-${attempt}/${name}`;
export const videoKey = (id: string): string => `shorts/${id}/video.mp4`;
export const coverKey = (id: string): string => `shorts/${id}/cover.jpg`;
/** Кадры и клипы сценок — по путям папки оживления (animation.json): shorts/<id>/keyframes/…, shorts/<id>/skits/<отпечаток>/…. */
export const animationKey = (id: string, rel: string): string => `shorts/${id}/${rel}`;

const CONTENT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.mp4': 'video/mp4', '.ogg': 'audio/ogg',
};
const contentType = (rel: string): string => CONTENT_TYPES[path.extname(rel)] ?? 'application/octet-stream';
/** Расширения кадра: Nano Banana Pro отдаёт JPEG, но тип решает картинка (run-animate.ts, KEYFRAME_EXT). */
const KEYFRAME_EXTS = ['jpg', 'png', 'webp'];

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
  if (job.script.skits) {
    // Ролик со сценками: клипы — из MinIO по animation; нет записи сценки — назовёт сборка (buildSkitProps).
    if (!job.animation) throw new StudioError('no_input', 'у ролика со сценками нет оживления — сначала задание animate', false);
    fs.writeFileSync(path.join(runDir, 'animation.json'), JSON.stringify(job.animation, null, 2));
    for (const kind of SKIT_KINDS) {
      const c = job.animation.skits?.[kind];
      if (!c) continue;
      const dest = path.join(runDir, c.clip);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      await d.storage.get(animationKey(job.id, c.clip), dest);
    }
  }

  const r = await d.render(runDir);
  if (r.problems.length) throw new StudioError('video_invalid', `проверка файла не прошла: ${r.problems.join('; ')}`, true);
  await d.storage.put(videoKey(job.id), r.video, 'video/mp4');
  await d.storage.put(coverKey(job.id), r.cover, 'image/jpeg');
  const out = { videoKey: videoKey(job.id), coverKey: coverKey(job.id), durationMs: Math.round(r.durationSec * 1000) };
  return d.queue.completeRender(job, out);
}

/**
 * Папка оживления из MinIO: кадры и клипы сценок этого сценария, которых в ней
 * нет (другой сервер, чистка старых папок). Готовое по отпечатку не
 * переделывается, а оплаченный raw.mp4 не снимается заново.
 */
async function restoreAnimation(job: Job, runDir: string, storage: Storage): Promise<void> {
  const skits = job.script!.skits!;
  const want = new Set<string>();
  for (const kind of SKIT_KINDS) {
    const p = skits[kind];
    for (const ext of KEYFRAME_EXTS) want.add(`keyframes/${p.keyframeFingerprint}.${ext}`);
    want.add(`skits/${p.fingerprint}/raw.mp4`);
    want.add(`skits/${p.fingerprint}/clip.mp4`);
  }
  for (const rel of want) {
    const dest = path.join(runDir, rel);
    if (fs.existsSync(dest)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    await storage.getIfExists(animationKey(job.id, rel), dest);
  }
}

/**
 * animation из базы — и id генерации из своей папки, которого в базе нет: запись
 * id после запуска не дошла до базы (сбой), а генерация оплачена. Берётся только
 * id под нынешний отпечаток сценки, у которой нет ни id в базе, ни принятого клипа.
 * Резерв секунд под него в базе уже есть: он пишется до запуска.
 */
function withLocalPending(job: Job, animPath: string): ShortAnimation {
  const merged: ShortAnimation = { ...job.animation!, pending: { ...job.animation!.pending } };
  let local: ShortAnimation['pending'] = {};
  try {
    local = JSON.parse(fs.readFileSync(animPath, 'utf8'))?.pending ?? {};
  } catch {
    return merged;
  }
  for (const kind of SKIT_KINDS) {
    const fp = job.script!.skits![kind].fingerprint;
    const lp = local?.[kind];
    if (lp?.fingerprint === fp && !merged.pending![kind] && merged.skits?.[kind]?.fingerprint !== fp) merged.pending![kind] = lp;
  }
  return merged;
}

/**
 * Оживление сценок (studio/src/animate/run-animate.ts). Счёт денег — из базы:
 * локальный animation.json перезаписывается её версией (плюс id генерации,
 * не дошедший до базы, — withLocalPending). По ходу задание сохраняет animation
 * в базу (резерв секунд, id генерации), кладёт новые файлы в MinIO и удаляет
 * оттуда брак — падение процесса не стоит новой оплаты.
 * @returns false — итог не записан: задание забрал другой процесс
 */
export async function runAnimate(job: Job, d: JobDeps): Promise<boolean> {
  if (!job.script?.skits || !job.capture) throw new StudioError('no_input', 'у ролика нет сценок или съёмки', false);
  const problems = validateScript(job.script, job.capture);
  if (problems.length) throw new StudioError('script_invalid', `сценарий не прошёл проверку:\n- ${problems.join('\n- ')}`, false);
  // Одна папка на все попытки: готовые кадры и клипы переживают повтор задания.
  const runDir = path.join(d.workRoot, job.id, 'animate');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'script.json'), JSON.stringify(job.script, null, 2));
  const animPath = path.join(runDir, 'animation.json');
  if (job.animation) fs.writeFileSync(animPath, JSON.stringify(withLocalPending(job, animPath), null, 2));
  else fs.rmSync(animPath, { force: true });
  await restoreAnimation(job, runDir, d.storage);
  const delays = d.saveRetryDelaysMs ?? SAVE_RETRY_DELAYS_MS;
  const animation = await d.animate(runDir, {
    maxOmniSeconds: await d.queue.maxOmniSeconds(),
    // false — задание не наше, без повтора; брошенная ошибка — сбой базы, повтор с паузой.
    onSave: async (a) => {
      for (let i = 0; ; i++) {
        let ours: boolean;
        try {
          ours = await d.queue.saveAnimation(job, a);
        } catch (e) {
          if (i >= delays.length) throw e;
          d.log(`animate ${job.id}: animation не записался в базу (${toStudioError(e).message}) — повтор через ${delays[i]} мс`);
          await new Promise((r) => setTimeout(r, delays[i]));
          continue;
        }
        if (!ours) throw new StudioError('unknown', GONE, false);
        return;
      }
    },
    onFile: (rel) => d.storage.put(animationKey(job.id, rel), path.join(runDir, rel), contentType(rel)),
    onDiscard: (rel) => d.storage.remove(animationKey(job.id, rel)),
  });
  return d.queue.completeAnimate(job, animation);
}

/** Сборка — первой: ролик ближе к концу пути и к владельцу; оживление — до съёмки по той же причине. */
const ORDER: JobKind[] = ['render', 'animate', 'capture'];

/** Одно задание: взять, выполнить, при сбое — отдать очереди с кодом. @returns false — заданий нет */
export async function runOne(d: JobDeps): Promise<boolean> {
  for (const kind of ORDER) {
    const job = await d.queue.claim(kind);
    if (!job) continue;
    d.log(`${kind} ${job.id}: попытка ${job.attempts}`);
    try {
      const run = kind === 'capture' ? runCapture : kind === 'animate' ? runAnimate : runRender;
      const written = await run(job, d);
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
