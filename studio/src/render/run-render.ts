import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundle } from '@remotion/bundler';
import { renderMedia, renderStill, selectComposition } from '@remotion/renderer';
import { parseConfig } from '../config';
import { StudioError, toStudioError } from '../errors';
import { detectSilences, probeFile, SHORT_LIMITS, SKIT_LIMITS, verifyVideo, type VerifyLimits } from '../ffprobe';
import { validateScript } from '../script';
import { synthesizeAll } from '../tts';
import { SKIT_KINDS, type CaptureResult, type Script, type ShortAnimation, type ShortProps, type SkitShortProps } from '../types';
import { buildProps, buildSkitProps } from './props';

const STUDIO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

export interface RenderResult {
  video: string;
  cover: string;
  problems: string[];
  durationSec: number;
}

/** Что собирать: композиция, её пропсы, пропсы обложки и пределы проверки файла. */
type Build =
  | { id: 'Short'; props: ShortProps; cover: ShortProps; limits: VerifyLimits }
  | { id: 'SkitShort'; props: SkitShortProps; cover: SkitShortProps; limits: VerifyLimits };

const isFile = (file: string): boolean => {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};

/**
 * animation.json задания animate — до озвучки и бандла: пропавший клип иначе
 * всплыл бы 404 внутри Remotion, после минут рендера. Нет записи сценки или
 * она снята под другой сценарий — это назовёт buildSkitProps.
 */
function readAnimation(runDir: string): ShortAnimation {
  const file = path.join(runDir, 'animation.json');
  const fail = (why: string) => new StudioError('no_input', `render: ${why} — сначала npm run animate`, false);
  if (!fs.existsSync(file)) throw fail('у ролика со сценками нет animation.json');
  let a: ShortAnimation | null;
  try {
    a = JSON.parse(fs.readFileSync(file, 'utf8')) as ShortAnimation | null;
  } catch (e) {
    throw fail(`animation.json не читается (${e instanceof Error ? e.message : String(e)})`);
  }
  if (!a?.skits || typeof a.skits !== 'object') throw fail('в animation.json нет сценок');
  for (const kind of SKIT_KINDS) {
    const c = a.skits[kind];
    if (c && (typeof c.clip !== 'string' || !c.clip || !isFile(path.join(runDir, c.clip)))) throw fail(`нет файла клипа сценки ${kind} (${c.clip})`);
  }
  return a;
}

/**
 * Папка съёмки (capture.json, script.json, скриншоты) → video.mp4 и cover.jpg
 * в той же папке. Папка служит publicDir бандла: staticFile() берёт файлы из неё.
 * skipTts — озвучка только из кеша (для фикстуры без сети).
 * Сценарий со сценками собирается композицией SkitShort: нужен animation.json
 * задания animate (npm run animate). Обложка у него — сценка 1 с надписью-зацепкой,
 * без субтитров реплик.
 */
export async function renderRun(runDir: string, opts: { skipTts?: boolean } = {}): Promise<RenderResult> {
  const capture = JSON.parse(fs.readFileSync(path.join(runDir, 'capture.json'), 'utf8')) as CaptureResult;
  const script = JSON.parse(fs.readFileSync(path.join(runDir, 'script.json'), 'utf8')) as Script;
  const scriptProblems = validateScript(script, capture);
  if (scriptProblems.length) throw new StudioError('script_invalid', `render: сценарий не прошёл проверку:\n- ${scriptProblems.join('\n- ')}`, false);
  // Клипы сценок — до озвучки: без них SpeechKit и бандл впустую.
  const animation = script.skits ? readAnimation(runDir) : null;

  const cfg = parseConfig(process.env, { capture: false, tts: !opts.skipTts });
  const reqs = script.lines.map((l) => ({ id: l.id, text: l.text, voice: l.voice ?? script.voice, speed: script.speed ?? 1 }));
  const voiced = await synthesizeAll(reqs, path.join(runDir, 'voice'), { apiKey: cfg.speechkitKey, folderId: cfg.speechkitFolder });
  // Ролик со сценками собирается своей композицией из клипов задания animate.
  let build: Build;
  if (animation) {
    const props = buildSkitProps(capture, script, voiced, animation, runDir);
    // На обложке субтитры реплик — лишний шум поверх надписи-зацепки.
    const cover = { ...props, clips: { conflict: { ...props.clips.conflict, cues: [] }, punchline: { ...props.clips.punchline, cues: [] } } };
    build = { id: 'SkitShort', props, cover, limits: SKIT_LIMITS };
  } else {
    const props = buildProps(capture, script, voiced, runDir);
    build = { id: 'Short', props, cover: props, limits: SHORT_LIMITS };
  }

  fs.copyFileSync(path.join(STUDIO_ROOT, 'public', 'logo.png'), path.join(runDir, 'logo.png'));
  const serveUrl = await bundle({ entryPoint: path.join(STUDIO_ROOT, 'src', 'remotion', 'index.ts'), publicDir: runDir });
  try {
    const composition = await selectComposition({ serveUrl, id: build.id, inputProps: build.props });
    const video = path.join(runDir, 'video.mp4');
    await renderMedia({ composition, serveUrl, codec: 'h264', outputLocation: video, inputProps: build.props, concurrency: 2 });
    const cover = path.join(runDir, 'cover.jpg');
    // Remotion рисует пропсы, с которыми выбрана композиция, — у обложки со своими пропсами выбор свой.
    const coverComposition = build.cover === build.props ? composition : await selectComposition({ serveUrl, id: build.id, inputProps: build.cover });
    await renderStill({ composition: coverComposition, serveUrl, output: cover, frame: 20, inputProps: build.cover, imageFormat: 'jpeg' });

    const probe = await probeFile(video);
    const silences = await detectSilences(video, probe.durationSec);
    return { video, cover, problems: verifyVideo(probe, silences, build.limits), durationSec: probe.durationSec };
  } finally {
    // bundle() кладёт бандл и копию папки съёмки в новый каталог /tmp на каждый вызов
    // и сам его не удаляет — без этого сотни рендеров на сервере съедают диск.
    await fs.promises.rm(serveUrl, { recursive: true, force: true }).catch(() => {});
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const runDir = process.argv[2];
  if (!runDir) {
    console.error('usage: npm run render -- <out/папка-съёмки>');
    process.exit(2);
  }
  try {
    const r = await renderRun(path.resolve(runDir));
    if (r.problems.length) {
      console.error(`render: проверка файла не прошла:\n- ${r.problems.join('\n- ')}`);
      process.exit(1);
    }
    console.log(`render: готово → ${r.video} (обложка ${r.cover})`);
  } catch (e) {
    const err = toStudioError(e);
    console.error(`render: ${err.code} — ${err.message}`);
    process.exit(1);
  }
}
