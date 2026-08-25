import { IdentityService } from './identity.service';

describe('IdentityService — провайдер telegram', () => {
  const svc = new IdentityService() as any;

  it('normalize отдаёт tg_user_id строкой', () => {
    expect(svc.normalize('telegram', { sub: '42' })).toBe('42');
  });

  it('extractEmail не выдумывает почту', () => {
    expect(svc.extractEmail('telegram', { sub: '42' })).toEqual({
      email: null,
      verified: false,
    });
  });

  it('normalize по-прежнему знает остальные провайдеры', () => {
    expect(svc.normalize('phone', { phone: '+7 (903) 016-91-87' })).toBe('79030169187');
    expect(svc.normalize('google', { sub: 'g-1' })).toBe('g-1');
  });
});
