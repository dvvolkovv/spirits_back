import { chatSessionId } from './session-id';

describe('chatSessionId', () => {
  it('обычная переписка — <userId>_<assistantId>', () => {
    expect(chatSessionId('79990000000', '12')).toBe('79990000000_12');
    expect(chatSessionId('u1', 'custom:abc')).toBe('u1_custom:abc');
  });
  it('«Чистый лист» — отдельная сессия', () => {
    expect(chatSessionId('u1', '12', '1728000000000')).toBe('u1_12_fresh_1728000000000');
  });
  it('мусор вместо метки «Чистого листа» — обычная переписка', () => {
    expect(chatSessionId('u1', '12', 'abc')).toBe('u1_12');
    expect(chatSessionId('u1', '12', '12345')).toBe('u1_12');
    expect(chatSessionId('u1', '12', null)).toBe('u1_12');
  });
});
