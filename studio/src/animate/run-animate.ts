import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig } from '../config';
import { StudioError, toStudioError } from '../errors';
import { detectSilences, probeFile } from '../ffprobe';
import type { Script, ShortAnimation, SkitClip, SkitKind, SkitPlan } from '../types';
import { checkClip, CLIP_LUFS, normalizeLoudness } from './clip-check';
import { lineCues, PAUSE_DETECT, voicedSpans } from './cues';
import { CLEAR_REFUSALS, CLIP_SEC, generateKeyframe, imageMime, startClip, waitClip, type GoogleDeps, type ImageInput } from './google';
import { speechCheck } from './match';
import { recognize, speechAudio } from './stt';

const STUDIO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const SKIT_KINDS: readonly SkitKind[] = ['conflict', 'punchline'];
/** Клипов Omni на сценку — не больше (спека, «Отказы»). */
export const MAX_SKIT_ATTEMPTS = 3;
/** Предел секунд Omni на ролик: шесть клипов, ≈ $4,8 (спека, «Отказы»). */
export const DEFAULT_MAX_OMNI_SECONDS = 48;

export interface AnimateDeps {
  keyframe(prompt: string, refs: ImageInput[]): Promise<ImageInput>;
  startClip(prompt: string, image: ImageInput): Promise<string>;
  waitClip(id: string): Promise<Buffer>;
  recognize(ogg: Buffer, ctx: { kind: SkitKind; attempt: number }): Promise<string>;
  /** Корень портретов труппы; по умолчанию studio/assets/troupe. */
  troupeDir?: string;
  /** Громкость клипов, LUFS; по умолчанию CLIP_LUFS. */
  lufs?: number;
  maxOmniSeconds?: number;
  log?(msg: string): void;
}

/** Расширение кадра по его типу: Nano Banana Pro отдаёт JPEG. */
const KEYFRAME_EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/**
 * Оживление сценок папки ролика: script.json (со сценками) → animation.json,
 * keyframes/<отпечаток кадра>.<jpg|png> и skits/<отпечаток клипа>/{raw.mp4, speech.ogg, clip.mp4}.
 *
 * Кадр развязки рисуется по кадру конфликта (то же место и костюмы), поэтому
 * сначала кадр конфликта, потом обе сценки параллельно. Готовое не
 * переделывается: кадр с тем же отпечатком кадра не перерисовывается, клип с
 * тем же отпечатком клипа не переснимается. Новая реплика переснимает только
 * клип своей сценки, новое место конфликта перерисовывает и развязку — это
 * решают отпечатки (src/shorts/short-skit-prompts.ts бэкенда). Оплаченный клип
 * (raw.mp4) лежит, пока его не забраковали: если задание упало уже после
 * клипа (распознавание, ffmpeg), перезапуск возьмёт его, а не снимет новый.
 * Так же, без Omni, клип переобрабатывается, когда меняются громкость или
 * пороги пауз (поле post у готовой сценки).
 */
