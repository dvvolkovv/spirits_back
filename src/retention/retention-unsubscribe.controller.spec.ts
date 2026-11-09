import { RetentionUnsubscribeController } from './retention-unsubscribe.controller';

function fakeRes() {
  const r: any = { statusCode: 200, headers: {}, body: '' };
  r.status = (code: number) => { r.statusCode = code; return r; };
  r.set = (name: string, value: string) => { r.headers[name] = value; return r; };
  r.type = () => r;
  r.send = (body: string) => { r.body = body; return r; };
  return r;
}

describe('RetentionUnsubscribeController', () => {
  const svc = { findByToken: jest.fn(), unsubscribe: jest.fn() };
  let ctrl: RetentionUnsubscribeController;
  const token = 'x'.repeat(43);

  beforeEach(() => {
    svc.findByToken.mockReset();
    svc.unsubscribe.mockReset();
    ctrl = new RetentionUnsubscribeController(svc as any);
  });

  it('GET показывает форму и не меняет состояние', async () => {
    svc.findByToken.mockResolvedValue({ email: 'person@example.com', unsubscribedAt: null });
    const res = fakeRes();
    await ctrl.get(token, 'en', res);
    expect(svc.unsubscribe).not.toHaveBeenCalled();
    expect(res.body).toContain('method="post"');
    expect(res.body).toContain('p***n@example.com');
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(res.headers['X-Robots-Tag']).toBe('noindex');
    expect(res.headers['Content-Security-Policy']).toContain("form-action 'self'");
  });

  it('POST выполняет идемпотентную отписку', async () => {
    svc.unsubscribe.mockResolvedValue({ email: 'person@example.com', unsubscribedAt: new Date() });
    const res = fakeRes();
    await ctrl.post({ token, lang: 'en' }, res);
    expect(svc.unsubscribe).toHaveBeenCalledWith(token);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Unsubscribed');
  });

  it('неверный токен не раскрывает email', async () => {
    svc.findByToken.mockResolvedValue(null);
    const res = fakeRes();
    await ctrl.get('bad', 'ru', res);
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('example.com');
  });
});
