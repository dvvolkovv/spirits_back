import { backupPathFor, ProductPurgeService, PURGE_TICK_MS, reposRoot, WIPE_FIRST_DELAY_MS } from './product-purge.service';

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

  /** Сервис с подменёнными шагами: что запускалось — видно по счётчикам. */
  function spied() {
    const svc = new ProductPurgeService({ query: jest.fn() } as any);
    (svc as any).logger = { error: jest.fn(), warn: jest.fn(), log: jest.fn() };
    const wipe = jest.spyOn(svc, 'wipeExpired').mockResolvedValue(0);
    const queue = jest.spyOn(svc, 'queuePurges').mockResolvedValue(0);
    const backups = jest.spyOn(svc, 'removeBackups').mockResolvedValue(0);
    return { svc, wipe, queue, backups };
  }

  // Отступление 2 плана: обход на старте отдал бы purge старому агенту машины
  // в окне между выкатом сервера и выкатом агента (deploy.sh, PHASE 2 и 4).
  it('первый обход — через час после старта, а не на старте', () => {
    jest.useFakeTimers();
    const { svc } = spied();
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

  // Решение владельца «стирать ключи сразу после срока»: API катится
  // несколько раз в день, и ждать часового обхода после каждого рестарта
  // значило бы отодвигать стирание на часы. Стирание ключей на сервере машины
  // не касается — ему можно раньше; постановка purge и копии — только на
  // часовом обходе (довод выше).
  it('через WIPE_FIRST_DELAY_MS после старта — разовое стирание ключей, и только оно', async () => {
    expect(WIPE_FIRST_DELAY_MS).toBeGreaterThan(0);
    expect(WIPE_FIRST_DELAY_MS).toBeLessThan(PURGE_TICK_MS);
    jest.useFakeTimers();
    const { svc, wipe, queue, backups } = spied();
    svc.onModuleInit();

    await jest.advanceTimersByTimeAsync(WIPE_FIRST_DELAY_MS - 1);
    expect(wipe).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(wipe).toHaveBeenCalledTimes(1);
    expect(queue).not.toHaveBeenCalled();
    expect(backups).not.toHaveBeenCalled();

    // Разовое: до часового обхода больше ничего.
    await jest.advanceTimersByTimeAsync(PURGE_TICK_MS - WIPE_FIRST_DELAY_MS - 1);
    expect(wipe).toHaveBeenCalledTimes(1);
    expect(queue).not.toHaveBeenCalled();

    // Часовой обход — как был: все три шага, и дальше каждый час.
    await jest.advanceTimersByTimeAsync(1);
    expect(wipe).toHaveBeenCalledTimes(2);
    expect(queue).toHaveBeenCalledTimes(1);
    expect(backups).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(PURGE_TICK_MS);
    expect(wipe).toHaveBeenCalledTimes(3);
    expect(queue).toHaveBeenCalledTimes(2);
    expect(backups).toHaveBeenCalledTimes(2);
    svc.onModuleDestroy();
  });

  it('остановка модуля снимает оба таймера — и разовый, и часовой', async () => {
    jest.useFakeTimers();
    const { svc, wipe, queue, backups } = spied();
    svc.onModuleInit();
    expect(jest.getTimerCount()).toBe(2);
    svc.onModuleDestroy();
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(PURGE_TICK_MS * 3);
    expect(wipe).not.toHaveBeenCalled();
    expect(queue).not.toHaveBeenCalled();
    expect(backups).not.toHaveBeenCalled();
  });

  it('обход во время раннего стирания ключей пропускается: один флаг на двоих', async () => {
    const { svc, wipe, queue } = spied();
    let finish!: () => void;
    wipe.mockImplementationOnce(() => new Promise<number>((res) => (finish = () => res(0))));

    const early = svc.wipeAfterStart();
    await svc.tick();
    expect(wipe).toHaveBeenCalledTimes(1);
    expect(queue).not.toHaveBeenCalled();

    finish();
    await early;
    await svc.tick();
    expect(wipe).toHaveBeenCalledTimes(2);
    expect(queue).toHaveBeenCalledTimes(1);
  });

  it('раннее стирание во время обхода пропускается: ключи сотрёт сам обход', async () => {
    const { svc, wipe, queue } = spied();
    let finish!: () => void;
    wipe.mockImplementationOnce(() => new Promise<number>((res) => (finish = () => res(0))));

    const slow = svc.tick();
    await svc.wipeAfterStart();
    expect(wipe).toHaveBeenCalledTimes(1);

    finish();
    await slow;
    expect(queue).toHaveBeenCalledTimes(1);
    await svc.wipeAfterStart();
    expect(wipe).toHaveBeenCalledTimes(2);
    expect(queue).toHaveBeenCalledTimes(1);
  });

  it('отказ раннего стирания — в лог, а не наружу; флаг снят, обход идёт', async () => {
    const { svc, wipe, queue } = spied();
    wipe.mockRejectedValueOnce(new Error('обрыв с базой'));
    await expect(svc.wipeAfterStart()).resolves.toBeUndefined();
    expect((svc as any).logger.error).toHaveBeenCalledWith(expect.stringContaining('обрыв с базой'));
    await svc.tick();
    expect(queue).toHaveBeenCalledTimes(1);
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
