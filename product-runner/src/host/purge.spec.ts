import { existsSync } from 'fs';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { FakeHost, deps } from './fake-host';
import { hostDeps, provision } from './provision';
import { productDirFor, purgeProduct } from './purge';
import { REKEY_BACKUP_SUFFIX } from './rekey';

let host: FakeHost;
beforeEach(() => {
  host = new FakeHost();
});

const seed = (slug: string, kind: 'site' | 'bot' = 'site') =>
  provision({ slug, kind, name: slug, runnerToken: 'ткн', secrets: kind === 'bot' ? { BOT_TOKEN: 'т' } : {} }, deps(host));

/** Контейнер с любым именем — так их заводят обновление образа и смена ключей. */
const runNamed = (name: string) =>
  host.run(['docker', 'run', '-d', '--name', name, '--restart', 'unless-stopped', 'linkeon-product:base']);

describe('стирание', () => {
  it('сайт: vhost, сертификат своего домена, контейнер и каталог — всё снято', async () => {
    await seed('shop');
    host.certs.add('linkeon-shop');
    await purgeProduct({ slug: 'shop', kind: 'site' }, deps(host));
    expect(host.isClean('shop')).toBe(true);
    expect(host.certs.has('linkeon-shop')).toBe(false);
    expect(host.removedDirs).toEqual(['/srv/products/shop']);
  });

  it('vhost снимается ДО контейнера: иначе порт ушёл бы соседу под живым доменом', async () => {
    await seed('shop');
    host.calls.length = 0;
    await purgeProduct({ slug: 'shop', kind: 'site' }, deps(host));
    const reload = host.calls.findIndex((c) => c[0] === 'systemctl');
    const rm = host.calls.findIndex((c) => c[0] === 'docker' && c[1] === 'rm');
    expect(reload).toBeGreaterThanOrEqual(0);
    expect(rm).toBeGreaterThan(reload);
  });

  it('бот: контейнер и каталог; nginx и certbot не зовутся', async () => {
    await seed('bot1', 'bot');
    host.calls.length = 0;
    await purgeProduct({ slug: 'bot1', kind: 'bot' }, deps(host));
    expect(host.isClean('bot1')).toBe(true);
    expect(host.calls.some((c) => c[0] === 'systemctl' || c[0] === 'certbot' || c[0] === 'rm')).toBe(false);
  });

  it('спящий (остановленный) контейнер и остаток прерванной смены ключей тоже снимаются', async () => {
    await seed('bot1', 'bot');
    await host.run(['docker', 'stop', 'bot1']);
    await host.run(['docker', 'rename', 'bot1', `bot1${REKEY_BACKUP_SUFFIX}`]);
    await purgeProduct({ slug: 'bot1', kind: 'bot' }, deps(host));
    expect(host.containers.has(`bot1${REKEY_BACKUP_SUFFIX}`)).toBe(false);
    expect(host.isClean('bot1')).toBe(true);
  });

  it('повтор стирания проходит: потерянный отчёт не превращается в вечный отказ', async () => {
    await seed('shop');
    await purgeProduct({ slug: 'shop', kind: 'site' }, deps(host));
    await expect(purgeProduct({ slug: 'shop', kind: 'site' }, deps(host))).resolves.toBeUndefined();
  });

  it('соседний продукт не тронут', async () => {
    await seed('shop');
    await seed('shop2');
    await purgeProduct({ slug: 'shop', kind: 'site' }, deps(host));
    expect(host.dirs.has('/srv/products/shop2')).toBe(true);
    expect(host.isRunning('shop2')).toBe(true);
    expect(host.vhostMode('shop2')).toBe('live');
  });

  it('vhost не снялся — контейнер и каталог остаются: порт держит живой домен', async () => {
    await seed('shop');
    host.before = (argv) => {
      if (argv[0] === 'systemctl') throw new Error('Job for nginx.service failed');
    };
    await expect(purgeProduct({ slug: 'shop', kind: 'site' }, deps(host))).rejects.toThrow(/nginx/);
    expect(host.containers.has('shop')).toBe(true);
    expect(host.dirs.has('/srv/products/shop')).toBe(true);
  });

  it('certbot отказал не «нет сертификата» — отказ, контейнер цел', async () => {
    await seed('shop');
    host.certs.add('linkeon-shop');
    host.before = (argv) => {
      if (argv[0] === 'certbot') throw new Error('Another instance of Certbot is already running');
    };
    await expect(purgeProduct({ slug: 'shop', kind: 'site' }, deps(host))).rejects.toThrow(/certbot/i);
    expect(host.containers.has('shop')).toBe(true);
  });

  it('контейнер не снялся — каталог цел: из-под контейнера его не удаляют', async () => {
    await seed('bot1', 'bot');
    host.before = (argv) => {
      if (argv[0] === 'docker' && argv[1] === 'rm') throw new Error('Error response from daemon: device or resource busy');
    };
    await expect(purgeProduct({ slug: 'bot1', kind: 'bot' }, deps(host))).rejects.toThrow(/контейнер bot1/);
    expect(host.dirs.has('/srv/products/bot1')).toBe(true);
    expect(host.removedDirs).toHaveLength(0);
  });

  it('контейнер исчез между списком и docker rm — не отказ: снимать уже нечего', async () => {
    await seed('bot1', 'bot');
    host.before = (argv) => {
      if (argv[0] === 'docker' && argv[1] === 'rm') host.containers.delete(argv[3]);
    };
    await expect(purgeProduct({ slug: 'bot1', kind: 'bot' }, deps(host))).resolves.toBeUndefined();
    expect(host.isClean('bot1')).toBe(true);
  });
});

