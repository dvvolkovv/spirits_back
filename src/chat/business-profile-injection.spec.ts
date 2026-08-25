import * as fs from 'fs';
import * as path from 'path';

/**
 * Структурный тест: карточка должна попадать во ВСЕ места сборки промпта.
 *
 * Обычным юнит-тестом это не поймать — streamUniversalAgent не вызвать без
 * половины приложения. Но пропуск одного из путей и есть основной
 * риск задачи: код при этом работает, просто часть ассистентов слепа.
 * Поэтому проверяем текстом файла.
 *
 * ЧТО ЭТОТ ТЕСТ НЕ ПОКРЫВАЕТ (важно помнить при следующей правке промпта):
 * — До 2026-08-25 здесь проверялся только chat.service.ts, и он не увидел
 *   четвёртый путь — SMM-продюсер (Юля, agent.name='smm_producer'), который
 *   уходит в отдельную ветку РАНЬШЕ streamUniversalAgent и собирает system
 *   prompt в claude-agent.service.ts через Claude Agent SDK. Юля молчала
 *   про бизнес-карточку, а этот тест был зелёным. Теперь claude-agent.service.ts
 *   тоже проверяется явно (см. ниже) — но он проверяется ТЕМ ЖЕ текстовым
 *   способом и с теми же ограничениями.
 * — Это текстовый grep по конкретным двум файлам, а не семантический анализ
 *   потока данных. Он не проверяет, что renderForPrompt/extractFromTurn
 *   реально достижимы из runtime-пути (например, если вызов окажется в
 *   мёртвой ветке или под always-false условием — тест этого не заметит).
 *   Не проверяет также кастомных ассистентов (custom:<uuid>), relay-путь
 *   (r.linkeon.io, generateAgentReply) — там подстановка есть, но это
 *   отдельные ветки с собственными паттернами, см. тесты выше.
 *   Любой будущий пятый путь сборки промпта эта проверка тоже не увидит,
 *   пока про него явно не напишут новую строчку здесь.
 */
describe('инъекция бизнес-карточки в сборку промпта', () => {
  const src = fs.readFileSync(path.join(__dirname, 'chat.service.ts'), 'utf8');
  const claudeAgentSrc = fs.readFileSync(path.join(__dirname, 'claude-agent.service.ts'), 'utf8');

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

  it('четвёртый путь (Юля/smm_producer) тоже рендерит карточку — claude-agent.service.ts', () => {
    expect(claudeAgentSrc).toMatch(/businessProfile\??\.renderForPrompt\(/);
  });

  it('четвёртый путь (Юля/smm_producer) тоже зовёт извлечение фактов — claude-agent.service.ts', () => {
    expect(claudeAgentSrc).toMatch(/businessProfile\??\.extractFromTurn\(/);
  });

  it('вызов streamSmmProducer передаёт category и fresh дальше в claude-agent.service.ts', () => {
    expect(src).toMatch(/streamSmmProducer\([^)]*agent\.category[^)]*fresh[^)]*\)/);
  });
});
