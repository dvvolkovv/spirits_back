import { BUSINESS_FIELDS, ENUM_LABELS, renderEnum, isBusinessProfileEmpty } from './business-profile.types';

describe('business profile types', () => {
  it('описывает ровно восемь полей', () => {
    expect(BUSINESS_FIELDS).toHaveLength(8);
    expect(BUSINESS_FIELDS.map(f => f.key)).toEqual([
      'what', 'legal_form', 'tax_mode', 'stage', 'revenue', 'team', 'customers', 'focus',
    ]);
  });

  it('рендерит enum-код в человекочитаемое название', () => {
    expect(renderEnum('tax_mode', 'usn_d')).toBe('УСН Доходы');
    expect(renderEnum('legal_form', 'ip')).toBe('ИП');
  });

  it('неизвестный enum-код отдаёт сам код, а не роняет рендер', () => {
    expect(renderEnum('tax_mode', 'no_such_mode')).toBe('no_such_mode');
  });

  it('поле без enum-словаря отдаёт значение как есть', () => {
    expect(renderEnum('what', 'студия маникюра')).toBe('студия маникюра');
  });

  it('пустая карточка распознаётся как пустая', () => {
    expect(isBusinessProfileEmpty(undefined)).toBe(true);
    expect(isBusinessProfileEmpty({})).toBe(true);
    expect(isBusinessProfileEmpty({ what: { value: '', source: 'user', updated_at: 'x' } })).toBe(true);
  });

  it('карточка с одним заполненным полем пустой не считается', () => {
    expect(isBusinessProfileEmpty({
      what: { value: 'студия маникюра', source: 'user', updated_at: '2026-08-25T00:00:00Z' },
    })).toBe(false);
  });

  it('у каждого enum-поля словарь покрывает все допустимые значения', () => {
    for (const f of BUSINESS_FIELDS) {
      if (!f.enum) continue;
      for (const v of f.enum) {
        expect(ENUM_LABELS[f.key]?.[v]).toBeTruthy();
      }
    }
  });
});
