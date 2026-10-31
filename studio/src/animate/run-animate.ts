import 'dotenv/config';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parseConfig } from '../config';
import { failText, StudioError, toStudioError, type StudioErrorCode } from '../errors';
import { detectSilences, probeFile, type ProbeInfo } from '../ffprobe';
import { SKIT_KINDS, type Script, type ShortAnimation, type SkitClip, type SkitKind, type SkitPlan } from '../types';
import { checkClip, CLIP_LUFS, normalizeLoudness } from './clip-check';
import { lineCues, PAUSE_DETECT, voicedSpans } from './cues';
import {
  CLEAR_REFUSALS,
  CLIP_SEC,
  generateKeyframe,
  imageMime,
  KEYFRAME_USD,
  OMNI_USD_PER_SEC,
  startClip,
  waitClip,
  type GoogleDeps,
  type ImageInput,
} from './google';
import { MATCHER_VERSION, speechCheck } from './match';
import { recognize, speechAudio } from './stt';

const run = promisify(execFile);
const STUDIO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
/** Клипов Omni на сценку — не больше (спека, «Отказы»). */
export const MAX_SKIT_ATTEMPTS = 3;
/** Предел секунд Omni на ролик: шесть клипов, ≈ $4,8 (спека, «Отказы»). */
export const DEFAULT_MAX_OMNI_SECONDS = 48;
/** Версия бесплатной обработки клипа (громкость, субтитры): поднять, когда меняется их логика, — готовые сценки переобработаются без Omni. */
export const PROCESSING_VERSION = 2;

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
  /**
   * Каждое сохранение animation.json — наружу: рабочий процесс пишет его в базу,
   * чтобы резерв секунд и id генерации пережили падение процесса. Сохранения
   * идут по порядку, без обгонов; сбой — ошибка без повтора (задание уже не наше).
   */
  onSave?(anim: ShortAnimation): Promise<void>;
  /** Новый файл папки — кадр, raw.mp4, clip.mp4 (путь относительно неё): рабочий процесс кладёт его в MinIO. */
  onFile?(rel: string): Promise<void>;
  /**
   * Забракованный raw.mp4 (путь относительно папки): рабочий процесс удаляет его
   * из MinIO. Иначе захват на другом сервере или после чистки папки восстановил
   * бы брак — и принял бы его за оплаченный, ещё не проверенный клип.
   */
  onDiscard?(rel: string): Promise<void>;
}

/** Расширение кадра по его типу: Nano Banana Pro отдаёт JPEG. */
const KEYFRAME_EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
/** Как сценка называется в сообщениях владельцу. */
const SCENE: Record<SkitKind, string> = { conflict: 'сценка 1 (конфликт)', punchline: 'сценка 2 (развязка)' };
/**
 * Ошибки ожидания, после которых запущенная генерация жива: id остаётся в
 * animation.json, и следующая попытка или запуск дождётся её, а не заплатит снова.
 * omni_unreadable — генерация готова, но студия не смогла её забрать: после правки
 * студии запуск заберёт её без новой оплаты.
 */
const KEEP_PENDING: ReadonlySet<StudioErrorCode> = new Set<StudioErrorCode>(['omni_timeout', 'google_auth', 'google_quota', 'omni_unreadable']);
const FINGERPRINT = /^[0-9a-z-]+$/;
/**
 * Сбой хранилища (выгрузка, удаление брака) — не попытка Omni: из цикла попыток
 * сценки он выходит сразу, и задание повторяется с паузой. Файл уже в папке —
 * повтор новых денег не стоит.
 */
class StorageError extends StudioError {}

/**
 * Пометка брака рядом с skits/<отпечаток>/rejected-*.mp4. По ней студия решает,
 * перепроверять ли брак до новой оплаты (reviveRejected): сверка поменялась
 * (matcher меньше MATCHER_VERSION) — да, плохой файл (clip_invalid) — нет.
 */
export interface RejectedMeta {
  code: 'clip_invalid' | 'speech_mismatch';
  /** Версия сверки, которая забраковала клип или последней его перепроверила. */
  matcher: number;
  /** Что распознал SpeechKit — у speech_mismatch. */
  heard?: string;
  share?: number;
}