describe('контейнеры продукта — по точным именам', () => {
  it('страховки обновления образа (<слаг>__pre_<12 hex>) снимаются: иначе следующее обновление подняло бы стёртый продукт', async () => {
    await seed('shop');
    await runNamed('shop__pre_0123456789ab');
    await host.run(['docker', 'stop', 'shop__pre_0123456789ab']);
    await runNamed('shop__pre_ba9876543210');
    await purgeProduct({ slug: 'shop', kind: 'site' }, deps(host));
    expect(host.containers.has('shop__pre_0123456789ab')).toBe(false);
    expect(host.containers.has('shop__pre_ba9876543210')).toBe(false);
    expect(host.isClean('shop')).toBe(true);
  });

  it('соседи с тем же началом имени и чужие формы не тронуты — ни масок, ни префиксов', async () => {
    await seed('shop');
    await seed('shop-2');
    await seed('shop2', 'bot');
    const decoys = [
      'shop-2__rekey',
      'shop-2__pre_0123456789ab',
      'shop2__pre_0123456789ab',
      'xshop__rekey',
      'shop__rekey2',
      'shop__pre_0123456789abc',
      'shop__pre_0123456789AB',
      'shop__pre_',
      'shop__pre_manual',
    ];
    for (const name of decoys) await runNamed(name);
    host.calls.length = 0;
    await purgeProduct({ slug: 'shop', kind: 'site' }, deps(host));
    expect([...host.containers.keys()].sort()).toEqual(['shop-2', 'shop2', ...decoys].sort());
    expect(host.calls.filter((c) => c[0] === 'docker' && c[1] === 'rm').map((c) => c[3])).toEqual(['shop']);
    expect(host.dirs.has('/srv/products/shop-2')).toBe(true);
    expect(host.dirs.has('/srv/products/shop2')).toBe(true);
    expect(host.vhostMode('shop-2')).toBe('live');
  });
});

describe('путь стирания — только /srv/products/<слаг>', () => {
  it.each(['', '.', '..', 'a/b', '../etc', 'shop/..', '-rf', 'SHOP', 'shop ', 'shop\nx'])(
    'слаг %j — отказ до ЛЮБОГО вызова',
    async (slug) => {
      await expect(purgeProduct({ slug, kind: 'site' }, deps(host))).rejects.toThrow(/слаг/);
      expect(host.calls).toHaveLength(0);
      expect(host.removedDirs).toHaveLength(0);
    },
  );

  it.each(['/', '/srv', 'srv/products', '/srv/../products', ''])(
    'каталог продуктов %j — отказ до ЛЮБОГО вызова',
    async (productsDir) => {
      await expect(purgeProduct({ slug: 'shop', kind: 'site' }, deps(host, { productsDir }))).rejects.toThrow(/каталог продуктов/);
      expect(host.calls).toHaveLength(0);
    },
  );

  it('годный путь собирается ровно из каталога и слага, хвостовой слэш не мешает', () => {
    expect(productDirFor('/srv/products/', 'shop')).toBe('/srv/products/shop');
    expect(productDirFor('/srv/products', 'a-1')).toBe('/srv/products/a-1');
  });

  it('неизвестная форма продукта — отказ до любого вызова', async () => {
    await seed('shop');
    host.calls.length = 0;
    await expect(purgeProduct({ slug: 'shop', kind: 'app' as any }, deps(host))).rejects.toThrow(/форма продукта/);
    expect(host.calls).toHaveLength(0);
    expect(host.removedDirs).toHaveLength(0);
  });

  it('каталог конфигов nginx не абсолютный — отказ до любого вызова', async () => {
    await seed('shop');
    host.calls.length = 0;
    await expect(
      purgeProduct({ slug: 'shop', kind: 'site' }, deps(host, { nginxConfDir: 'etc/nginx/sites-products' })),
    ).rejects.toThrow(/nginx/);
    expect(host.calls).toHaveLength(0);
  });

  it('настоящий путь каталога не тот, что собран (ссылка по дороге) — отказ до любого вызова, ничего не стёрто', async () => {
    await seed('shop');
    host.calls.length = 0;
    await expect(
      purgeProduct({ slug: 'shop', kind: 'site' }, deps(host, { realpath: async () => '/etc' })),
    ).rejects.toThrow(/\/etc/);
    expect(host.calls).toHaveLength(0);
    expect(host.removedDirs).toHaveLength(0);
    expect(host.containers.has('shop')).toBe(true);
    expect(host.vhostMode('shop')).toBe('live');
  });

  it('настоящий путь не прочитан (не ENOENT) — отказ, а не «стирать нечего»', async () => {
    await seed('shop');
    host.calls.length = 0;
    const realpathFails = async () => {
      throw Object.assign(new Error('ELOOP: too many symbolic links encountered'), { code: 'ELOOP' });
    };
    await expect(purgeProduct({ slug: 'shop', kind: 'site' }, deps(host, { realpath: realpathFails }))).rejects.toThrow(/ELOOP/);
    expect(host.calls).toHaveLength(0);
    expect(host.removedDirs).toHaveLength(0);
  });

  it('путь сверяется и вплотную к удалению: подменённый после снятия контейнеров — каталог цел', async () => {
    await seed('bot1', 'bot');
    let asked = 0;
    const realpathSwapped = async (p: string) => (++asked === 1 ? p : '/');
    await expect(purgeProduct({ slug: 'bot1', kind: 'bot' }, deps(host, { realpath: realpathSwapped }))).rejects.toThrow(/ведёт/);
    expect(asked).toBe(2);
    expect(host.removedDirs).toHaveLength(0);
    expect(host.dirs.has('/srv/products/bot1')).toBe(true);
  });
});

