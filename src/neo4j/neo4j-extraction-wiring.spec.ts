import * as fs from 'fs';
import * as path from 'path';

/**
 * Текст промпта извлекателя живёт только в profile-extraction-prompt.ts: там
 * его проверяют тесты. Вторая копия в сервисе разошлась бы с проверенной молча.
 */
describe('Neo4jService: промпт извлечения профиля', () => {
  const src = fs.readFileSync(path.join(__dirname, 'neo4j.service.ts'), 'utf8');

  it('собирается функцией buildProfileExtractionPrompt', () => {
    expect(src).toContain("from './profile-extraction-prompt'");
    expect(src).toMatch(/buildProfileExtractionPrompt\(\s*prevAssistant,\s*userMessage,\s*assistantResponse\s*\)/);
  });

  it('своей копии текста в сервисе нет', () => {
    expect(src).not.toContain('Извлеки психологический профиль');
  });
});
