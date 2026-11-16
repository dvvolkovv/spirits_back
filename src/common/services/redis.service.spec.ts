import { RedisService } from './redis.service';

/**
 * Task 17D — deleteByPrefix: курсорный SCAN + UNLINK батчами, никогда KEYS.
 *
 * KEYS блокирует Redis O(N) по всему keyspace'у — на проде с миллионами
 * ключей (sc-<phone>, сессии, rate-limits) это секундные паузы для всех
 * клиентов. SCAN итерирует небольшими порциями (COUNT — подсказка), UNLINK
 * освобождает память асинхронно. Клиент подставляется фейковый в приватное
 * поле: конструктор RedisService клиента не создаёт (это делает onModuleInit),
 * живой Redis юнит-тесту не нужен.
 */

function makeService() {
  const service = new RedisService();
  const client = {
    scan: jest.fn(),
    unlink: jest.fn(),
    keys: jest.fn(),
    del: jest.fn(),
    quit: jest.fn(),
    on: jest.fn(),
  };
  (service as any).client = client;
  return { service, client };
}

describe('RedisService.deleteByPrefix — SCAN + UNLINK, никогда KEYS (Task 17D)', () => {
  it('проходит SCAN-курсор до "0" и UNLINK-ает найденные батчи', async () => {
    const { service, client } = makeService();
    client.scan
      .mockResolvedValueOnce(['42', ['p:a', 'p:b']])
      .mockResolvedValueOnce(['17', []])
      .mockResolvedValueOnce(['0', ['p:c']]);
    client.unlink.mockImplementation(async (...keys: string[]) => keys.length);

    const deleted = await service.deleteByPrefix('p:');

    expect(deleted).toBe(3);
    expect(client.scan).toHaveBeenCalledTimes(3);
    // Курсоры: старт с '0', затем то, что вернул SCAN, пока не снова '0'.
    expect(client.scan.mock.calls.map((call: any[]) => call[0])).toEqual(['0', '42', '17']);
    expect(client.unlink).toHaveBeenCalledTimes(2);
    expect(client.unlink).toHaveBeenNthCalledWith(1, 'p:a', 'p:b');
    expect(client.unlink).toHaveBeenNthCalledWith(2, 'p:c');
    expect(client.keys).not.toHaveBeenCalled();
  });

  it('MATCH-паттерн — префикс + "*", COUNT числом; KEYS не вызывается', async () => {
    const { service, client } = makeService();
    client.scan.mockResolvedValueOnce(['0', []]);

    await service.deleteByPrefix('guest-carry:u:');

    expect(client.scan).toHaveBeenCalledWith(
      '0', 'MATCH', 'guest-carry:u:*', 'COUNT', expect.any(Number),
    );
    expect(client.keys).not.toHaveBeenCalled();
  });

  it('большая пачка делится на UNLINK-чанки (предел аргументов вызова)', async () => {
    const { service, client } = makeService();
    const keys = Array.from({ length: 250 }, (_, i) => `p:${i}`);
    client.scan.mockResolvedValueOnce(['0', keys]);
    client.unlink.mockImplementation(async (...batch: string[]) => batch.length);

    const deleted = await service.deleteByPrefix('p:');

    expect(deleted).toBe(250);
    expect(client.unlink.mock.calls.length).toBeGreaterThan(1);
    expect(client.unlink.mock.calls[0].length).toBeLessThanOrEqual(100);
    const total = client.unlink.mock.calls.reduce((n: number, call: any[]) => n + call.length, 0);
    expect(total).toBe(250);
  });

  it('пустой префикс-матч — ноль UNLINK, возвращает 0', async () => {
    const { service, client } = makeService();
    client.scan.mockResolvedValueOnce(['0', []]);

    const deleted = await service.deleteByPrefix('nothing-here:');

    expect(deleted).toBe(0);
    expect(client.unlink).not.toHaveBeenCalled();
    expect(client.keys).not.toHaveBeenCalled();
  });

  it('glob-метасимволы префикса экранируются — префикс матчится буквально', async () => {
    const { service, client } = makeService();
    client.scan.mockResolvedValueOnce(['0', []]);

    // userId в префиксе — телефон/UUID, но helper общий: '*', '?', '[', ']',
    // '\' экранируются, чтобы не превратиться в glob.
    await service.deleteByPrefix('a*b?c[d]e\\f');

    expect(client.scan).toHaveBeenCalledWith(
      '0', 'MATCH', 'a\\*b\\?c\\[d\\]e\\\\f*', 'COUNT', expect.any(Number),
    );
  });

  it('сбой SCAN всплывает вызывающему (оборачивает адаптер удаления)', async () => {
    const { service, client } = makeService();
    client.scan.mockRejectedValue(
      Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }),
    );

    await expect(service.deleteByPrefix('p:')).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    expect(client.keys).not.toHaveBeenCalled();
  });
});
