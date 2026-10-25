import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundle } from '@remotion/bundler';
import { renderMedia, renderStill, selectComposition } from '@remotion/renderer';
import { parseConfig } from '../config';
import { StudioError } from '../errors';
import { detectSilences, probeFile, verifyVideo } from '../ffprobe';
import { validateScript } from '../script';
import { synthesizeAll } from '../tts';
import type { CaptureResult, Script } from '../types';
import { buildProps } from './props';

const STUDIO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

export interface RenderResult {
  video: string;
  cover: string;
  problems: string[];
}

/**
 * Папка съёмки (capture.json, script.json, скриншоты) → video.mp4 и cover.jpg
 * в той же папке. Папка служит publicDir бандла: staticFile() берёт файлы из неё.
 * skipTts — озвучка только из кеша (для фикстуры без сети).
 */
export async function renderRun(runDir: string, opts: { skipTts?: boolean } = {}): Promise<RenderResult> {
  const capture = JSON.parse(fs.readFileSync(path.join(runDir, 'capture.json'), 'utf8')) as CaptureResult;
  const script = JSON.parse(fs.readFileSync(path.join(runDir, 'script.json'), 'utf8')) as Script;
  const scriptProblems = validateScript(script, capture);
  if (scriptProblems.length) throw new StudioError('script_invalid', `render: сценарий не прошёл проверку:\n- ${scriptProblems.join('\n- ')}`, false);

  const cfg = parseConfig(process.env, { capture: false, tts: !opts.skipTts });
  const reqs = script.lines.map((l) => ({ id: l.id, text: l.text, voice: l.voice ?? script.voice, speed: script.speed ?? 1 }));
  const voiced = await synthesizeAll(reqs, path.join(runDir, 'voice'), { apiKey: cfg.speechkitKey, folderId: cfg.speechkitFolder });
  const inputProps = buildProps(capture, script, voiced, runDir);

  fs.copyFileSync(path.join(STUDIO_ROOT, 'public', 'logo.png'), path.join(runDir, 'logo.png'));
  const serveUrl = await bundle({ entryPoint: path.join(STUDIO_ROOT, 'src', 'remotion', 'index.ts'), publicDir: runDir });
  try {
    const composition = await selectComposition({ serveUrl, id: 'Short', inputProps });
    const video = path.join(runDir, 'video.mp4');
    await renderMedia({ composition, serveUrl, codec: 'h264', outputLocation: video, inputProps, concurrency: 2 });
    const cover = path.join(runDir, 'cover.jpg');
    await renderStill({ composition, serveUrl, output: cover, frame: 20, inputProps, imageFormat: 'jpeg' });

    const probe = await probeFile(video);
    const silences = await detectSilences(video, probe.durationSec);
    return { video, cover, problems: verifyVideo(probe, silences) };
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
  const r = await renderRun(path.resolve(runDir));
  if (r.problems.length) {
    console.error(`render: проверка файла не прошла:\n- ${r.problems.join('\n- ')}`);
    process.exit(1);
  }
  console.log(`render: готово → ${r.video} (обложка ${r.cover})`);
}
