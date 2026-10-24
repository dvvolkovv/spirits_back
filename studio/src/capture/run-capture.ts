import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { parseConfig } from '../config';
import type { Scene } from '../types';
import { captureChat } from './chat-scene';
import { countAssistants, loginDemoCached } from './login';

/** Порог длины ответа по спеке (short_settings.min_answer_chars во втором плане). */
const MIN_ANSWER_CHARS = 400;

const [sceneFile, ...flags] = process.argv.slice(2);
if (!sceneFile) {
  console.error('usage: npm run capture -- <scene.json> [--probe]');
  process.exit(2);
}
const scene = JSON.parse(fs.readFileSync(sceneFile, 'utf8')) as Scene;
const cfg = parseConfig(process.env, { capture: true, tts: false });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const runDir = path.resolve('out', `${path.basename(sceneFile, '.json')}-${stamp}`);
const session = await loginDemoCached(cfg, path.resolve('out', '.session.json'));
const assistantsCount = await countAssistants(cfg);
const result = await captureChat(scene, cfg, session, runDir, {
  minAnswerChars: MIN_ANSWER_CHARS,
  assistantsCount,
  probeOnly: flags.includes('--probe'),
});
if (!result) {
  console.log(`capture: проба → ${path.join(runDir, 'probe.png')}`);
} else {
  fs.writeFileSync(path.join(runDir, 'capture.json'), JSON.stringify(result, null, 2));
  console.log(`capture: готово → ${runDir} (ходов: ${result.turns}, абзацев: ${result.boxes.length})`);
  for (const b of result.boxes) console.log(`  [${b.n}] ${b.text}`);
}
