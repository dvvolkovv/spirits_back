import { HttpException } from '@nestjs/common';
import { JOIN_LIMIT_PER_IP, LOOKUP_LIMIT_PER_IP, RoomRateLimit } from './room-rate-limit';

describe('RoomRateLimit', () => {
  let limiter: { check: jest.Mock };
  let limit: RoomRateLimit;

  beforeEach(() => {
    limiter = { check: jest.fn().mockResolvedValue(undefined) };
    limit = new RoomRateLimit(limiter as any);
  });

  it('в пределах нормы пропускает', async () => {
    await expect(limit.checkLookup('1.2.3.4')).resolves.toBe(true);
  });

  it('429 от общего лимитера — это отказ, а не сбой', async () => {
    limiter.check.mockRejectedValue(new HttpException({ error: 'rate_limited' }, 429));
    await expect(limit.checkLookup('1.2.3.4')).resolves.toBe(false);
  });

  it('при недоступном Redis пропускает, а не запирает вход', async () => {
    // IpRateLimiter выпустит ошибку соединения наружу, и ручка ответит 500 —
    // то есть «никто не может войти во встречу». Перебор кода это риск,
    // сорванная встреча у всех сразу — уже ущерб.
    limiter.check.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(limit.checkLookup('1.2.3.4')).resolves.toBe(true);
  });

  it('чужой HttpException не путается с превышением предела', async () => {
    limiter.check.mockRejectedValue(new HttpException('boom', 500));
    await expect(limit.checkLookup('1.2.3.4')).resolves.toBe(true);
  });

  it('вход и справка считаются раздельно — иначе просмотр съедал бы право войти', async () => {
    await limit.checkLookup('1.2.3.4');
    await limit.checkJoin('1.2.3.4');
    const buckets = limiter.check.mock.calls.map((c: any[]) => c[1]);
    expect(new Set(buckets).size).toBe(2);
  });

  it('у входа предел строже, чем у справки', () => {
    expect(JOIN_LIMIT_PER_IP).toBeLessThan(LOOKUP_LIMIT_PER_IP);
  });

  it('передаёт пределы и окно в общий лимитер', async () => {
    await limit.checkJoin('1.2.3.4');
    expect(limiter.check).toHaveBeenCalledWith('1.2.3.4', 'room-join', JOIN_LIMIT_PER_IP, 60);
  });

  it('пустой адрес не роняет проверку', async () => {
    // clientIp может отдать unknown за неправильно настроенным прокси.
    await expect(limit.checkLookup('' as any)).resolves.toBe(true);
    expect(limiter.check).toHaveBeenCalledWith('unknown', expect.any(String), expect.any(Number), 60);
  });
});