describe('настоящая ФС: ссылки не уводят стирание наружу', () => {
  let base: string;
  let root: string;
  let outside: string;
  const precious = () => readFile(join(outside, 'чужое.txt'), 'utf8');

  beforeEach(async () => {
    // realpath — чтобы сам временный каталог не оказался ссылкой (на маке /var → /private/var).
    base = await realpath(await mkdtemp(join(tmpdir(), 'purge-')));
    root = join(base, 'products');
    outside = join(base, 'outside');
    await mkdir(root);
    await mkdir(outside);
    await writeFile(join(outside, 'чужое.txt'), 'не трогать', 'utf8');
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  /** Настоящие exists/realpath/removeDir, симулятор — только для docker, nginx, certbot. */
  const realFs = (productsDir = root) => {
    const real = hostDeps();
    return deps(host, { exists: real.exists, realpath: real.realpath, removeDir: real.removeDir, productsDir });
  };

  it('каталог продукта — ссылка наружу: отказ до любого вызова, снаружи цело, сама ссылка цела', async () => {
    await symlink(outside, join(root, 'shop'));
    await runNamed('shop');
    host.calls.length = 0;
    await expect(purgeProduct({ slug: 'shop', kind: 'site' }, realFs())).rejects.toThrow(/ведёт/);
    expect(host.calls).toHaveLength(0);
    expect(host.containers.has('shop')).toBe(true);
    expect(await precious()).toBe('не трогать');
    expect((await lstat(join(root, 'shop'))).isSymbolicLink()).toBe(true);
  });

  it('каталог продуктов — ссылка: стирание сверяет настоящий путь и отказывает, ничего не тронуто', async () => {
    const linked = join(base, 'linked-products');
    await symlink(root, linked);
    await mkdir(join(root, 'shop'));
    await writeFile(join(root, 'shop', 'server.js'), 'код', 'utf8');
    await expect(purgeProduct({ slug: 'shop', kind: 'bot' }, realFs(linked))).rejects.toThrow(/ведёт/);
    expect(host.calls).toHaveLength(0);
    expect(existsSync(join(root, 'shop', 'server.js'))).toBe(true);
  });

  it('ссылки ВНУТРИ каталога (их может завести код продукта) удаляются как ссылки — цель цела', async () => {
    const dir = join(root, 'shop');
    await mkdir(join(dir, 'data'), { recursive: true });
    await writeFile(join(dir, 'data', 'x'), '1', 'utf8');
    await symlink(outside, join(dir, 'на-хост'));
    await symlink(join(outside, 'чужое.txt'), join(dir, 'data', 'файл-хоста'));
    await purgeProduct({ slug: 'shop', kind: 'bot' }, realFs());
    expect(existsSync(dir)).toBe(false);
    expect(await precious()).toBe('не трогать');
    expect(existsSync(root)).toBe(true);
  });

  it('каталога уже нет — повтор проходит, каталог продуктов цел', async () => {
    await expect(purgeProduct({ slug: 'shop', kind: 'bot' }, realFs())).resolves.toBeUndefined();
    expect(existsSync(root)).toBe(true);
    expect(await precious()).toBe('не трогать');
  });
});
