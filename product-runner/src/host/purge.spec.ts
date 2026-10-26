import { existsSync } from 'fs';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { applyDomain } from './domain';
import { FakeHost, deps } from './fake-host';
import { hostDeps, provision } from './provision';
import { certDomainsFrom, productDirFor, purgeProduct } from './purge';
import { REKEY_BACKUP_SUFFIX } from './rekey';

let host: FakeHost;
beforeEach(() => {
  host = new FakeHost();
});

const seed = (slug: string, kind: 'site' | 'bot' = 'site') =>
  provision({ slug, kind, name: slug, runnerToken: 'ткн', secrets: kind === 'bot' ? { BOT_TOKEN: 'т' } : {} }, deps(host));

/** Контейнер с любым именем — так их заводят обновление образа и смена ключей. */
const runNamed = (name: string, ...extra: string[]) =>
  host.run(['docker', 'run', '-d', '--name', name, '--restart', 'unless-stopped', ...extra, 'linkeon-product:base']);

const dockerRms = () => host.calls.filter((c) => c[0] === 'docker' && c[1] === 'rm');

describe('стирание', () => {
  it('сайт: vhost, сертификат своего домена, контейнер и каталог — всё снято', async () => {
    await seed('shop');
    host.issueCert('linkeon-shop', ['shop-client.ru']);
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

  it('порядок целиком: rm конфига → reload nginx → certbot delete → docker rm, каталог последним', async () => {
    await seed('shop');
    host.issueCert('linkeon-shop', ['shop-client.ru']);
    host.calls.length = 0;
    const order: string[] = [];
    const tracked = deps(host);
    const removeDir = tracked.removeDir;
    tracked.removeDir = async (dir) => {
      order.push(`removeDir ${host.calls.length}`);
      await removeDir(dir);
    };
    await purgeProduct({ slug: 'shop', kind: 'site' }, tracked);
    const at = (pred: (c: string[]) => boolean) => host.calls.findIndex(pred);
    const rmConf = at((c) => c[0] === 'rm');
    const reload = at((c) => c[0] === 'systemctl');
    const certDelete = at((c) => c[0] === 'certbot' && c[1] === 'delete');
    const dockerRm = at((c) => c[0] === 'docker' && c[1] === 'rm');
    expect(rmConf).toBeGreaterThanOrEqual(0);
    expect(reload).toBeGreaterThan(rmConf);
    expect(certDelete).toBeGreaterThan(reload);
    expect(dockerRm).toBeGreaterThan(certDelete);
    expect(order).toEqual([`removeDir ${host.calls.length}`]);
  });

  it('бот: контейнер и каталог; nginx и certbot не зовутся', async () => {
    await seed('bot1', 'bot');
    host.calls.length = 0;
    await purgeProduct({ slug: 'bot1', kind: 'bot' }, deps(host));
    expect(host.isClean('bot1')).toBe(true);
    expect(host.calls.some((c) => c[0] === 'systemctl' || c[0] === 'certbot' || c[0] === 'rm')).toBe(false);
  });

  it('бот, у которого всё же лежит конфиг nginx (сервер прислал не ту форму), — конфиг снимается', async () => {
    await seed('bot1', 'bot');
    host.confFiles.set('bot1', 8009);
    host.liveVhosts.set('bot1', 8009);
    host.vhostModes.set('bot1', 'live');
    await purgeProduct({ slug: 'bot1', kind: 'bot' }, deps(host));
    expect(host.isClean('bot1')).toBe(true);
    expect(host.ran('systemctl')).toHaveLength(1);
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

  it('свой домен, заведённый заданием domain: его server-блоки и сертификат сняты, чужой сертификат цел', async () => {
    const { port } = await seed('shop');
    await applyDomain({ slug: 'shop', kind: 'site', port, customNames: ['shop-client.ru', 'www.shop-client.ru'] }, deps(host));
    const { port: port2 } = await seed('shop2');
    await applyDomain({ slug: 'shop2', kind: 'site', port: port2, customNames: ['other-client.ru'] }, deps(host));
    expect(host.certs.has('linkeon-shop')).toBe(true);

    await purgeProduct({ slug: 'shop', kind: 'site' }, deps(host));

    expect(host.certs.has('linkeon-shop')).toBe(false);
    expect(host.vhostDomains.has('shop')).toBe(false);
    expect(host.vhostMode('shop')).toBeUndefined();
    expect(host.isClean('shop')).toBe(true);
    expect(host.certs.has('linkeon-shop2')).toBe(true);
    expect(host.vhostDomains.get('shop2')).toEqual(['other-client.ru']);
    expect(host.vhostMode('shop2')).toBe('live');
  });

  it('конфиг nginx не удалился — отказ «не удалён», сертификат цел, certbot не звали', async () => {
    await seed('shop');
    host.issueCert('linkeon-shop', ['shop-client.ru']);
    host.before = (argv) => {
      if (argv[0] === 'rm') throw new Error('rm: cannot remove: Read-only file system');
    };
    await expect(purgeProduct({ slug: 'shop', kind: 'site' }, deps(host))).rejects.toThrow(/конфиг nginx продукта shop не удалён/);
    expect(host.certs.has('linkeon-shop')).toBe(true);
    expect(host.ran('certbot')).toHaveLength(0);
    expect(host.containers.has('shop')).toBe(true);
    expect(host.dirs.has('/srv/products/shop')).toBe(true);
  });

  it('vhost не снялся (nginx не перечитан) — контейнер и каталог остаются: порт держит живой домен', async () => {
    await seed('shop');
    host.issueCert('linkeon-shop', ['shop-client.ru']);
    host.before = (argv) => {
      if (argv[0] === 'systemctl') throw new Error('Job for nginx.service failed');
    };
    await expect(purgeProduct({ slug: 'shop', kind: 'site' }, deps(host))).rejects.toThrow(/удалён, но nginx не перечитан/);
    expect(host.certs.has('linkeon-shop')).toBe(true);
    expect(host.ran('certbot')).toHaveLength(0);
    expect(host.containers.has('shop')).toBe(true);
    expect(host.dirs.has('/srv/products/shop')).toBe(true);
  });

  it('certbot отказал не «нет сертификата» — отказ, контейнер цел', async () => {
    await seed('shop');
    host.issueCert('linkeon-shop', ['shop-client.ru']);
    host.before = (argv) => {
      if (argv[0] === 'certbot') throw new Error('Another instance of Certbot is already running');
    };
    await expect(purgeProduct({ slug: 'shop', kind: 'site' }, deps(host))).rejects.toThrow(/certbot/i);
    expect(host.containers.has('shop')).toBe(true);
  });

  it('certbot delete отказал — отказ до контейнеров', async () => {
    await seed('shop');
    host.issueCert('linkeon-shop', ['shop-client.ru']);
    host.before = (argv) => {
      if (argv[0] === 'certbot' && argv[1] === 'delete') throw new Error('Another instance of Certbot is already running');
    };
    await expect(purgeProduct({ slug: 'shop', kind: 'site' }, deps(host))).rejects.toThrow(/certbot не удалил/);
    expect(host.certs.has('linkeon-shop')).toBe(true);
    expect(host.containers.has('shop')).toBe(true);
    expect(dockerRms()).toHaveLength(0);
  });

  it('сертификат с именем продукта, но подстановочный (*.) — чужой: отказ, сертификат, контейнер и каталог целы', async () => {
    // Общий сертификат машины, названный по неосторожности linkeon-<слово>,
    // где слово — годный слаг: стирание продукта «products» снесло бы TLS всех.
    await seed('products');
    host.issueCert('linkeon-products', ['*.linkeon.io', 'linkeon.io']);
    await expect(purgeProduct({ slug: 'products', kind: 'site' }, deps(host))).rejects.toThrow(/\*\.linkeon\.io/);
    expect(host.certs.has('linkeon-products')).toBe(true);
    expect(host.ran('certbot').map((c) => c[1])).toEqual(['certificates']);
    expect(host.containers.has('products')).toBe(true);
    expect(host.dirs.has('/srv/products/products')).toBe(true);
    expect(host.removedDirs).toHaveLength(0);
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
      if (argv[0] === 'docker' && argv[1] === 'rm') host.containers.delete('bot1');
    };
    await expect(purgeProduct({ slug: 'bot1', kind: 'bot' }, deps(host))).resolves.toBeUndefined();
    expect(host.isClean('bot1')).toBe(true);
  });

  it('каталог всё ещё смонтирован в чужой контейнер — отказ вплотную к удалению, каталог и контейнер целы', async () => {
    await seed('bot1', 'bot');
    await runNamed('spy', '-v', '/srv/products/bot1:/data');
    await expect(purgeProduct({ slug: 'bot1', kind: 'bot' }, deps(host))).rejects.toThrow(/spy/);
    expect(host.dirs.has('/srv/products/bot1')).toBe(true);
    expect(host.removedDirs).toHaveLength(0);
    expect(host.containers.has('spy')).toBe(true);
  });

  it('каталог удалился не целиком — отказ с кодом ошибки, без имён файлов продукта', async () => {
    await seed('bot1', 'bot');
    const removeDir = async () => {
      throw Object.assign(new Error("EACCES: permission denied, unlink '/srv/products/bot1/тайна-клиента.txt'"), { code: 'EACCES' });
    };
    const err: Error = await purgeProduct({ slug: 'bot1', kind: 'bot' }, deps(host, { removeDir })).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/каталог \/srv\/products\/bot1.*EACCES/);
    expect(err.message).not.toMatch(/тайна/);
  });
});

describe('контейнеры продукта — по точным именам и полным идентификаторам', () => {
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
    const shopId = host.idOf('shop');
    host.calls.length = 0;
    await purgeProduct({ slug: 'shop', kind: 'site' }, deps(host));
    expect([...host.containers.keys()].sort()).toEqual(['shop-2', 'shop2', ...decoys].sort());
    expect(dockerRms()).toEqual([['docker', 'rm', '-f', '-v', shopId]]);
    expect(host.dirs.has('/srv/products/shop-2')).toBe(true);
    expect(host.dirs.has('/srv/products/shop2')).toBe(true);
    expect(host.vhostMode('shop-2')).toBe('live');
  });

  it('снятие — по полному идентификатору: исчезнувшее имя не находит соседа по началу идентификатора', async () => {
    // docker ищет ссылку так: полный id → имя → НАЧАЛО id. Слаг из одних
    // шестнадцатеричных знаков, исчезнувший между перечнем и rm, нашёл бы
    // соседа, чей id с этого слага начинается.
    await seed('abc1', 'bot');
    await seed('other', 'bot');
    host.containers.get('other')!.id = `abc1${'0'.repeat(60)}`;
    const ownId = host.idOf('abc1');
    host.before = (argv) => {
      if (argv[0] === 'docker' && argv[1] === 'rm') host.containers.delete('abc1');
    };
    await expect(purgeProduct({ slug: 'abc1', kind: 'bot' }, deps(host))).resolves.toBeUndefined();
    expect(host.containers.has('other')).toBe(true);
    expect(dockerRms()).toEqual([['docker', 'rm', '-f', '-v', ownId]]);
  });
});

