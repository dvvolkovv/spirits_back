import * as fs from 'fs';
import * as path from 'path';

/**
 * Структурный тест: карточка должна попадать во ВСЕ места сборки промпта.
 *
 * Обычным юнит-тестом это не поймать — streamUniversalAgent не вызвать без
 * половины приложения. Но пропуск одного из трёх путей и есть основной
 * риск задачи: код при этом работает, просто часть ассистентов слепа.
 * Поэтому проверяем текстом файла.
 */
describe('инъекция бизнес-карточки в сборку промпта', () => {
  const src = fs.readFileSync(path.join(__dirname, 'chat.service.ts'), 'utf8');

  it('профиль пользователя подставляется ровно в трёх местах', () => {
    const matches = src.match(/User profile:|--- Профиль пользователя ---/g) || [];
    expect(matches).toHaveLength(3);
  });

  it('рядом с каждой подстановкой профиля зовётся renderForPrompt', () => {
    const calls = src.match(/renderForPrompt\(/g) || [];
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });

  it('категория агента доезжает до streamUniversalAgent', () => {
    expect(src).toMatch(/a\.category|agent\.category/);
  });

  it('извлечение бизнес-фактов зовётся везде, где зовётся извлечение задач', () => {
    const tasks = (src.match(/tasksService\.extractFromTurn\(/g) || []).length;
    const business = (src.match(/businessProfile\.extractFromTurn\(/g) || []).length;
    expect(business).toBe(tasks);
  });
});
