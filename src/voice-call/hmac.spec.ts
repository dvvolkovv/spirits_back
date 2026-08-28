import { signBody, verifyBody } from './hmac';

describe('voice-call HMAC', () => {
  const secret = 'test-secret-value';
  const body = JSON.stringify({ callId: 'abc', question: 'привет' });

  it('подпись проходит проверку своим же секретом', () => {
    expect(verifyBody(secret, body, signBody(secret, body))).toBe(true);
  });

  it('чужая подпись не проходит', () => {
    expect(verifyBody(secret, body, signBody('other-secret', body))).toBe(false);
  });

  it('подмена тела ломает подпись', () => {
    const sig = signBody(secret, body);
    expect(verifyBody(secret, body.replace('привет', 'пока'), sig)).toBe(false);
  });

  it('пустая или кривая подпись отвергается, а не падает', () => {
    expect(verifyBody(secret, body, '')).toBe(false);
    expect(verifyBody(secret, body, 'не-hex')).toBe(false);
    expect(verifyBody(secret, body, undefined as unknown as string)).toBe(false);
  });

  it('подпись кириллицы стабильна между вызовами', () => {
    expect(signBody(secret, 'вопрос юристу')).toBe(signBody(secret, 'вопрос юристу'));
  });
});