export async function animateRun(runDir: string, deps: AnimateDeps): Promise<ShortAnimation> {
  const script = JSON.parse(fs.readFileSync(path.join(runDir, 'script.json'), 'utf8')) as Script;
  const plans = script.skits;
  if (!plans?.conflict || !plans?.punchline) {
    throw new StudioError('script_invalid', 'animate: в сценарии нет сценок (skits.conflict и skits.punchline)', false);
  }
  const animPath = path.join(runDir, 'animation.json');
  const anim: ShortAnimation = fs.existsSync(animPath) ? JSON.parse(fs.readFileSync(animPath, 'utf8')) : { omniSeconds: 0, skits: {} };
  const save = () => fs.writeFileSync(animPath, JSON.stringify(anim, null, 2));
  const budget = deps.maxOmniSeconds ?? DEFAULT_MAX_OMNI_SECONDS;
  const lufs = deps.lufs ?? CLIP_LUFS;
  // Настройки бесплатной части обработки: при их смене готовая сценка переобрабатывается из raw.mp4.
  const post = `lufs=${lufs};pause=${PAUSE_DETECT.noiseDb}dB/${PAUSE_DETECT.minSec}s`;
  const troupeDir = deps.troupeDir ?? path.join(STUDIO_ROOT, 'assets', 'troupe');
  const log = deps.log ?? (() => {});
  const abs = (rel: string) => path.join(runDir, rel);
  const rel = (kind: SkitKind, name: string) => path.posix.join('skits', plans[kind].fingerprint, name);
  const keyframeBase = (kind: SkitKind) => path.posix.join('keyframes', plans[kind].keyframeFingerprint);
  const findKeyframe = (kind: SkitKind): string | null => {
    for (const ext of Object.values(KEYFRAME_EXT)) {
      const rel = `${keyframeBase(kind)}.${ext}`;
      if (fs.existsSync(abs(rel))) return rel;
    }
    return null;
  };
  const readImage = (file: string): ImageInput => {
    const data = fs.readFileSync(file);
    return { data, mime: imageMime(data) };
  };
  const giveUp = (e: StudioError) => new StudioError(e.code, `${e.message} — после ${MAX_SKIT_ATTEMPTS} попыток`, false);

  const reusable = (kind: SkitKind): boolean => {
    const prev = anim.skits[kind];
    return (
      !!prev &&
      prev.fingerprint === plans[kind].fingerprint &&
      prev.post === post &&
      fs.existsSync(abs(prev.clip)) &&
      fs.existsSync(abs(prev.keyframe))
    );
  };

  const portraits = (plan: SkitPlan): ImageInput[] =>
    plan.heroes.map((h) => {
      const f = path.join(troupeDir, plan.troupeVersion, `${h}.png`);
      if (!fs.existsSync(f)) throw new StudioError('script_invalid', `animate: нет портрета героя ${h} (труппа ${plan.troupeVersion})`, false);
      return readImage(f);
    });

  /** Кадр-эталон сценки; нарисованный с тем же отпечатком кадра не перерисовывается. */
  const ensureKeyframe = async (kind: SkitKind): Promise<string> => {
    const have = findKeyframe(kind);
    if (have) return have;
    const refs = portraits(plans[kind]);
    if (kind === 'punchline') {
      const conflictKeyframe = findKeyframe('conflict');
      if (!conflictKeyframe) throw new StudioError('unknown', 'animate: развязку не нарисовать — нет кадра конфликта', false);
      refs.push(readImage(abs(conflictKeyframe)));
    }
    let last: StudioError | null = null;
    for (let attempt = 1; attempt <= MAX_SKIT_ATTEMPTS; attempt++) {
      try {
        const img = await deps.keyframe(plans[kind].keyframePrompt, refs);
        const kf = `${keyframeBase(kind)}.${KEYFRAME_EXT[img.mime] ?? 'png'}`;
        fs.mkdirSync(path.dirname(abs(kf)), { recursive: true });
        fs.writeFileSync(abs(kf), img.data);
        return kf;
      } catch (e) {
        last = toStudioError(e);
        if (!last.retryable) throw last;
        log(`animate ${kind}: кадр, попытка ${attempt} — ${last.message}`);
      }
    }
    throw giveUp(last!);
  };

  /** Сбой ffmpeg на уже проверенном файле — не повод платить за новый клип. */
  const local = async <T>(kind: SkitKind, what: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof StudioError) throw e;
      throw new StudioError('unknown', `animate ${kind}: ${what} — ${e instanceof Error ? e.message : String(e)}`, false);
    }
  };

  const animateSkit = async (kind: SkitKind): Promise<SkitClip> => {
    const plan = plans[kind];
    const texts = plan.skit.lines.map((l) => l.text);
    const raw = abs(rel(kind, 'raw.mp4'));
    const clip = rel(kind, 'clip.mp4');
    let last: StudioError | null = null;
    for (let attempt = 1; attempt <= MAX_SKIT_ATTEMPTS; attempt++) {
      let reserved = false;
      let started = false;
      try {
        const kf = await ensureKeyframe(kind);
        if (!fs.existsSync(raw)) {
          if (anim.omniSeconds + CLIP_SEC > budget) {
            throw new StudioError('omni_budget', `animate: на ролик ушло ${anim.omniSeconds} с Omni, предел — ${budget} с: лимит пересъёмок сценок`, false);
          }
          // Секунды резервируются до запуска: сценки идут параллельно, и обе не
          // должны пройти предел, когда места осталось на одну.
          anim.omniSeconds += CLIP_SEC;
          reserved = true;
          const id = await deps.startClip(plan.videoPrompt, readImage(abs(kf)));
          started = true;
          save();
          fs.mkdirSync(path.dirname(raw), { recursive: true });
          fs.writeFileSync(raw, await deps.waitClip(id));
        }

        // Нечитаемый файл — вина клипа, а не студии: такой клип переснимается.
        // Забракованный клип удаляется: следующая попытка снимет новый.
        const reject = (code: 'clip_invalid' | 'speech_mismatch', msg: string): never => {
          fs.rmSync(raw, { force: true });
          fs.rmSync(abs(clip), { force: true });
          throw new StudioError(code, msg, true);
        };
        const probe = await probeFile(raw).catch((e: unknown) =>
          reject('clip_invalid', `animate ${kind}: файл от Omni не читается — ${e instanceof Error ? e.message : String(e)}`),
        );
        // Сначала громкость: тишину проверяет и готовый ролик — уже по выровненному звуку.
        await local(kind, 'громкость', () => normalizeLoudness(raw, abs(clip), lufs));
        const problems = checkClip(probe, await local(kind, 'поиск тишины', () => detectSilences(abs(clip), probe.durationSec)));
        if (problems.length) reject('clip_invalid', `animate ${kind}: клип не прошёл проверку — ${problems.join('; ')}`);

        const ogg = await local(kind, 'звук для распознавания', () => speechAudio(abs(clip), abs(rel(kind, 'speech.ogg'))));
        const heard = await deps.recognize(fs.readFileSync(ogg), { kind, attempt });
        const check = speechCheck(texts, heard);
        if (!check.ok) {
          const why = check.silentLines.length
            ? `не услышаны реплики ${check.silentLines.map((i) => i + 1).join(', ')}`
            : `речь не сошлась с репликами (${Math.round(check.share * 100)}%)`;
          reject('speech_mismatch', `animate ${kind}: ${why}, услышано: «${heard.slice(0, 200)}»`);
        }

        const totalMs = Math.round(probe.durationSec * 1000);
        const pauses = await local(kind, 'поиск пауз', () => detectSilences(abs(clip), probe.durationSec, PAUSE_DETECT));
        log(`animate ${kind}: готово с попытки ${attempt}, речь ${Math.round(check.share * 100)}%`);
        return {
          fingerprint: plan.fingerprint,
          keyframe: kf,
          clip,
          durationMs: totalMs,
          heard,
          cues: lineCues(texts, voicedSpans(pauses, totalMs), totalMs),
          attempts: attempt,
          post,
        };
      } catch (e) {
        const err = toStudioError(e);
        // Секунды возвращаются, только если Google явно отказал в запуске: при
        // потерянном ответе генерация могла начаться и будет оплачена.
        if (reserved && !started && CLEAR_REFUSALS.has(err.code)) anim.omniSeconds -= CLIP_SEC;
        save();
        last = err;
        if (!last.retryable) throw last;
        // Кадр не перерисовывается и после отказа фильтра: по кадру конфликта уже
        // могла быть нарисована развязка, и новый кадр развёл бы место и костюмы сценок.
        log(`animate ${kind}: попытка ${attempt} — ${last.message}`);
      }
    }
    throw giveUp(last!);
  };

  const todo = SKIT_KINDS.filter((k) => !reusable(k));
  if (todo.length) {
    await ensureKeyframe('conflict');
    const results = await Promise.allSettled(
      todo.map(async (kind) => {
        anim.skits[kind] = await animateSkit(kind);
        save();
      }),
    );
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) throw toStudioError(failed.reason);
  }
  save();
  return anim;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const runDir = process.argv[2];
  if (!runDir) {
    console.error('usage: npm run animate -- <out/папка-ролика>   (MAX_OMNI_SECONDS — предел секунд Omni, по умолчанию 48)');
    process.exit(2);
  }
  const cfg = parseConfig(process.env, { capture: false, tts: true, animate: true });
  const g: GoogleDeps = { apiKey: cfg.googleKey };
  const stt = { apiKey: cfg.speechkitKey, folderId: cfg.speechkitFolder };
  try {
    const anim = await animateRun(path.resolve(runDir), {
      keyframe: (prompt, refs) => generateKeyframe(g, prompt, refs),
      startClip: (prompt, image) => startClip(g, prompt, image),
      waitClip: (id) => waitClip(g, id),
      recognize: (ogg) => recognize(ogg, stt),
      maxOmniSeconds: Number(process.env.MAX_OMNI_SECONDS || DEFAULT_MAX_OMNI_SECONDS),
      log: (m) => console.log(m),
    });
    for (const k of SKIT_KINDS) {
      const s = anim.skits[k];
      console.log(`animate ${k}: попыток ${s?.attempts}, услышано «${s?.heard}»`);
    }
    console.log(`animate: готово — Omni ${anim.omniSeconds} с (≈ $${(anim.omniSeconds * 0.1).toFixed(2)})`);
  } catch (e) {
    const err = toStudioError(e);
    console.error(`animate: ${err.code} — ${err.message}`);
    process.exit(1);
  }
}
