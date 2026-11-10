import { formatRetentionInactivity, normalizeRetentionName } from './retention-personalization';

describe('retention personalization', () => {
  it('берёт имя после trim, отсекает пустое и длиннее 80 символов', () => {
    expect(normalizeRetentionName('  Дмитрий  ')).toBe('Дмитрий');
    expect(normalizeRetentionName('')).toBeNull();
    expect(normalizeRetentionName(null)).toBeNull();
    expect(normalizeRetentionName('x'.repeat(80))).toHaveLength(80);
    expect(normalizeRetentionName('x'.repeat(81))).toBeNull();
  });

  it.each([
    ['ru', 'general', 1, undefined, '1 день'],
    ['ru', 'general', 3, undefined, '3 дня'],
    ['ru', 'general', 5, undefined, '5 дней'],
    ['ru', 'curious', undefined, 25, '25 часов'],
    ['en', 'general', 1, undefined, '1 day'],
    ['en', 'general', 3, undefined, '3 days'],
    ['en', 'curious', undefined, 25, '25 hours'],
    ['de', 'general', 1, undefined, 'einem Tag'],
    ['de', 'general', 3, undefined, '3 Tagen'],
    ['zh', 'general', 3, undefined, '3天'],
    ['zh', 'curious', undefined, 25, '25小时'],
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
