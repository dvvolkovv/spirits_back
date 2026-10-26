#!/usr/bin/env ts-node
/**
 * Сценки + сценарий студии → сценарий с готовыми промптами (ролик-образец
 * со сценками, план 3). В конвейере (план 4) то же самое сделает сценарист.
 *
 *   npx ts-node scripts/shorts-skit-plan.ts <skits.json> <script.base.json> <out/script.json>
 *
 * skits.json — { conflict: Skit, punchline: Skit } (src/shorts/short-skit-prompts.ts);
 * script.base.json — сценарий студии без сценок (studio/src/types.ts, Script).
 */
import * as fs from 'fs';
import * as path from 'path';
import { planSkit, Skit } from '../src/shorts/short-skit-prompts';

const [skitsPath, basePath, outPath] = process.argv.slice(2);
if (!skitsPath || !basePath || !outPath) {
  console.error('usage: npx ts-node scripts/shorts-skit-plan.ts <skits.json> <script.base.json> <out/script.json>');
  process.exit(2);
}
const skits = JSON.parse(fs.readFileSync(skitsPath, 'utf8')) as { conflict: Skit; punchline: Skit };
const base = JSON.parse(fs.readFileSync(basePath, 'utf8'));
const script = {
  ...base,
  skits: { conflict: planSkit(skits.conflict, 'conflict'), punchline: planSkit(skits.punchline, 'punchline') },
};
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(script, null, 2));
console.log(`skit-plan: ${outPath} — conflict ${script.skits.conflict.fingerprint}, punchline ${script.skits.punchline.fingerprint}`);
