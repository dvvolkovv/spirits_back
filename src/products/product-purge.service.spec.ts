import { backupPathFor, ProductPurgeService, PURGE_TICK_MS, reposRoot } from './product-purge.service';

const ROOT = '/home/owner/product-repos';

describe('путь резервной копии — только ровно <корень>/<слаг>.git', () => {
  it('repo_url скрипта product-backup-setup.sh — годится', () => {
    expect(backupPathFor(`backup@10.0.0.1:${ROOT}/shop.git`, 'shop', ROOT)).toBe(`${ROOT}/shop.git`);
    expect(backupPathFor(`${ROOT}/shop.git`, 'shop', ROOT)).toBe(`${ROOT}/shop.git`);
  });

  it.each([
    [`backup@10.0.0.1:${ROOT}/other.git`, 'shop'],
    [`backup@10.0.0.1:${ROOT}/../product-repos/shop.git/..`, 'shop'],
    [`backup@10.0.0.1:/home/owner/elsewhere/shop.git`, 'shop'],
    [`backup@10.0.0.1:${ROOT}/shop.git`, '..'],
    [`backup@10.0.0.1:${ROOT}/shop.git`, ''],
    [`backup@10.0.0.1:${ROOT}`, 'shop'],
    ['https://github.com/x/shop.git', 'shop'],
    ['', 'shop'],
  ])('%j при слаге %j — не наша копия, null', (url, slug) => {
    expect(backupPathFor(url, slug, ROOT)).toBeNull();
  });

  it('корень — абсолютный и не у самого корня ФС', () => {
    expect(reposRoot({ PRODUCT_REPOS_DIR: '/srv/backups/product-repos' } as any)).toBe('/srv/backups/product-repos');
    expect(() => reposRoot({ PRODUCT_REPOS_DIR: 'relative/dir' } as any)).toThrow(/абсолютн/);
    expect(() => reposRoot({ PRODUCT_REPOS_DIR: '/' } as any)).toThrow(/корн/);
    expect(reposRoot({} as any)).toMatch(/\/product-repos$/);
  });
});

describe('таймер обхода стирания', () => {
  afterEach(() => jest.useRealTimers());

  // Отступление 2 плана: обход на старте отдал бы purge старому агенту машины
  // в окне между выкатом сервера и выкатом агента (deploy.sh, PHASE 2 и 4).
  it('первый обход — через час после старта, а не на старте', () => {
    jest.useFakeTimers();
    const svc = new ProductPurgeService({ query: jest.fn() } as any);
    const tick = jest.spyOn(svc, 'tick').mockResolvedValue(undefined);
    svc.onModuleInit();
    jest.advanceTimersByTime(PURGE_TICK_MS - 1);
    expect(tick).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(tick).toHaveBeenCalledTimes(1);
    svc.onModuleDestroy();
    jest.advanceTimersByTime(PURGE_TICK_MS * 3);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('медленный обход не перекрывается следующим: пока идёт прошлый, новый пропускается', async () => {
    const svc = new ProductPurgeService({ query: jest.fn() } as any);
    (svc as any).logger = { error: jest.fn(), warn: jest.fn(), log: jest.fn() };
    let finish!: () => void;
    const wipe = jest
      .spyOn(svc, 'wipeExpired')
      .mockImplementationOnce(() => new Promise<number>((res) => (finish = () => res(0))))
      .mockResolvedValue(0);
    const queue = jest.spyOn(svc, 'queuePurges').mockResolvedValue(0);
    jest.spyOn(svc, 'removeBackups').mockResolvedValue(0);

    const slow = svc.tick();
    await svc.tick();
    expect(wipe).toHaveBeenCalledTimes(1);
    expect(queue).not.toHaveBeenCalled();

    finish();
    await slow;
    expect(queue).toHaveBeenCalledTimes(1);
    await svc.tick();
    expect(wipe).toHaveBeenCalledTimes(2);
  });

  it('отказ одного шага обхода не отменяет остальные', async () => {
    const svc = new ProductPurgeService({ query: jest.fn() } as any);
    const wipe = jest.spyOn(svc, 'wipeExpired').mockRejectedValue(new Error('обрыв с базой'));
    const queue = jest.spyOn(svc, 'queuePurges').mockRejectedValue(new Error('обрыв с базой'));
    const backups = jest.spyOn(svc, 'removeBackups').mockResolvedValue(0);
    await expect(svc.tick()).resolves.toBeUndefined();
    expect(wipe).toHaveBeenCalledTimes(1);
    expect(queue).toHaveBeenCalledTimes(1);
    expect(backups).toHaveBeenCalledTimes(1);
  });
});
