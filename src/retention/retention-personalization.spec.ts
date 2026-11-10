import { formatRetentionInactivity, normalizeRetentionName } from './retention-personalization';

describe('retention personalization', () => {
  it('берёт имя после trim, отсекает пустое и длиннее 80 символов', () => {
    expect(normalizeRetentionName('  Дмитрий  ')).toBe('Дмитрий');
    expect(normalizeRetentionName('')).toBeNull();
    expect(normalizeRetentionName(null)).toBeNull();
    expect(normalizeRetentionName('x'.repeat(80))).toHaveLength(80);
    expect(normalizeRetentionName('x'.repeat(81))).toBeNull();
  });

  it('считает лимит имени по code points, а не по UTF-16 code units', () => {
    const emojiName = '😀'.repeat(41);
    expect(Array.from(emojiName)).toHaveLength(41);
    expect(normalizeRetentionName(emojiName)).toBe(emojiName);
    expect(normalizeRetentionName('x'.repeat(81))).toBeNull();
  });

  it.each([
    ['ru', 'general', 1, undefined, '1 день'],
    ['ru', 'general', 3, undefined, '3 дня'],
    ['ru', 'general', 5, undefined, '5 дней'],
    ['ru', 'curious', undefined, 1, '1 час'],
    ['ru', 'curious', undefined, 2, '2 часа'],
    ['ru', 'curious', undefined, 5, '5 часов'],
    ['ru', 'curious', undefined, 25, '25 часов'],
    ['en', 'general', 1, undefined, '1 day'],
    ['en', 'general', 3, undefined, '3 days'],
    ['en', 'curious', undefined, 1, '1 hour'],
    ['en', 'curious', undefined, 25, '25 hours'],
    ['es', 'general', 1, undefined, '1 día'],
    ['es', 'general', 3, undefined, '3 días'],
    ['es', 'curious', undefined, 1, '1 hora'],
    ['es', 'curious', undefined, 25, '25 horas'],
    ['de', 'general', 1, undefined, 'einem Tag'],
    ['de', 'general', 3, undefined, '3 Tagen'],
    ['de', 'curious', undefined, 1, 'einer Stunde'],
    ['de', 'curious', undefined, 3, '3 Stunden'],
    ['fr', 'general', 1, undefined, '1 jour'],
    ['fr', 'general', 3, undefined, '3 jours'],
    ['fr', 'curious', undefined, 1, '1 heure'],
    ['fr', 'curious', undefined, 25, '25 heures'],
    ['zh', 'general', 3, undefined, '3天'],
    ['zh', 'curious', undefined, 25, '25小时'],
    ['pt', 'general', 1, undefined, '1 dia'],
    ['pt', 'general', 3, undefined, '3 dias'],
    ['pt', 'curious', undefined, 1, '1 hora'],
    ['pt', 'curious', undefined, 25, '25 horas'],
  ])('%s/%s: %s → %s', (language, mode, days, hours, expected) => {
    expect(formatRetentionInactivity(language, mode as any, days, hours)).toBe(expected);
  });

  it('пропускает отрицательную, дробную, строковую и отсутствующую паузу', () => {
    for (const value of [-1, 1.5, Number.NaN, '3', undefined, null]) {
      expect(formatRetentionInactivity('ru', 'general', value, undefined)).toBeNull();
    }
    expect(formatRetentionInactivity('ru', 'curious', 3, undefined)).toBeNull();
  });
});
