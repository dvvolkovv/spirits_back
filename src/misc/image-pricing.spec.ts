import * as fs from 'fs';
import * as path from 'path';
import { IMAGE_TOKENS_HD, IMAGE_TOKENS_STD, imageTokens } from './image-pricing';

/**
 * Цена картинки — одна константа на списание, проверки баланса и справку
 * (platform-kb/values.ts). До 24.10.2026 она стояла литералом в пятнадцати
 * местах трёх файлов: смена цены в одном из них молча расходилась бы с
 * остальными и со справкой.
 */
describe('цена картинки', () => {
  it('hd — HD, всё остальное — обычное', () => {
    expect(imageTokens('hd')).toBe(IMAGE_TOKENS_HD);
    expect(imageTokens('std')).toBe(IMAGE_TOKENS_STD);
    expect(imageTokens(undefined)).toBe(IMAGE_TOKENS_STD);
    expect(IMAGE_TOKENS_HD).toBeGreaterThan(IMAGE_TOKENS_STD);
  });

  it('литералов цены в списании и проверках больше нет', () => {
    for (const f of ['misc.service.ts', 'misc.controller.ts', '../chat/chat-tools.ts']) {
      const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
      expect(src).not.toMatch(/'hd' \? 10_?000 : 5_?000/);
      expect(src).not.toMatch(/tokenCost = 10_?000/);
      expect(src).not.toMatch(/, 10_?000\);/);
    }
  });
});
