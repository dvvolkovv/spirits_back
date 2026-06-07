/**
 * Unit-тест списка исключаемых из расчёта «Персон» (фидбэк владельца: из метрик
 * должны выпадать тестовые пользователи и сам владелец).
 * Inline-копия логики personas.service (как остальные veo/* тесты).
 *
 * Контракт:
 *  - тест-номера (mirror auth.controller.isTestPhone) всегда в списке, в т.ч.
 *    79656445804 (номер Claude) — раньше его НЕ было, он попадал в расчёт;
 *  - env FUNNEL_EXCLUDED_USERS добавляется и дедуплицируется;
 *  - владелец и любые админы исключаются отдельно — подзапросом по isadmin=true
 *    (динамически, поэтому в этот список не хардкодятся).
 */

const TEST_PHONES = ['70000000000', '79030169187', '79169403771', '79656445804'];
function buildExcluded(envVal) {
  const env = (envVal || '').split(',').map((s) => s.trim()).filter(Boolean);
  return Array.from(new Set([...TEST_PHONES, ...env]));
}

describe('Personas excluded users', () => {
  test('канонические тест-номера всегда исключены (в т.ч. номер Claude 79656445804)', () => {
    const ex = buildExcluded('');
    for (const p of ['70000000000', '79030169187', '79169403771', '79656445804']) {
      expect(ex).toContain(p);
    }
  });

  test('env FUNNEL_EXCLUDED_USERS добавляется и дедуплицируется', () => {
    const ex = buildExcluded('79991112233, 79030169187');
    expect(ex).toContain('79991112233');         // новый из env
    expect(ex.filter((x) => x === '79030169187')).toHaveLength(1); // без дублей
  });

  test('пустой env не ломает список', () => {
    expect(buildExcluded(undefined).length).toBe(4);
  });
});
