import { clientIp } from './client-ip';

describe('clientIp', () => {
  it('берёт X-Real-IP — его ставит наш nginx', () => {
    expect(clientIp({ headers: { 'x-real-ip': '203.0.113.7' }, ip: '127.0.0.1' } as any))
      .toBe('203.0.113.7');
  });

  it('без X-Real-IP берёт первый адрес из X-Forwarded-For', () => {
    // Первый — исходный клиент, остальные дописаны прокси по пути.
    expect(clientIp({ headers: { 'x-forwarded-for': '203.0.113.7, 92.53.64.147' }, ip: '127.0.0.1' } as any))
      .toBe('203.0.113.7');
  });

  it('X-Real-IP важнее X-Forwarded-For', () => {
    expect(clientIp({
      headers: { 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.1' },
      ip: '127.0.0.1',
    } as any)).toBe('203.0.113.7');
  });

  it('без заголовков падает на req.ip', () => {
    expect(clientIp({ headers: {}, ip: '203.0.113.7' } as any)).toBe('203.0.113.7');
  });

  it('массив в заголовке не ломает разбор', () => {
    expect(clientIp({ headers: { 'x-real-ip': ['203.0.113.7', '198.51.100.1'] }, ip: '127.0.0.1' } as any))
      .toBe('203.0.113.7');
  });

  it('пустой заголовок не считается адресом', () => {
    expect(clientIp({ headers: { 'x-real-ip': '   ' }, ip: '203.0.113.7' } as any)).toBe('203.0.113.7');
  });

  it('совсем без всего отдаёт unknown, а не падает', () => {
    expect(clientIp({ headers: {} } as any)).toBe('unknown');
    expect(clientIp(undefined as any)).toBe('unknown');
  });

  it('обрезает длинный мусор — заголовок приходит снаружи', () => {
    // Заголовок подконтролен клиенту, если он ходит мимо nginx. Ключом Redis
    // это становиться не должно.
    const ip = clientIp({ headers: { 'x-real-ip': 'a'.repeat(500) }, ip: '127.0.0.1' } as any);
    expect(ip.length).toBeLessThanOrEqual(64);
  });
});
