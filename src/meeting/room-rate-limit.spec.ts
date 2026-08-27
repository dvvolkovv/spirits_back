import { JOIN_LIMIT_PER_IP, LOOKUP_LIMIT_PER_IP, RoomRateLimit } from './room-rate-limit';

describe('RoomRateLimit', () => {
  let redis: { incr: jest.Mock; expire: jest.Mock };
  let limit: RoomRateLimit;

  beforeEach(() => {
    redis = { incr: jest.fn().mockResolvedValue(1), expire: jest.fn().mockResolvedValue(undefined) };
    limit = new RoomRateLimit(redis as any);
  });

  it('первое обращение проходит', async () => {
    await expect(limit.checkLookup('1.2.3.4')).resolves.toBe(true);
  });

  it('ставит TTL на первом обращении, иначе счётчик вечный', async () => {
    await limit.checkLookup('1.2.3.4');
    expect(redis.expire).toHaveBeenCalled();
  });

  it('не переставляет TTL на последующих — иначе окно не закончится никогда', async () => {
    redis.incr.mockResolvedValue(2);
    await limit.checkLookup('1.2.3.4');
    expect(redis.expire).not.toHaveBeenCalled();
  });

  it('пропускает ровно предел', async () => {
    redis.incr.mockResolvedValue(LOOKUP_LIMIT_PER_IP);
    await expect(limit.checkLookup('1.2.3.4')).resolves.toBe(true);
  });

  it('отвергает после превышения предела', async () => {
    redis.incr.mockResolvedValue(LOOKUP_LIMIT_PER_IP + 1);
    await expect(limit.checkLookup('1.2.3.4')).resolves.toBe(false);
  });

  it('у входа предел строже, чем у справки', () => {
    expect(JOIN_LIMIT_PER_IP).toBeLessThan(LOOKUP_LIMIT_PER_IP);
  });

  it('вход и справка считаются раздельно — иначе просмотр съедал бы право войти', async () => {
    await limit.checkLookup('1.2.3.4');
    await limit.checkJoin('1.2.3.4');
    const keys = redis.incr.mock.calls.map(([k]: [string]) => k);
    expect(new Set(keys).size).toBe(2);
  });

  it('считает по IP раздельно', async () => {
    await limit.checkLookup('1.2.3.4');
    await limit.checkLookup('5.6.7.8');
    const keys = redis.incr.mock.calls.map(([k]: [string]) => k);
    expect(new Set(keys).size).toBe(2);
  });

  it('при недоступном Redis пропускает, а не запирает вход', async () => {
    // Отказ Redis не должен превращаться в «никто не может войти во встречу».
    // Перебор кода — риск; сорванная встреча у всех сразу — точно ущерб.
    redis.incr.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(limit.checkLookup('1.2.3.4')).resolves.toBe(true);
  });

  it('пустой IP не роняет проверку', async () => {
    // @Ip() может вернуть undefined за неправильно настроенным прокси.
    await expect(limit.checkLookup(undefined as any)).resolves.toBe(true);
  });
});
