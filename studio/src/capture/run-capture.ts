import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig, type StudioConfig } from '../config';
import type { CaptureResult, Scene } from '../types';
import { captureChat } from './chat-scene';
import { loginDemoCached } from './login';

/** Порог длины ответа для ручного прогона; конвейер берёт его из short_settings.min_answer_chars. */
export const DEFAULT_MIN_ANSWER_CHARS = 400;
/** Кеш входа демо-аккаунта: SMS на номер ограничены по частоте. Файл вне git, права 600. */
const SESSION_CACHE = path.resolve('out', '.session.json');

/**
 * Вход демо-аккаунта (с кешем) и съёмка сцены в runDir. Одна и та же для
 * команды capture и рабочего процесса (studio/src/worker/jobs.ts).
 */
export async function captureScene(scene: Scene, cfg: StudioConfig, runDir: string, minAnswerChars: number): Promise<CaptureResult> {
  const session = await loginDemoCached(cfg, SESSION_CACHE);
  const result = await captureChat(scene, cfg, session, runDir, { minAnswerChars });
  if (!result) throw new Error('capture: съёмка вернула пробу вместо результата');
  fs.writeFileSync(path.join(runDir, 'capture.json'), JSON.stringify(result, null, 2));
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [sceneFile, ...flags] = process.argv.slice(2);
  if (!sceneFile) {
    console.error('usage: npm run capture -- <scene.json> [--probe]');
    process.exit(2);
  }
  const scene = JSON.parse(fs.readFileSync(sceneFile, 'utf8')) as Scene;
  const cfg = parseConfig(process.env, { capture: true, tts: false });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = path.resolve('out', `${path.basename(sceneFile, '.json')}-${stamp}`);
  if (flags.includes('--probe')) {
    const session = await loginDemoCached(cfg, SESSION_CACHE);
    await captureChat(scene, cfg, session, runDir, { minAnswerChars: DEFAULT_MIN_ANSWER_CHARS, probeOnly: true });
    console.log(`capture: проба → ${path.join(runDir, 'probe.png')}`);
  } else {
    const result = await captureScene(scene, cfg, runDir, DEFAULT_MIN_ANSWER_CHARS);
    console.log(`capture: готово → ${runDir} (ходов: ${result.turns}, абзацев: ${result.boxes.length})`);
    for (const b of result.boxes) console.log(`  [${b.n}] ${b.text}`);
  }
}
