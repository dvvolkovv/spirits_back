import * as fs from 'fs';
import * as path from 'path';
import { RESPONSE_STYLE_RULE } from './response-style';

/// Требование к форме ответа должно попадать в КАЖДЫЙ собираемый промпт.
///
/// Ровно та же ловушка, что с языковой директивой (см. prompt-language-tail.spec.ts):
/// путей сборки промпта в chat.service несколько, забыть один легко, и заметит
/// это пользователь — по ассистенту, который один продолжает писать простыни.
///
/// Тест смотрит на исходник, а не на поведение: поведение проверяется живым
/// запросом, но регрессию «добавили четвёртый путь и не вставили правило»
/// поведенческий тест не поймает вовсе.
describe('форма ответа в промпте ассистента', () => {
  const src = fs.readFileSync(path.join(__dirname, 'chat.service.ts'), 'utf8');

  it('правило вставлено во все пути сборки промпта', () => {
    // Сколько путей приклеивают языковую строку — столько же должны приклеить
    // и правило формы: это одни и те же места. Считаем по фолбэку, он ровно
    // один на путь (сама константа в строке упоминается дважды).
    const tails = src.match(/LANGUAGE_REPLY_LINE\[DEFAULT_LANGUAGE\]/g) || [];
    const styles = src.match(/RESPONSE_STYLE_RULE/g) || [];
    expect(tails.length).toBeGreaterThan(0);
    // -1: строка импорта.
    expect(styles.length - 1).toBeGreaterThanOrEqual(tails.length);
  });

  it('правило не потеряно из импорта', () => {
    expect(src).toMatch(/import \{ RESPONSE_STYLE_RULE \}/);
  });

  it('текст правила несёт все три требования владельца', () => {
    expect(RESPONSE_STYLE_RULE).toContain('короткими и сжатыми');
    expect(RESPONSE_STYLE_RULE).toContain('дисклеймеры');
    expect(RESPONSE_STYLE_RULE).toContain('высокоуровневое резюме');
  });
});