/** Запись через временный файл: обрыв посреди записи не оставит обрезанный клип, кадр или счёт секунд. */
function writeAtomic(file: string, data: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

/** animation.json — счёт денег: испорченный файл не повод начинать счёт с нуля. */
function loadAnimation(file: string): ShortAnimation {
  if (!fs.existsSync(file)) return { omniSeconds: 0, keyframes: 0, skits: {}, pending: {} };
  let a: Partial<ShortAnimation> | null;
  try {
    a = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ShortAnimation> | null;
  } catch (e) {
    throw new StudioError('no_input', `animate: ${file} не читается (${failText(e)}) — счёт секунд Omni неизвестен, восстановите файл`, false);
  }
  if (!a || typeof a !== 'object' || typeof a.omniSeconds !== 'number' || !Number.isFinite(a.omniSeconds) || a.omniSeconds < 0 || !a.skits || typeof a.skits !== 'object') {
    throw new StudioError('no_input', `animate: ${file} испорчен — счёт секунд Omni неизвестен, восстановите файл`, false);
  }
  return {
    omniSeconds: a.omniSeconds,
    keyframes: typeof a.keyframes === 'number' && Number.isFinite(a.keyframes) ? a.keyframes : 0,
    skits: a.skits,
    pending: a.pending && typeof a.pending === 'object' ? a.pending : {},
  };
}

/**
 * Оживление сценок папки ролика: script.json (со сценками) → animation.json,
 * keyframes/<отпечаток кадра>.<jpg|png|webp> и skits/<отпечаток клипа>/{raw.mp4, speech.ogg, clip.mp4}.
 *
 * Кадр развязки рисуется по кадру конфликта (то же место и костюмы), поэтому
 * кадр конфликта — первым, потом обе сценки параллельно. Готовое не
 * переделывается: кадр с тем же отпечатком кадра не перерисовывается, клип с
 * тем же отпечатком клипа и теми же настройками обработки (post) не
 * переснимается; кадр рисуется, только когда снимается новый клип. Новая
 * реплика переснимает только клип своей сценки, новое место конфликта
 * перерисовывает и развязку — это решают отпечатки (src/shorts/short-skit-prompts.ts
 * бэкенда).
 *
 * Деньги: секунды Omni резервируются до запуска и возвращаются только при
 * явном отказе Google; id запущенной генерации хранится в animation.json, и
 * следующая попытка или запуск дождётся её, а не заплатит снова. Оплаченный
 * клип (raw.mp4) лежит, пока его не забраковали: сбой распознавания или ffmpeg
 * не стоит пересъёмки. Принятый клип при смене громкости или порогов пауз
 * переобрабатывается без Omni и без распознавания. Забракованный клип не
 * удаляется, а откладывается в skits/<отпечаток>/rejected-*.mp4 — его можно
 * разобрать и перепроверить.
 */
export async function animateRun(runDir: string, deps: AnimateDeps): Promise<ShortAnimation> {
  const script = JSON.parse(fs.readFileSync(path.join(runDir, 'script.json'), 'utf8')) as Script;
  const plans = script.skits;
  if (!plans?.conflict || !plans?.punchline) {
    throw new StudioError('script_invalid', 'animate: в сценарии нет сценок (skits.conflict и skits.punchline)', false);
  }
  for (const kind of SKIT_KINDS) {
    const p = plans[kind];
    if (!FINGERPRINT.test(p.fingerprint ?? '') || !FINGERPRINT.test(p.keyframeFingerprint ?? '') || !Array.isArray(p.skit?.lines) || !Array.isArray(p.heroes)) {
      throw new StudioError('script_invalid', `${SCENE[kind]}: план сценки неполон — соберите сценарий заново (scripts/shorts-skit-plan.ts)`, false);
    }
  }
  if (plans.conflict.fingerprint === plans.punchline.fingerprint) {
    throw new StudioError('script_invalid', 'animate: у двух сценок один отпечаток клипа — соберите сценарий заново', false);
  }
  const budget = deps.maxOmniSeconds ?? DEFAULT_MAX_OMNI_SECONDS;
  if (typeof budget !== 'number' || !Number.isFinite(budget) || budget < 0) {
    throw new StudioError('no_input', `animate: предел секунд Omni — «${budget}», нужно неотрицательное число`, false);
  }
  try {
    await run('ffmpeg', ['-version']);
    await run('ffprobe', ['-version']);
  } catch (e) {
    throw new StudioError('unknown', `animate: ffmpeg или ffprobe не запускается (${failText(e)}) — оживление не начато`, false);
  }

  const animPath = path.join(runDir, 'animation.json');
  const anim = loadAnimation(animPath);
  // Снимок берётся в момент вызова, отправка наружу — цепочкой: две сценки
  // сохраняются вперемешку, и запись постарше не должна лечь поверх новой.
  let saving: Promise<void> = Promise.resolve();
  const save = async (): Promise<void> => {
    const text = JSON.stringify(anim, null, 2);
    try {
      writeAtomic(animPath, text);
    } catch (e) {
      throw new StudioError('unknown', `animate: animation.json не записался — ${failText(e)}`, false);
    }
    if (!deps.onSave) return;
    const snapshot = JSON.parse(text) as ShortAnimation;
    saving = saving.then(() => deps.onSave!(snapshot));
    try {
      await saving;
    } catch (e) {
      throw e instanceof StudioError ? e : new StudioError('unknown', `animate: animation.json не сохранился наружу — ${failText(e)}`, false);
    }
  };
  /** Что этот запуск уже выгрузил: кадр из папки мог не дойти до хранилища в прошлом захвате. */
  const uploaded = new Set<string>();
  /** Файл — наружу; сетевой сбой повторяем: файл уже лежит в папке, новых денег повтор не стоит. */
  const upload = async (rel: string): Promise<void> => {
    if (!deps.onFile) return;
    try {
      await deps.onFile(rel);
      uploaded.add(rel);
    } catch (e) {
      throw new StorageError('unknown', `animate: ${rel} не выгрузился в хранилище — ${failText(e)}`, true);
    }
  };
  const discard = async (rel: string): Promise<void> => {
    if (!deps.onDiscard) return;
    try {
      await deps.onDiscard(rel);
    } catch (e) {
      throw new StorageError('unknown', `animate: брак ${rel} не удалился из хранилища — ${failText(e)}`, true);
    }
  };
  const lufs = deps.lufs ?? CLIP_LUFS;
  const post = `v${PROCESSING_VERSION};lufs=${lufs};pause=${PAUSE_DETECT.noiseDb}dB/${PAUSE_DETECT.minSec}s`;
  const troupeDir = deps.troupeDir ?? path.join(STUDIO_ROOT, 'assets', 'troupe');
  const log = deps.log ?? (() => {});
  const abs = (file: string) => path.join(runDir, file);
  const skitFile = (kind: SkitKind, name: string) => path.posix.join('skits', plans[kind].fingerprint, name);
  const keyframeBase = (kind: SkitKind) => path.posix.join('keyframes', plans[kind].keyframeFingerprint);
  const findKeyframe = (kind: SkitKind): string | null => {
    for (const ext of Object.values(KEYFRAME_EXT)) {
      const file = `${keyframeBase(kind)}.${ext}`;
      if (fs.existsSync(abs(file))) return file;
    }
    return null;
  };
  const readImage = (file: string): ImageInput => {
    const data = fs.readFileSync(file);
    return { data, mime: imageMime(data) };
  };
  const hasRaw = (kind: SkitKind) => fs.existsSync(abs(skitFile(kind, 'raw.mp4')));
  const hasPending = (kind: SkitKind) => anim.pending?.[kind]?.fingerprint === plans[kind].fingerprint;
  /** Сбой локального шага (ffmpeg, диск) — не повод платить за новый клип: без повтора. */
  const local = async <T>(what: string, fn: () => T | Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof StudioError) throw e;
      throw new StudioError('unknown', `${what} — ${failText(e)}`, false);
    }
  };

  /** Пометка брака — подсказка перепроверке, не счёт денег: не записалась — брак перепроверится полной проверкой. */
  const writeRejectedMeta = (file: string, meta: RejectedMeta): void => {
    try {
      writeAtomic(file, JSON.stringify(meta, null, 2));
    } catch (e) {
      log(`animate: пометка брака ${path.basename(file)} не записалась — ${failText(e)}`);
    }
  };

  const reusable = (kind: SkitKind): boolean => {
    const prev = anim.skits[kind];
    return !!prev && prev.fingerprint === plans[kind].fingerprint && prev.post === post && fs.existsSync(abs(prev.clip));
  };
  /** Сценке нужен новый клип Omni: готового нет, оплаченного raw.mp4 нет, запущенной генерации нет. */
  const needsOmni = (kind: SkitKind) => !reusable(kind) && !hasRaw(kind) && !hasPending(kind);

  const portraits = (plan: SkitPlan): ImageInput[] =>
    plan.heroes.map((h) => {
      const f = path.join(troupeDir, plan.troupeVersion, `${h}.png`);
      if (!fs.existsSync(f)) throw new StudioError('no_input', `нет портрета героя ${h} (труппа ${plan.troupeVersion})`, false);
      return readImage(f);
    });

  /** Кадр конфликта пропал, а по нему уже есть что-то своё: новый кадр развёл бы место и костюмы сценок. */
  const conflictKeyframeGone = (why: string): StudioError =>
    new StudioError(
      'no_input',
      `animate: кадра конфликта ${keyframeBase('conflict')} нет, а ${why} — верните кадр или удалите keyframes/ и skits/ ролика и поля skits и pending в animation.json (omniSeconds и keyframes оставить — это счёт денег), чтобы начать пару заново`,
      false,
    );

  /** Кадр-эталон сценки; нарисованный с тем же отпечатком кадра не перерисовывается. */
  const ensureKeyframe = async (kind: SkitKind): Promise<string> => {
    const have = findKeyframe(kind);
    if (have) {
      // Кадр из папки мог не дойти до хранилища: без него другой сервер не нарисует
      // развязку и не переснимет конфликт.
      if (!uploaded.has(have)) await upload(have);
      return have;
    }
    // Перерисовать кадр конфликта можно, пока по нему не нарисована и не снята развязка.
    if (kind === 'conflict' && (findKeyframe('punchline') || hasRaw('punchline') || hasPending('punchline') || anim.skits.punchline?.fingerprint === plans.punchline.fingerprint)) {
      throw conflictKeyframeGone('по нему уже нарисована развязка');
    }
    const refs = portraits(plans[kind]);
    if (kind === 'punchline') {
      const conflictKeyframe = findKeyframe('conflict');
      if (!conflictKeyframe) throw conflictKeyframeGone('развязку рисовать не с чего');
      refs.push(readImage(abs(conflictKeyframe)));
    }
    let last: StudioError | null = null;
    for (let attempt = 1; attempt <= MAX_SKIT_ATTEMPTS; attempt++) {
      let img: ImageInput;
      try {
        img = await deps.keyframe(plans[kind].keyframePrompt, refs);
      } catch (e) {
        last = toStudioError(e);
        if (!last.retryable) throw last;
        log(`animate ${kind}: кадр, попытка ${attempt} — ${last.message}`);
        continue;
      }
      const kf = `${keyframeBase(kind)}.${KEYFRAME_EXT[img.mime] ?? 'png'}`;
      await local('кадр не записался', () => writeAtomic(abs(kf), img.data));
      // Счёт — до выгрузки: кадр оплачен, даже если хранилище моргнёт.
      anim.keyframes = (anim.keyframes ?? 0) + 1;
      await save();
      await upload(kf);
      return kf;
    }
    throw new StudioError(last!.code, `${last!.message} — кадр не нарисован за ${MAX_SKIT_ATTEMPTS} попытки`, false);
  };

  /**
   * Готовый клип: громкость, проверка, речь, время реплик. Обработка идёт в
   * clip.next.mp4 и заменяет clip.mp4 только после всех проверок: отказ или обрыв
   * не оставят запись и файл рассогласованными. Брак — повторяемая ошибка (новая
   * попытка), если клип не принятый.
   */
  const finish = async (kind: SkitKind, attempt: number, accepted: SkitClip | null): Promise<SkitClip> => {
    const plan = plans[kind];
    const texts = plan.skit.lines.map((l) => l.text);
    const raw = abs(skitFile(kind, 'raw.mp4'));
    const clip = skitFile(kind, 'clip.mp4');
    const next = abs(skitFile(kind, 'clip.next.mp4'));
    const reject = async (code: RejectedMeta['code'], msg: string, speech?: { heard: string; share: number }): Promise<never> => {
      fs.rmSync(next, { force: true });
      if (accepted) {
        // Принятый клип не бракуется молча: владелец его уже видел, а пересъёмка стоит денег.
        // Запись и clip.mp4 прежние — следующий запуск с теми же настройками скажет то же, без трат.
        throw new StudioError(
          code,
          `принятый клип при новых настройках (${accepted.post} → ${post}) не проходит проверку (${msg}); запись сценки и clip.mp4 прежние — верните прежние настройки или удалите ${skitFile(kind, 'raw.mp4')} и запись сценки в animation.json, чтобы переснять`,
          false,
        );
      }
      // Брак откладывается, а не удаляется: после правки сверки студия перепроверит его до новой оплаты (reviveRejected).
      const base = skitFile(kind, `rejected-${new Date().toISOString().replace(/[:.]/g, '-')}`);
      fs.renameSync(raw, abs(`${base}.mp4`));
      writeRejectedMeta(abs(`${base}.json`), { code, matcher: MATCHER_VERSION, ...speech });
      fs.rmSync(abs(clip), { force: true });
      // И из хранилища: брак, восстановленный следующим захватом, снова прошёл бы
      // сверку — или сошёл бы за клип запущенной генерации.
      await discard(skitFile(kind, 'raw.mp4'));
      throw new StudioError(code, msg, true);
    };
    const rawProbe: ProbeInfo = await probeFile(raw).catch((e: unknown) => reject('clip_invalid', `файл от Omni не читается — ${failText(e)}`));
    const early = checkClip(rawProbe, []);
    if (early.length) await reject('clip_invalid', `клип не прошёл проверку — ${early.join('; ')}`);
    // Громкость — до проверки тишины: её проверяет и готовый ролик, уже по выровненному звуку.
    await local('громкость', () => normalizeLoudness(raw, next, lufs));
    const probe = await local('проверка выровненного клипа', () => probeFile(next));
    const problems = checkClip(probe, await local('поиск тишины', () => detectSilences(next, probe.durationSec)));
    if (problems.length) await reject('clip_invalid', `клип не прошёл проверку — ${problems.join('; ')}`);

    let heard: string;
    let share: number;
    if (accepted) {
      // Речь принятого клипа от громкости не меняется — распознавать заново незачем.
      heard = accepted.heard;
      share = speechCheck(texts, heard).share;
    } else {
      const ogg = await local('звук для распознавания', () => speechAudio(next, abs(skitFile(kind, 'speech.ogg'))));
      heard = await deps.recognize(fs.readFileSync(ogg), { kind, attempt });
      // Пустой ответ — дешевле спросить SpeechKit ещё раз, чем переснимать клип.
      if (!heard.trim()) heard = await deps.recognize(fs.readFileSync(ogg), { kind, attempt });
      const check = speechCheck(texts, heard);
      if (!check.ok) {
        const why = check.silentLines.length
          ? `не услышаны реплики ${check.silentLines.map((i) => i + 1).join(', ')}`
          : `речь не сошлась с репликами (${Math.round(check.share * 100)}%)`;
        await reject('speech_mismatch', `${why}, услышано: «${heard.slice(0, 200)}»`, { heard, share: check.share });
      }
      share = check.share;
    }

    // Длина сцены — по видеодорожке: звук AAC длиннее на десятки мс, и последние кадры сцены просили бы кадр за концом видео.
    const totalMs = Math.round((probe.videoSec ?? probe.durationSec) * 1000);
    const pauses = await local('поиск пауз', () => detectSilences(next, probe.durationSec, PAUSE_DETECT));
    await local('клип не записался', () => fs.renameSync(next, abs(clip)));
    await upload(clip);
    log(`animate ${kind}: готово${accepted ? ' (переобработка без Omni)' : ` с попытки ${attempt}`}, речь ${Math.round(share * 100)}%`);
    return {
      fingerprint: plan.fingerprint,
      keyframe: findKeyframe(kind) ?? accepted?.keyframe ?? '',
      clip,
      durationMs: totalMs,
      heard,
      cues: lineCues(texts, voicedSpans(pauses, totalMs), totalMs),
      attempts: accepted?.attempts ?? attempt,
      post,
    };
  };

  const assertBudget = (): void => {
    if (anim.omniSeconds + CLIP_SEC > budget) {
      throw new StudioError(
        'omni_budget',
        `на ролик ушло ${anim.omniSeconds} с Omni вместе с запущенными, предел — ${budget} с: лимит пересъёмок сценок; поднять — настройка «Предел секунд Omni» (update_settings maxOmniSeconds; в CLI — MAX_OMNI_SECONDS=<секунды> npm run animate)`,
        false,
      );
    }
  };

  const animateSkit = async (kind: SkitKind): Promise<SkitClip> => {
    const plan = plans[kind];
    const raw = abs(skitFile(kind, 'raw.mp4'));
    const prev = anim.skits[kind];
    const same = prev?.fingerprint === plan.fingerprint;
    // Принятый клип при новых настройках переобрабатывается из raw.mp4; его запись
    // меняется, только когда переобработка удалась (finish пишет в clip.next.mp4).
    if (same && hasRaw(kind)) return finish(kind, prev!.attempts, prev!);
    if (same) {
      // Клип принят, а оплаченного raw.mp4 нет: молча переснимать нельзя — это новые деньги.
      throw new StudioError(
        'no_input',
        `${skitFile(kind, 'raw.mp4')} нет — принятый клип переобработать не из чего (настройки ${prev!.post} → ${post}); верните raw.mp4 или удалите запись сценки в animation.json, чтобы переснять`,
        false,
      );
    }
    // Оплаченный клип уже скачан, а id генерации остался (процесс упал между записью клипа и сохранением) — id больше не нужен.
    // raw.mp4 рядом с id бывает только так: новый клип не запускается, пока raw.mp4 есть, а брак
    // уходит и из папки, и из хранилища (reject, onDiscard) — восстановленный raw.mp4 не забракован.
    if (hasRaw(kind) && hasPending(kind)) delete anim.pending![kind];
    // Запись под другой отпечаток больше не годится: сборка её и так не возьмёт.
    delete anim.skits[kind];
    await save();

    let last: StudioError | null = null;
    const codes: string[] = [];
    for (let attempt = 1; attempt <= MAX_SKIT_ATTEMPTS; attempt++) {
      let reserved = false;
      let started = false;
      try {
        if (!fs.existsSync(raw)) {
          let id: string;
          if (hasPending(kind)) {
            id = anim.pending![kind]!.id;
            log(`animate ${kind}: дожидаюсь уже запущенного клипа ${id}`);
          } else {
            // Предел — и до кадра (кадр тоже стоит денег), и после: соседняя сценка могла зарезервировать секунды, пока он рисовался.
            assertBudget();
            const image = readImage(abs(await ensureKeyframe(kind)));
            assertBudget();
            // Секунды резервируются до запуска: сценки идут параллельно, и обе не
            // должны пройти предел, когда места осталось на одну.
            anim.omniSeconds += CLIP_SEC;
            reserved = true;
            await save();
            id = await deps.startClip(plan.videoPrompt, image);
            started = true;
            anim.pending = { ...anim.pending, [kind]: { id, fingerprint: plan.fingerprint } };
            await save();
          }
          let mp4: Buffer;
          try {
            mp4 = await deps.waitClip(id);
          } catch (e) {
            const err = toStudioError(e);
            if (!KEEP_PENDING.has(err.code)) {
              delete anim.pending![kind];
              await save();
              throw err;
            }
            // id остаётся: следующая попытка или запуск дождётся этой генерации.
            throw err.retryable ? err : new StudioError(err.code, `${err.message} (id ${id} — pending.${kind} в animation.json; удалите его, чтобы снять клип заново)`, false);
          }
          await local('клип не записался', () => writeAtomic(raw, mp4));
          await upload(skitFile(kind, 'raw.mp4'));
          delete anim.pending![kind];
          await save();
        } else {
          // Оплаченный клип уже в папке (сбой распознавания, выгрузки, перезапуск) — он должен лежать и снаружи.
          await upload(skitFile(kind, 'raw.mp4'));
        }
        return await finish(kind, attempt, null);
      } catch (e) {
        // Сбой хранилища — не попытка Omni: задание повторится с паузой, клип уже в папке.
        if (e instanceof StorageError) throw e;
        const err = toStudioError(e);
        // Секунды возвращаются, только если Google явно отказал в запуске: при
        // потерянном ответе генерация могла начаться и будет оплачена.
        if (reserved && !started && CLEAR_REFUSALS.has(err.code)) {
          anim.omniSeconds -= CLIP_SEC;
          await save();
        }
        last = err;
        codes.push(err.code);
        if (!err.retryable) throw err;
        // Кадр не перерисовывается и после отказа фильтра: по кадру конфликта уже
        // могла быть нарисована развязка, и новый кадр развёл бы место и костюмы сценок.
        log(`animate ${kind}: попытка ${attempt} — ${err.message}`);
      }
    }
    throw new StudioError(last!.code, `${last!.message} — после ${MAX_SKIT_ATTEMPTS} попыток (${codes.join(', ')})`, false);
  };

  // Первое сохранение — до любых трат: задание, которое уже не наше (onSave отказал), не нарисует ни кадра.
  await save();
  const todo = SKIT_KINDS.filter((k) => !reusable(k));
  if (todo.length) {
    // Кадр конфликта нужен первым: по нему рисуется развязка. Если его нет, а по
    // нему уже есть клипы или кадр развязки, новый кадр развёл бы место и костюмы
    // сценок — молча не перерисовываем.
    const conflictNeedsKeyframe = needsOmni('conflict') || (needsOmni('punchline') && !findKeyframe('punchline'));
    if (conflictNeedsKeyframe && !findKeyframe('conflict')) {
      const derived =
        hasRaw('conflict') || reusable('conflict') || hasPending('conflict') ||
        !!findKeyframe('punchline') || hasRaw('punchline') || reusable('punchline') || hasPending('punchline');
      if (derived) throw conflictKeyframeGone('по нему уже сняты клипы или нарисована развязка');
      try {
        assertBudget();
        await ensureKeyframe('conflict');
      } catch (e) {
        const err = toStudioError(e);
        throw new StudioError(err.code, `${SCENE.conflict}: ${err.message}`, err.retryable);
      }
    }
    const results = await Promise.allSettled(
      todo.map(async (kind) => {
        anim.skits[kind] = await animateSkit(kind);
        // Клип принят — запущенной генерации этой сценки больше нет, что бы ни помешало убрать id раньше.
        if (anim.pending?.[kind]?.fingerprint === plans[kind].fingerprint) delete anim.pending[kind];
        await save();
      }),
    );
    const failures = results
      .map((r, i) => ({ r, kind: todo[i] }))
      .filter((x): x is { r: PromiseRejectedResult; kind: SkitKind } => x.r.status === 'rejected')
      .map(({ r, kind }) => {
        const err = toStudioError(r.reason);
        log(`animate ${kind}: ${err.code} — ${err.message}`);
        return { kind, err };
      });
    if (failures.length) {
      // Если упали обе сценки, код и признак повтора — у той, что без повтора.
      const main = failures.find((f) => !f.err.retryable) ?? failures[0];
      throw new StudioError(main.err.code, failures.map((f) => `${SCENE[f.kind]}: ${f.err.message}`).join('; '), main.err.retryable);
    }
  }
  await save();
  return anim;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const runDir = process.argv[2];
  if (!runDir) {
    console.error('usage: npm run animate -- <out/папка-ролика>   (MAX_OMNI_SECONDS — предел секунд Omni, целое число, по умолчанию 48)');
    process.exit(2);
  }
  const maxRaw = process.env.MAX_OMNI_SECONDS?.trim();
  if (maxRaw && !/^\d+$/.test(maxRaw)) {
    console.error(`animate: MAX_OMNI_SECONDS — целое число секунд, например 96; получено «${maxRaw}»`);
    process.exit(2);
  }
  try {
    const cfg = parseConfig(process.env, { capture: false, tts: false, animate: true });
    const g: GoogleDeps = { apiKey: cfg.googleKey };
    const stt = { apiKey: cfg.speechkitKey, folderId: cfg.speechkitFolder };
    const anim = await animateRun(path.resolve(runDir), {
      keyframe: (prompt, refs) => generateKeyframe(g, prompt, refs),
      startClip: (prompt, image) => startClip(g, prompt, image),
      waitClip: (id) => waitClip(g, id),
      recognize: (ogg) => recognize(ogg, stt),
      maxOmniSeconds: maxRaw ? Number(maxRaw) : DEFAULT_MAX_OMNI_SECONDS,
      log: (m) => console.log(m),
    });
    for (const k of SKIT_KINDS) {
      const s = anim.skits[k];
      console.log(`animate ${k}: попыток ${s?.attempts}, услышано «${s?.heard}»`);
    }
    const usd = anim.omniSeconds * OMNI_USD_PER_SEC + (anim.keyframes ?? 0) * KEYFRAME_USD;
    console.log(`animate: готово — Omni ${anim.omniSeconds} с, кадров ${anim.keyframes ?? 0} (≈ $${usd.toFixed(2)})`);
  } catch (e) {
    const err = toStudioError(e);
    console.error(`animate: ${err.code} — ${err.message}`);
    process.exit(1);
  }
}
