import * as fs from 'fs';
import * as path from 'path';

/**
 * СТОРОЖ ИСХОДНИКОВ: держит lockdown тулов на месте (безопасность, 25.09.2026).
 *
 * Две проверки по всему src/ (кроме *.spec.ts):
 *   1) Каждый вызов Agent SDK `query({...})` обязан явно задавать `tools:` в
 *      объекте опций. Без tools + bypassPermissions SDK отдаёт модели ПОЛНЫЙ
 *      набор Claude Code (Bash/Read/Write/WebFetch…) — тот самый провал, ради
 *      которого всё и делается. Это ловит регрессию «добавили новый вызов query
 *      и забыли tools».
 *   2) Ни один вызов claudeCli.text()/textWithCost() не передаёт allowedTools с
 *      Bash|Write|Edit в ЛИТЕРАЛЬНОМ значении. (Переменную-набор проверить
 *      текстом нельзя — это осознанный предел; литерал с агентными тулами
 *      значил бы возврат снятого доступа мимо ревью.)
 *
 * Разбор идёт по тексту без комментариев и с балансировкой скобок — «query(» в
 * комментарии или `this.pg.query(` под проверку не попадают.
 */

// ── Утилиты разбора (экспортируемые логически — тестируются и на синтетике) ──

/** Грубое, но надёжное удаление комментариев с учётом строковых литералов. */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  let str: string | null = null; // текущий строковый разделитель ' " `
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (str) {
      out += c;
      if (c === '\\') { out += d ?? ''; i += 2; continue; }
      if (c === str) str = null;
      i++;
      continue;
    }
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === "'" || c === '"' || c === '`') { str = c; out += c; i++; continue; }
    out += c;
    i++;
  }
  return out;
}

/** Аргументы вызова от индекса открывающей '(' до её парной ')'. */
function balancedCall(src: string, openParenIdx: number): string {
  let depth = 0;
  for (let i = openParenIdx; i < src.length; i++) {
    const c = src[i];
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return src.slice(openParenIdx + 1, i); }
  }
  return src.slice(openParenIdx + 1); // несбалансировано — вернём хвост
}

/** true, если файл импортирует query из Agent SDK. */
function importsSdkQuery(src: string): boolean {
  return /import\s*\{[^}]*\bquery\b[^}]*\}\s*from\s*['"]@anthropic-ai\/claude-agent-sdk['"]/.test(src);
}

/** Вызовы SDK query({...}) без явного tools: в объекте опций. */
export function sdkQueryCallsMissingTools(src: string): number {
  const clean = stripComments(src);
  if (!importsSdkQuery(clean)) return 0;
  let count = 0;
  // Голое query( — не .query( (this.pg.query, client.query, tx.query …).
  const re = /(^|[^.\w])query\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    const open = clean.indexOf('(', m.index + m[0].length - 1);
    const call = balancedCall(clean, open);
    // Внутри аргумента query должен где-то стоять tools: (в объекте options).
    if (!/(^|[\s,{])tools\s*:/.test(call)) count++;
  }
  return count;
}

/** Вызовы claudeCli.text/textWithCost с литеральным allowedTools, содержащим агентный тул. */
export function badAllowedToolsCallers(src: string): number {
  const clean = stripComments(src);
  let count = 0;
  const re = /\.\s*(text|textWithCost)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    const open = clean.indexOf('(', m.index + m[0].length - 1);
    const call = balancedCall(clean, open);
    // allowedTools: '<...Bash|Write|Edit...>' в литерале (строка или шаблон).
    if (/allowedTools\s*:\s*['"`][^'"`]*\b(Bash|Write|Edit)\b/.test(call)) count++;
  }
  return count;
}

// ── Обход дерева ──

function walkTs(dir: string, acc: string[]): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules') continue;
      walkTs(full, acc);
    } else if (e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts') && !e.name.endsWith('.d.ts')) {
      acc.push(full);
    }
  }
}

const SRC_ROOT = path.resolve(__dirname, '..');

describe('lockdown: SDK query() всегда с явным tools:', () => {
  const files: string[] = [];
  walkTs(SRC_ROOT, files);

  it('во всём src нет вызовов query() без tools:', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      const n = sdkQueryCallsMissingTools(src);
      if (n > 0) offenders.push(`${path.relative(SRC_ROOT, f)} (${n})`);
    }
    expect(offenders).toEqual([]);
  });

  it('каждый файл с SDK query() ссылается на neutralizeAtMentions (@-упоминания обезврежены)', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      const clean = stripComments(src);
      if (!importsSdkQuery(clean)) continue;
      // Файл вызывает SDK query → обязан обезвреживать @-упоминания во вводе.
      if (!/\bneutralizeAtMentions\b/.test(clean)) offenders.push(path.relative(SRC_ROOT, f));
    }
    expect(offenders).toEqual([]);
  });

  it('во всём src нет claudeCli.text/textWithCost с литеральным Bash|Write|Edit в allowedTools', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      const n = badAllowedToolsCallers(src);
      if (n > 0) offenders.push(`${path.relative(SRC_ROOT, f)} (${n})`);
    }
    expect(offenders).toEqual([]);
  });
});

describe('lockdown: сам детектор различает оба направления', () => {
  const withImport = `import { query } from '@anthropic-ai/claude-agent-sdk';\n`;

  it('краснеет на query() без tools:', () => {
    const bad = withImport + `for await (const e of query({ prompt: p, options: { model: 'x', permissionMode: 'bypassPermissions' } as any })) {}`;
    expect(sdkQueryCallsMissingTools(bad)).toBe(1);
  });

  it('зеленеет на query() с tools:', () => {
    const good = withImport + `for await (const e of query({ prompt: p, options: { model: 'x', tools: [], permissionMode: 'bypassPermissions' } as any })) {}`;
    expect(sdkQueryCallsMissingTools(good)).toBe(0);
  });

  it('не путает this.pg.query() с SDK query()', () => {
    const pg = withImport + `const r = await this.pg.query('SELECT 1'); for await (const e of query({ options: { tools: [] } })) {}`;
    expect(sdkQueryCallsMissingTools(pg)).toBe(0);
  });

  it('игнорирует query( в комментарии', () => {
    const commented = withImport + `// пример: query({ options: {} }) без tools\nfor await (const e of query({ options: { tools: [] } })) {}`;
    expect(sdkQueryCallsMissingTools(commented)).toBe(0);
  });

  it('краснеет на allowedTools с литеральным Bash', () => {
    const bad = `await this.claude.textWithCost(p, { allowedTools: 'Bash,Write,Read,Edit' });`;
    expect(badAllowedToolsCallers(bad)).toBe(1);
  });

  it('зеленеет на allowedTools-переменную и на веб-литерал', () => {
    const okVar = `await this.claudeCli.textWithCost(p, { tools, allowedTools });`;
    const okWeb = `await this.claudeCli.text(p, { allowedTools: 'WebSearch,WebFetch' });`;
    expect(badAllowedToolsCallers(okVar)).toBe(0);
    expect(badAllowedToolsCallers(okWeb)).toBe(0);
  });
});
