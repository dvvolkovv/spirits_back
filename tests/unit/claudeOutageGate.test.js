/**
 * Unit-тест гейтинга алерта о простое Claude CLI (claude-health.maybeAlertOutage).
 * Инцидент 2026-06-10: проба ложно слала «весь AI недоступен» при сбое локального
 * CLI (а ассистенты r.linkeon живы), и СПАМИЛА при каждом рестарте api.
 * Inline-копия гейт-логики (как остальные unit). Контракт:
 *  - алерт только после K ПОДРЯД провалов (гасит транзиент + рестарт-спам);
 *  - не дублировать, если уже заалертили (персист), кроме realert-интервала;
 *  - отбой при восстановлении только если был алерт.
 */
const K = 2;
const REALERT_MS = 3 * 3600_000;

// Возвращает действие гейта: 'alert' | 'recover' | 'noop'
function gate({ status, consecutiveDown, alreadyAlerted, lastAlertAt, now }) {
  if (status === 'down') {
    if (consecutiveDown < K) return 'noop';
    const cooled = !lastAlertAt || (now - lastAlertAt) >= REALERT_MS;
    if (!alreadyAlerted || cooled) return 'alert';
    return 'noop';
  }
  if (status === 'ok' && alreadyAlerted) return 'recover';
  return 'noop';
}

describe('claude CLI outage alert gate', () => {
  test('первый провал (consecutiveDown=1) НЕ алертит — гасит транзиент/рестарт', () => {
    expect(gate({ status: 'down', consecutiveDown: 1, alreadyAlerted: false, lastAlertAt: null, now: 1000 })).toBe('noop');
  });
  test('2 подряд провала → алерт', () => {
    expect(gate({ status: 'down', consecutiveDown: 2, alreadyAlerted: false, lastAlertAt: null, now: 1000 })).toBe('alert');
  });
  test('уже заалертили, интервал не вышел → молчим (нет спама)', () => {
    expect(gate({ status: 'down', consecutiveDown: 5, alreadyAlerted: true, lastAlertAt: 1000, now: 1000 + 60_000 })).toBe('noop');
  });
  test('уже заалертили, прошёл realert-интервал → повтор', () => {
    expect(gate({ status: 'down', consecutiveDown: 5, alreadyAlerted: true, lastAlertAt: 1000, now: 1000 + REALERT_MS + 1 })).toBe('alert');
  });
  test('рестарт во время простоя: счётчик с 0 → первый тик noop (персист помнит, что уже алертили)', () => {
    // после рестарта consecutiveDown=1, alreadyAlerted=true (персист) → noop, без дубля
    expect(gate({ status: 'down', consecutiveDown: 1, alreadyAlerted: true, lastAlertAt: 1000, now: 2000 })).toBe('noop');
  });
  test('восстановление после алерта → отбой', () => {
    expect(gate({ status: 'ok', consecutiveDown: 0, alreadyAlerted: true, lastAlertAt: 1000, now: 2000 })).toBe('recover');
  });
  test('ok без предыдущего алерта → молчим (нет ложного отбоя при старте)', () => {
    expect(gate({ status: 'ok', consecutiveDown: 0, alreadyAlerted: false, lastAlertAt: null, now: 2000 })).toBe('noop');
  });
});