describe('сертификат: имена из `certbot certificates`', () => {
  const block = (name: string, domains: string) =>
    `  Certificate Name: ${name}\n    Serial Number: 3f\n    Key Type: ECDSA\n    Domains: ${domains}\n` +
    `    Expiry Date: 2027-01-20 10:00:00+00:00 (VALID: 85 days)\n` +
    `    Certificate Path: /etc/letsencrypt/live/${name}/fullchain.pem\n    Private Key Path: /etc/letsencrypt/live/${name}/privkey.pem\n`;
  const dashes = '- - - - - - - -';

  it('имена берутся только из блока с ТОЧНО этим именем сертификата', () => {
    const out = `\n${dashes}\nFound the following certs:\n${block('linkeon-shop-2', '*.evil.ru')}${block('linkeon-shop', 'a.ru www.a.ru')}${dashes}\n`;
    expect(certDomainsFrom(out, 'linkeon-shop')).toEqual(['a.ru', 'www.a.ru']);
    expect(certDomainsFrom(out, 'linkeon-shop-2')).toEqual(['*.evil.ru']);
    expect(certDomainsFrom(out, 'linkeon-sho')).toBeUndefined();
  });

  it('«No certificates found.» и пустой список — сертификата нет; блок без строки Domains — пустой список', () => {
    expect(certDomainsFrom(`\n${dashes}\nNo certificates found.\n${dashes}\n`, 'linkeon-shop')).toBeUndefined();
    expect(certDomainsFrom(`\n${dashes}\nFound the following matching certs:\n\n${dashes}\n`, 'linkeon-shop')).toBeUndefined();
    expect(certDomainsFrom('  Certificate Name: linkeon-shop\n    Serial Number: 3f\n', 'linkeon-shop')).toEqual([]);
  });
});

