import { GOLDEN_TURNS } from './golden-turns';
import { shouldSkipBusinessExtraction } from './extract-prefilter';

describe('golden-набор извлечения', () => {
  it('набор заполнен и сбалансирован', () => {
    expect(GOLDEN_TURNS.length).toBeGreaterThanOrEqual(20);
    const positive = GOLDEN_TURNS.filter(t => Object.keys(t.expected).length > 0);
    const negative = GOLDEN_TURNS.filter(t => Object.keys(t.expected).length === 0);
    expect(positive.length).toBeGreaterThanOrEqual(10);
    expect(negative.length).toBeGreaterThanOrEqual(10);
  });

  it('префильтр не срезает ни одного хода, из которого надо извлечь факт', () => {
    const wronglySkipped = GOLDEN_TURNS
      .filter(t => Object.keys(t.expected).length > 0)
      .filter(t => shouldSkipBusinessExtraction(t.user));
    expect(wronglySkipped.map(t => t.user)).toEqual([]);
  });

  it('префильтр срезает большинство ходов без фактов', () => {
    const negative = GOLDEN_TURNS.filter(t => Object.keys(t.expected).length === 0);
    const skipped = negative.filter(t => shouldSkipBusinessExtraction(t.user));
    // Не 100%: часть попадёт в LLM и там отсеется. Но если префильтр
    // пропускает почти всё, он не выполняет свою работу — экономить вызовы.
    expect(skipped.length / negative.length).toBeGreaterThanOrEqual(0.6);
  });
});
