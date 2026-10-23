import { classifySpend, spendCategorySql, buildCategorySql, SPEND_RULES, type SpendRule } from './spend-category';
import { SPEND_SAMPLES } from './spend-category.samples';

describe('classifySpend', () => {
  it.each(SPEND_SAMPLES)('«%s» %j → %s', (description, metadata, expected) => {
    expect(classifySpend(description, metadata)).toBe(expected);
  });

  it('незнакомая подпись — other', () => {
    expect(classifySpend('что-то новое', null)).toBe('other');
  });

  it('подпись сравнивается целиком, а не подстрокой', () => {
    expect(classifySpend('image edit', null)).toBe('other');
    expect(classifySpend('Возврат за видео', null)).toBe('other');
  });

  it('callId: null не делает строку звонком — как ->> в SQL', () => {
    expect(classifySpend('Ответ ассистента', { callId: null })).toBe('replies');
  });
});

describe('spendCategorySql', () => {
  it('ветка на каждое правило в порядке SPEND_RULES и other по умолчанию', () => {
    const sql = spendCategorySql();
    const positions = SPEND_RULES.map((r) => sql.indexOf(`THEN '${r.category}'`));
    expect(positions.every((p) => p > 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(sql).toMatch(/ELSE 'other' END$/);
  });

  it('звонок — по ->> (JSON null не звонок), подписи — целиком и по началу', () => {
    const sql = spendCategorySql('t.description', 't.metadata');
    expect(sql).toContain(`(t.metadata ->> 'callId') IS NOT NULL`);
    expect(sql).toContain(`t.description = 'image'`);
    expect(sql).toContain(`starts_with(t.description, 'Ответ ассистента')`);
    expect(sql).toContain('t.description IS NULL');
  });
});

describe('buildCategorySql', () => {
  it('правило без единого условия — ошибка, а не тихий "WHEN THEN"', () => {
    const broken: SpendRule[] = [{ category: 'images' }];
    expect(() => buildCategorySql(broken, 'description', 'metadata')).toThrow(
      /images.*не задаёт ни одного условия/,
    );
  });
});
