#!/usr/bin/env node
// Подписи справки (src/platform-kb/labels.generated.ts) — из локалей фронта.
//   node scripts/sync-kb-labels.mjs [путь к spirits_front]   (по умолчанию ../spirits_front)
// Пути ключей — src/platform-kb/label-keys.json. Ключа нет хоть в одной локали
// или он пустой — отказ: справка не должна называть кнопку, которой нет.
// Файл пишется в UTF-8 как есть (JSON.stringify не экранирует не-ASCII):
// ручной копии и \uXXXX-экранирования нет.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FRONT = path.resolve(process.argv[2] || path.join(ROOT, '..', 'spirits_front'));
const LANGS = ['ru', 'en', 'es', 'de', 'fr', 'zh', 'pt'];
const keys = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/platform-kb/label-keys.json'), 'utf8'));

const get = (obj, p) => p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
const out = {};
const problems = [];
for (const lang of LANGS) {
  const loc = JSON.parse(fs.readFileSync(path.join(FRONT, 'src/i18n/locales', `${lang}.json`), 'utf8'));
  out[lang] = {};
  for (const [name, p] of Object.entries(keys)) {
    const v = get(loc, p);
    if (typeof v !== 'string' || !v.trim()) {
      problems.push(`${lang}: ${p} (${name})`);
      continue;
    }
    out[lang][name] = v.trim();
  }
}
if (problems.length) {
  console.error('Нет подписей:\n  ' + problems.join('\n  '));
  process.exit(1);
}

const names = Object.keys(keys);
const body = [
  '// СГЕНЕРИРОВАНО scripts/sync-kb-labels.mjs из локалей spirits_front — руками не править.',
  '// Пути ключей — src/platform-kb/label-keys.json.',
  '',
  `export const KB_LABEL_KEYS = ${JSON.stringify(names)} as const;`,
  'export type KbLabelKey = (typeof KB_LABEL_KEYS)[number];',
  '',
  'export const KB_LABELS: Record<string, Record<KbLabelKey, string>> = {',
  ...LANGS.map((lang) => `  ${lang}: {\n${names.map((n) => `    ${n}: ${JSON.stringify(out[lang][n])},`).join('\n')}\n  },`),
  '};',
  '',
].join('\n');
fs.writeFileSync(path.join(ROOT, 'src/platform-kb/labels.generated.ts'), body);
console.log(`labels.generated.ts: ${names.length} подписей × ${LANGS.length} языков`);
