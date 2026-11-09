import { decryptRetentionEmail, encryptRetentionEmail } from './retention-token-cipher';

const SECRET = '11'.repeat(32);
const OTHER_SECRET = '22'.repeat(32);
const ORIGINAL_SECRET = process.env.RETENTION_UNSUBSCRIBE_SECRET;

describe('retention-token-cipher', () => {
  beforeEach(() => {
    process.env.RETENTION_UNSUBSCRIBE_SECRET = SECRET;
  });

  afterAll(() => {
    if (ORIGINAL_SECRET === undefined) delete process.env.RETENTION_UNSUBSCRIBE_SECRET;
    else process.env.RETENTION_UNSUBSCRIBE_SECRET = ORIGINAL_SECRET;
  });

  it('нормализует email, не раскрывает его и создаёт независимые конверты', () => {
    const first = encryptRetentionEmail(' User@Example.com ');
    const second = encryptRetentionEmail('user@example.com');
    expect(first).not.toBe(second);
    expect(first).not.toContain('user@example.com');
    expect(first).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decryptRetentionEmail(first)).toBe('user@example.com');
    expect(decryptRetentionEmail(second)).toBe('user@example.com');
  });

  it('отклоняет невалидный email и предел в 512 UTF-8 байт', () => {
    expect(() => encryptRetentionEmail('not-an-email')).toThrow('invalid_email');
    const atLimit = `${'a'.repeat(507)}@b.co`;
    expect(Buffer.byteLength(atLimit, 'utf8')).toBe(512);
    expect(decryptRetentionEmail(encryptRetentionEmail(atLimit))).toBe(atLimit);
    expect(() => encryptRetentionEmail(`${'a'.repeat(508)}@b.co`)).toThrow('invalid_email');
  });

  it('отсутствие секрета — operational error даже для malformed token', () => {
    const token = encryptRetentionEmail('person@example.com');
    delete process.env.RETENTION_UNSUBSCRIBE_SECRET;
    expect(() => encryptRetentionEmail('person@example.com')).toThrow(
      'retention_unsubscribe_secret_not_configured',
    );
    expect(() => decryptRetentionEmail(token)).toThrow(
      'retention_unsubscribe_secret_not_configured',
    );
    expect(() => decryptRetentionEmail('../secret')).toThrow(
      'retention_unsubscribe_secret_not_configured',
    );
  });

  it('невалидный секрет — operational error, а не невалидный токен', () => {
    for (const secret of ['0'.repeat(63), '0'.repeat(65), 'g'.repeat(64)]) {
      process.env.RETENTION_UNSUBSCRIBE_SECRET = secret;
      expect(() => encryptRetentionEmail('person@example.com')).toThrow(
        'retention_unsubscribe_secret_invalid',
      );
      expect(() => decryptRetentionEmail('../secret')).toThrow(
        'retention_unsubscribe_secret_invalid',
      );
    }
  });

  it('отклоняет нестрогий base64url и слишком длинный токен', () => {
    const token = encryptRetentionEmail('person@example.com');
    for (const malformed of ['', '../secret', `${token}=`, 'A', 'AB', 'a'.repeat(2049)]) {
      expect(decryptRetentionEmail(malformed)).toBeNull();
    }
  });

  it('tampered, truncated и wrong-version токены возвращают null', () => {
    const token = encryptRetentionEmail('person@example.com');
    const tampered = Buffer.from(token, 'base64url');
    tampered[tampered.length - 1] ^= 1;
    expect(decryptRetentionEmail(tampered.toString('base64url'))).toBeNull();
    expect(decryptRetentionEmail(token.slice(0, -4))).toBeNull();
    const wrongVersion = Buffer.from(token, 'base64url');
    wrongVersion[0] = 2;
    expect(decryptRetentionEmail(wrongVersion.toString('base64url'))).toBeNull();
  });

  it('другой ключ возвращает null', () => {
    const token = encryptRetentionEmail('person@example.com');
    process.env.RETENTION_UNSUBSCRIBE_SECRET = OTHER_SECRET;
    expect(decryptRetentionEmail(token)).toBeNull();
  });
});