describe('путь стирания — только /srv/products/<слаг>', () => {
  it.each(['', '.', '..', 'a/b', '../etc', 'shop/..', '-rf', 'SHOP', 'shop ', 'shop\nx', 'a_b', 'shop__rekey'])(
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

  it('каталога продуктов нет — отказ, а не «стирать нечего»', async () => {
    host.baseDirs.delete('/srv/products');
    await expect(purgeProduct({ slug: 'shop', kind: 'site' }, deps(host))).rejects.toThrow(/каталог продуктов/);
    expect(host.calls).toHaveLength(0);
  });

  it('настоящий путь не тот, что собран (ссылка по дороге) — отказ до любого вызова, ничего не стёрто', async () => {
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

  it('по пути продукта лежит не каталог — отказ до любого вызова', async () => {
    await seed('shop');
    host.calls.length = 0;
    await expect(
      purgeProduct({ slug: 'shop', kind: 'site' }, deps(host, { pathKind: async () => 'other' })),
    ).rejects.toThrow(/не каталог/);
    expect(host.calls).toHaveLength(0);
  });

  it('путь сверяется и вплотную к удалению: подменённый после снятия контейнеров — каталог цел', async () => {
    await seed('bot1', 'bot');
    // Ссылка «появляется», как только контейнеров не стало.
    const realpathSwapped = async (p: string) => (host.containers.has('bot1') ? host.realpath(p) : '/');
    await expect(purgeProduct({ slug: 'bot1', kind: 'bot' }, deps(host, { realpath: realpathSwapped }))).rejects.toThrow(/ссылка/);
    expect(host.containers.has('bot1')).toBe(false);
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

  /** Настоящие exists/realpath/pathKind/removeDir, симулятор — только для docker, nginx, certbot. */
  const realFs = (productsDir = root) => {
    const real = hostDeps();
    return deps(host, {
      exists: real.exists,
      realpath: real.realpath,
      pathKind: real.pathKind,
      removeDir: real.removeDir,
      productsDir,
    });
  };

  it('каталог продукта — ссылка наружу: отказ до любого вызова, снаружи цело, сама ссылка цела', async () => {
    await symlink(outside, join(root, 'shop'));
    await runNamed('shop');
    host.calls.length = 0;
    await expect(purgeProduct({ slug: 'shop', kind: 'site' }, realFs())).rejects.toThrow(/ссылка/);
    expect(host.calls).toHaveLength(0);
    expect(host.containers.has('shop')).toBe(true);
    expect(await precious()).toBe('не трогать');
    expect((await lstat(join(root, 'shop'))).isSymbolicLink()).toBe(true);
  });

  it('каталог продукта — битая ссылка: отказ, а не «уже стёрт»', async () => {
    await symlink(join(base, 'нет-такого'), join(root, 'shop'));
    await expect(purgeProduct({ slug: 'shop', kind: 'bot' }, realFs())).rejects.toThrow(/ссылка/);
    expect(host.calls).toHaveLength(0);
    expect((await lstat(join(root, 'shop'))).isSymbolicLink()).toBe(true);
  });

  it('каталог продуктов — ссылка: стирание сверяет настоящий путь и отказывает, ничего не тронуто', async () => {
    const linked = join(base, 'linked-products');
    await symlink(root, linked);
    await mkdir(join(root, 'shop'));
    await writeFile(join(root, 'shop', 'server.js'), 'код', 'utf8');
    await expect(purgeProduct({ slug: 'shop', kind: 'bot' }, realFs(linked))).rejects.toThrow(/ссылка/);
    expect(host.calls).toHaveLength(0);
    expect(existsSync(join(root, 'shop', 'server.js'))).toBe(true);
  });

  it('каталог продуктов — битая ссылка или его нет вовсе: отказ, а не «уже стёрт»', async () => {
    const broken = join(base, 'broken-products');
    await symlink(join(base, 'нет-такого'), broken);
    await expect(purgeProduct({ slug: 'shop', kind: 'bot' }, realFs(broken))).rejects.toThrow(/каталог продуктов/);
    await expect(purgeProduct({ slug: 'shop', kind: 'bot' }, realFs(join(base, 'nope')))).rejects.toThrow(/каталог продуктов/);
    expect(host.calls).toHaveLength(0);
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
