import { chatSessionId } from './session-id';

describe('chatSessionId', () => {
  it('переписка — <userId>_<assistantId>', () => {
    expect(chatSessionId('79990000000', '12')).toBe('79990000000_12');
    expect(chatSessionId('u1', 'custom:abc')).toBe('u1_custom:abc');
  });

  // Лента одна (spec 2026-11-17-context-reset): «Чистый лист» — точка отсчёта,
  // а не отдельная сессия. Метка старого клиента ключ не меняет.
  it('метка «Чистого листа» старого клиента — та же переписка', () => {
    const withFreshTs = chatSessionId as (...args: unknown[]) => string;
    expect(withFreshTs('u1', '12', '1728000000000')).toBe('u1_12');
    expect(withFreshTs('u1', '12', 'abc')).toBe('u1_12');
    expect(withFreshTs('u1', '12', null)).toBe('u1_12');
  });
});
