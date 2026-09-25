import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveWithin, makeReadWithinDirGuard, AGENT_GUARD_DENY_MESSAGE } from './agent-guards';

/**
 * Страж canUseTool для scan-document (chat.controller): содержимое файла —
 * недоверенное, поэтому Read разрешён ТОЛЬКО в пределах одноразового каталога
 * загрузки. Тесты бьют по всем дырам, на которые уже наступали:
 *   • алиас /tmp ↔ /private/tmp (на macOS модель присылала /tmp/…, а cwd был
 *     /private/tmp/…): проверяем, что realpath сводит оба написания;
 *   • симлинк ВНУТРИ каталога, указывающий наружу, — типовой обход;
 *   • несуществующий путь — не должен «проскочить» как разрешённый;
 *   • любой тул, кроме Read, и Read без file_path — отказ.
 */

let root: string;      // «настоящий» каталог
let outside: string;   // каталог снаружи
let aliasToRoot: string; // симлинк-алиас на root (проверка алиасинга путей)

beforeEach(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-spec-'));
  root = fs.mkdtempSync(path.join(base, 'root-'));
  outside = fs.mkdtempSync(path.join(base, 'outside-'));
  fs.writeFileSync(path.join(root, 'inside.txt'), 'INSIDE');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'SECRET');
  aliasToRoot = path.join(base, 'alias-root');
  fs.symlinkSync(root, aliasToRoot);
});

afterEach(() => {
  // Чистим базовый каталог целиком (root/outside/alias лежат под ним).
  try { fs.rmSync(path.dirname(root), { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('resolveWithin', () => {
  it('разрешает файл прямо внутри каталога и канонизирует путь', () => {
    const r = resolveWithin(root, path.join(root, 'inside.txt'));
    expect(r).toBe(fs.realpathSync(path.join(root, 'inside.txt')));
  });

  it('принимает относительное имя (от каталога)', () => {
    expect(resolveWithin(root, 'inside.txt')).toBe(fs.realpathSync(path.join(root, 'inside.txt')));
  });

  it('сводит алиас каталога: root задан симлинком, путь — «настоящий»', () => {
    // Guard построен на алиасе (aliasToRoot), а модель прислала реальный путь.
    expect(resolveWithin(aliasToRoot, path.join(root, 'inside.txt'))).not.toBeNull();
  });

  it('сводит алиас каталога: root «настоящий», путь через симлинк', () => {
    // Обратное направление — как /private/tmp (cwd) vs /tmp (аргумент модели).
    expect(resolveWithin(root, path.join(aliasToRoot, 'inside.txt'))).not.toBeNull();
  });

  it('отклоняет файл снаружи каталога', () => {
    expect(resolveWithin(root, path.join(outside, 'secret.txt'))).toBeNull();
  });

  it('отклоняет побег через симлинк внутри каталога наружу', () => {
    const escape = path.join(root, 'escape.txt');
    fs.symlinkSync(path.join(outside, 'secret.txt'), escape);
    expect(resolveWithin(root, escape)).toBeNull();
  });

  it('отклоняет несуществующий путь', () => {
    expect(resolveWithin(root, path.join(root, 'nope.txt'))).toBeNull();
  });

  it('отклоняет соседний каталог с общим префиксом имени (граница по разделителю)', () => {
    const sibling = `${root}-sibling`;
    fs.mkdirSync(sibling);
    fs.writeFileSync(path.join(sibling, 'x.txt'), 'X');
    expect(resolveWithin(root, path.join(sibling, 'x.txt'))).toBeNull();
    fs.rmSync(sibling, { recursive: true, force: true });
  });
});

describe('makeReadWithinDirGuard', () => {
  it('разрешает Read внутри каталога и подменяет file_path на канонический', async () => {
    const guard = makeReadWithinDirGuard(root);
    const res = await guard('Read', { file_path: path.join(root, 'inside.txt') });
    expect(res.behavior).toBe('allow');
    if (res.behavior === 'allow') {
      expect(res.updatedInput.file_path).toBe(fs.realpathSync(path.join(root, 'inside.txt')));
    }
  });

  it('разрешает Read при алиасе каталога (/tmp ↔ /private/tmp)', async () => {
    const guard = makeReadWithinDirGuard(aliasToRoot);
    const res = await guard('Read', { file_path: path.join(root, 'inside.txt') });
    expect(res.behavior).toBe('allow');
  });

  it('запрещает Read снаружи', async () => {
    const guard = makeReadWithinDirGuard(root);
    const res = await guard('Read', { file_path: path.join(outside, 'secret.txt') });
    expect(res).toEqual({ behavior: 'deny', message: AGENT_GUARD_DENY_MESSAGE });
  });

  it('запрещает побег через симлинк наружу', async () => {
    const escape = path.join(root, 'escape.txt');
    fs.symlinkSync(path.join(outside, 'secret.txt'), escape);
    const guard = makeReadWithinDirGuard(root);
    const res = await guard('Read', { file_path: escape });
    expect(res.behavior).toBe('deny');
  });

  it('запрещает несуществующий путь', async () => {
    const guard = makeReadWithinDirGuard(root);
    const res = await guard('Read', { file_path: path.join(root, 'nope.txt') });
    expect(res.behavior).toBe('deny');
  });

  it('запрещает любой тул, кроме Read (Bash/Write/Edit/Glob/Grep)', async () => {
    const guard = makeReadWithinDirGuard(root);
    for (const t of ['Bash', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch']) {
      const res = await guard(t, { file_path: path.join(root, 'inside.txt'), command: 'echo hi' });
      expect(res.behavior).toBe('deny');
    }
  });

  it('запрещает Read без file_path', async () => {
    const guard = makeReadWithinDirGuard(root);
    expect((await guard('Read', {})).behavior).toBe('deny');
    expect((await guard('Read', { file_path: '' })).behavior).toBe('deny');
  });
});
