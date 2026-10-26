#!/usr/bin/env ts-node
/**
 * Сценки + сценарий студии → сценарий с готовыми промптами (ролик-образец
 * со сценками, план 3). В конвейере (план 4) то же самое сделает сценарист.
 *
 *   npx ts-node scripts/shorts-skit-plan.ts <skits.json> <script.base.json> <out/script.json>
 *
 * skits.json — { conflict: Skit, punchline: Skit } (src/shorts/short-skit-prompts.ts);
 * script.base.json — сценарий студии без сценок (studio/src/types.ts, Script).
 * Ошибка входа — сообщение с именем файла и код 2: скрипт — последняя проверка
 * сценок перед платными генерациями.
 */
import * as fs from 'fs';
import * as path from 'path';
import { planSkits, Skit } from '../src/shorts/short-skit-prompts';

function fail(file: string, msg: string): never {
  console.error(`skit-plan: ${file} — ${msg}`);
  process.exit(2);
}

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fail(file, e instanceof Error ? e.message : String(e));
  }
}

const [skitsPath, basePath, outPath] = process.argv.slice(2);
if (!skitsPath || !basePath || !outPath) {
  console.error('usage: npx ts-node scripts/shorts-skit-plan.ts <skits.json> <script.base.json> <out/script.json>');
  process.exit(2);
}
const skits = readJson(skitsPath) as { conflict?: Skit; punchline?: Skit };
if (!skits?.conflict || !skits?.punchline) fail(skitsPath, 'нужны обе сценки: conflict и punchline');
const base = readJson(basePath);
let plans: ReturnType<typeof planSkits>;
try {
  plans = planSkits({ conflict: skits.conflict, punchline: skits.punchline });
} catch (e) {
  fail(skitsPath, e instanceof Error ? e.message : String(e));
}
const script = { ...base, skits: plans };
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(script, null, 2));
console.log(`skit-plan: ${outPath} — conflict ${plans.conflict.fingerprint}, punchline ${plans.punchline.fingerprint}`);
