import {
  isRetentionUserId,
  normalizeEmail,
  normalizePhone,
  selectRetentionChannel,
} from './retention-recipient';

describe('retention recipient rules', () => {
  it('нормализует email и отбрасывает невалидные значения', () => {
    expect(normalizeEmail('  User@Example.COM ')).toBe('user@example.com');
    expect(normalizeEmail('not-an-email')).toBeNull();
    expect(normalizeEmail('a@b')).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
  });

  it('нормализует +7 и не принимает произвольный номер', () => {
    expect(normalizePhone('+79001112233')).toBe('79001112233');
    expect(normalizePhone('79001112233')).toBe('79001112233');
    expect(normalizePhone('8 900 111 22 33')).toBeNull();
    expect(normalizePhone('dozvon_123')).toBeNull();
  });

  it('принимает телефонный ID и canonical UUID, но не служебные префиксы', () => {
    expect(isRetentionUserId('79001112233')).toBe(true);
    expect(isRetentionUserId('11111111-1111-4111-8111-111111111111')).toBe(true);
    expect(isRetentionUserId('dozvon')).toBe(false);
    expect(isRetentionUserId('11111111-1111-4111-8111-11111111111g')).toBe(false);
  });

  it('email имеет приоритет даже при наличии телефона', () => {
    expect(selectRetentionChannel({ email: 'u@example.com', phone: '79001112233' })).toBe('email');
  });

  it('без email выбирает SMS, а без обоих контактов — no_channel', () => {
    expect(selectRetentionChannel({ email: null, phone: '79001112233' })).toBe('sms');
    expect(selectRetentionChannel({ email: null, phone: null })).toBe('no_channel');
  });
});
