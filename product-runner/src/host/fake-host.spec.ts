/**
 * СОБСТВЕННЫЕ СВОЙСТВА СИМУЛЯТОРА ХОСТА.
 *
 * Симулятор теперь общий: на нём стоят и заведение (provision.spec.ts), и сон
 * с пробуждением (sleep.spec.ts). Незамеченная правка в нём ослабляет сразу
 * обе батареи и делает это молча — обе останутся зелёными, просто начнут
 * проверять модель, в которой docker ведёт себя не как docker.
 *
 * Здесь пришпилены ровно те свойства, на которые опираются те две батареи, и
 * ни одного сверх: симулятор — не продукт, а прибор, и он обязан быть
 * поверяемым.
 */
import { FakeHost } from './fake-host';

let host: FakeHost;
beforeEach(() => {
  host = new FakeHost();
});

/** Минимальный законный `docker run`, разбираемый симулятором. */
const run = (name: string, port?: number) =>
  host.run([
    'docker',
    'run',
    '-d',
    '--name',
    name,
    '--restart',
    'unless-stopped',
    ...(port ? ['-p', `127.0.0.1:${port}:3000`] : []),
    'linkeon-product:base',
  ]);

describe('контейнеры', () => {
  it('stop оставляет контейнер, rm — убирает', async () => {
    await run('a');

    await host.run(['docker', 'stop', 'a']);
    expect([host.containers.has('a'), host.isRunning('a')]).toEqual([true, false]);

    await host.run(['docker', 'rm', '-f', 'a']);
    expect(host.containers.has('a')).toBe(false);
  });

  it('start возвращает контейнер в работу', async () => {
    await run('a');
    await host.run(['docker', 'stop', 'a']);

    await host.run(['docker', 'start', 'a']);

    expect(host.isRunning('a')).toBe(true);
  });

  it('stop и start повторяются без отказа, как у живого docker', async () => {
    await run('a');

    await host.run(['docker', 'stop', 'a']);
    await expect(host.run(['docker', 'stop', 'a'])).resolves.toBeDefined();
    await host.run(['docker', 'start', 'a']);
    await expect(host.run(['docker', 'start', 'a'])).resolves.toBeDefined();

    expect(host.isRunning('a')).toBe(true);
  });

  it('stop и start по несуществующему имени — отказ', async () => {
    for (const sub of ['stop', 'start']) {
      await expect(host.run(['docker', sub, 'net'])).rejects.toThrow(/No such container/);
    }
  });

  it('порт освобождается остановкой и отбирается обратно стартом', async () => {
    // ИМЕННО ЗДЕСЬ живёт опасность сна: `freePort` боевых зависимостей
    // спрашивает `docker ps` без `-a`, и порт спящего продукта достаётся
    // новому. Симулятор обязан это воспроизводить, иначе сценарий
    // «пробуждение на занятый порт» проверял бы выдумку.
    await run('a', 8001);
    await expect(run('b', 8001)).rejects.toThrow(/port is already allocated/);

    await host.run(['docker', 'stop', 'a']);
    await expect(run('b', 8001)).resolves.toBeDefined();

    await expect(host.run(['docker', 'start', 'a'])).rejects.toThrow(/port is already allocated/);
  });

  it('docker ps показывает остановленный только с -a', async () => {
    // `containerTaken` спрашивает с `-a` намеренно: имя занимает и погашенный
    // контейнер, и `docker run` на него споткнётся.
    await run('a');
    await host.run(['docker', 'stop', 'a']);

    const withA = await host.run(['docker', 'ps', '-a', '--filter', 'name=^a$', '--format', '{{.Names}}']);
    const withoutA = await host.run(['docker', 'ps', '--filter', 'name=^a$', '--format', '{{.Names}}']);

    expect(withA.trim()).toBe('a');
    expect(withoutA.trim()).toBe('');
  });

  it('имя занято и погашенным контейнером', async () => {
    await run('a');
    await host.run(['docker', 'stop', 'a']);

    await expect(run('a')).rejects.toThrow(/already in use/);
  });
});

describe('docker inspect: где у остановленного контейнера лежит порт', () => {
  const BINDINGS = '{{with index .HostConfig.PortBindings "3000/tcp"}}{{(index . 0).HostPort}}{{end}}';
  const NETWORK = '{{with index .NetworkSettings.Ports "3000/tcp"}}{{(index . 0).HostPort}}{{end}}';
  const inspect = (format: string, name: string) =>
    host.run(['docker', 'inspect', '--format', format, name]);

  it('PortBindings переживает остановку, NetworkSettings.Ports — нет', async () => {
    // ИЗМЕРЕНО НА ЖИВОМ DOCKER 29.8.0 (23.09.2026), а не выведено из общих
    // соображений: у остановленного контейнера `.NetworkSettings.Ports` пуст
    // (`{}`), а `.HostConfig.PortBindings` держит публикацию.
    //
    // Пробуждение спрашивает порт у контейнера, который СПИТ. Симулятор,
    // отдающий его по обоим полям одинаково, зеленил бы восстановление, которое
    // на машине продуктов не подняло бы ни одного продукта.
    await run('a', 8001);
    expect([await inspect(BINDINGS, 'a'), await inspect(NETWORK, 'a')].map((s) => s.trim())).toEqual(
      ['8001', '8001'],
    );

    await host.run(['docker', 'stop', 'a']);

    expect((await inspect(BINDINGS, 'a')).trim()).toBe('8001');
    expect((await inspect(NETWORK, 'a')).trim()).toBe('');
  });

  it('контейнер без публикации порта отдаёт пустую строку, а не выдумку', async () => {
    // Это бот: у него порта нет вовсе, и «не знаю» обязано отличаться от числа.
    await run('bot');

    expect((await inspect(BINDINGS, 'bot')).trim()).toBe('');
  });

  it('голый index падает там, где {{with}} отдаёт пустую строку', async () => {
    // Тоже замерено: `{{ (index (index .NetworkSettings.Ports "3000/tcp") 0).HostPort }}`
    // на остановленном контейнере не печатает пустоту, а валится с
    // «index of untyped nil» и rc=1 — то есть execFile бросает.
    await run('a', 8001);
    await host.run(['docker', 'stop', 'a']);

    await expect(
      inspect('{{ (index (index .NetworkSettings.Ports "3000/tcp") 0).HostPort }}', 'a'),
    ).rejects.toThrow(/untyped nil/);
  });

  it('несуществующий контейнер — отказ, а не пустая строка', async () => {
    await expect(inspect(BINDINGS, 'net')).rejects.toThrow(/No such object/);
  });
});

describe('vhost', () => {
  it('порт даёт боевой режим, --asleep — заглушку', async () => {
    await host.run(['product-vhost', 'shop', '8001']);
    expect([host.vhostMode('shop'), host.liveVhosts.get('shop')]).toEqual(['live', 8001]);

    await host.run(['product-vhost', 'shop', '--asleep']);
    expect(host.vhostMode('shop')).toBe('asleep');
  });

  it('заглушка снимается возвратом порта', async () => {
    await host.run(['product-vhost', 'shop', '--asleep']);

    await host.run(['product-vhost', 'shop', '8003']);

    expect([host.vhostMode('shop'), host.liveVhosts.get('shop')]).toEqual(['live', 8003]);
  });

  it('аргумент, который не порт и не --asleep, — отказ', async () => {
    // Живой скрипт — `sh -eu` с `S="$1"; P="$2"`, и конфиг он пишет ДО
    // `nginx -t`. Непонятый аргумент означал бы битый `proxy_pass`,
    // оставшийся на диске, и упавший `nginx -t` для ВСЕГО хоста: ни один
    // продукт больше не перечитался бы.
    await expect(host.run(['product-vhost', 'shop', '--sleep'])).rejects.toThrow(/порт не число/);
  });

  it('снятие конфига убирает и режим', async () => {
    await host.run(['product-vhost', 'shop', '8001']);
    await host.run(['rm', '-f', '/etc/nginx/sites-products/shop.conf']);
    await host.run(['systemctl', 'reload', 'nginx']);

    expect(host.vhostMode('shop')).toBeUndefined();
  });

  it('домена нет вовсе — это не заглушка и не боевой режим', async () => {
    expect(host.vhostMode('nikogo')).toBeUndefined();
  });

  it('свои имена запоминаются по каждому вызову — и в прокси, и в заглушке', async () => {
    // Каждый вызов ПЕРЕПИСЫВАЕТ конфиг целиком: имена, не приехавшие в этом
    // вызове, из конфига уходят. Ровно на этом стоят проверки «сон не потерял
    // домен», поэтому симулятор обязан помнить последний набор, а не копить.
    await host.run(['product-vhost', 'shop', '8001', '--domain', 'a.ru', '--domain', 'www.a.ru']);
    expect(host.vhostDomains.get('shop')).toEqual(['a.ru', 'www.a.ru']);

    await host.run(['product-vhost', 'shop', '--asleep', '--domain', 'a.ru']);
    expect([host.vhostMode('shop'), host.vhostDomains.get('shop')]).toEqual(['asleep', ['a.ru']]);

    await host.run(['product-vhost', 'shop', '8001']);
    expect(host.vhostDomains.get('shop')).toEqual([]);
  });

  it('непонятный хвост после цели — отказ, а не молча проглоченный аргумент', async () => {
    // Хвост, который симулятор пропустил бы, живой скрипт тоже должен был бы
    // понять — иначе батарея зеленит форму вызова, на которой скрипт падает.
    await expect(host.run(['product-vhost', 'shop', '8001', 'a.ru'])).rejects.toThrow(/хвост/);
    await expect(host.run(['product-vhost', 'shop', '8001', '--domain'])).rejects.toThrow(/хвост/);
    await expect(host.run(['product-vhost', 'shop', '--asleep', '--name', 'a.ru'])).rejects.toThrow(/хвост/);
  });
});

describe('certbot', () => {
  const certonly = (name: string, ...domains: string[]) =>
    host.run(['certbot', 'certonly', '--webroot', '-w', '/var/www/linkeon-acme', '--cert-name', name,
      '--non-interactive', '--agree-tos', '--keep-until-expiring', '--expand',
      ...domains.flatMap((d) => ['-d', d])]);

  it('certonly выпускает сертификат, delete снимает', async () => {
    await certonly('linkeon-shop', 'a.ru');
    expect(host.certs.has('linkeon-shop')).toBe(true);

    await host.run(['certbot', 'delete', '--cert-name', 'linkeon-shop', '--non-interactive']);
    expect(host.certs.has('linkeon-shop')).toBe(false);
  });

  it('отказ выпуска — текстом, заданным тестом, и сертификата нет', async () => {
    host.certbotFails = 'Type: unauthorized';

    await expect(certonly('linkeon-shop', 'a.ru')).rejects.toThrow('Type: unauthorized');
    expect(host.certs.size).toBe(0);
  });

  it('delete несуществующего — отказ «No certificate found», как у живого certbot', async () => {
    await expect(
      host.run(['certbot', 'delete', '--cert-name', 'linkeon-net', '--non-interactive']),
    ).rejects.toThrow(/No certificate found with name linkeon-net/);
  });

  it('прочие подкоманды — отказ', async () => {
    await expect(host.run(['certbot', 'renew'])).rejects.toThrow(/certbot/);
  });
});

describe('контейнер целиком и образы — для смены ключей', () => {
  it('inspect {{json .}}: образ, метка, окружение, порт, каталог, лимиты', async () => {
    host.tagImage('linkeon-product:base', 'sha256:aaa', ['PATH=/usr/bin', 'CHECKOUT_PATH=/product']);
    await host.run([
      'docker', 'run', '-d', '--name', 'shop', '--restart', 'unless-stopped', '-v', '/srv/products/shop:/product',
      '-p', '127.0.0.1:8001:3000', '-e', 'RUNNER_TOKEN=ткн', '-e', 'API_KEY=k', '--memory=1g', '--cpus=1', 'linkeon-product:base',
    ]);
    const j = JSON.parse(await host.run(['docker', 'inspect', '--format', '{{json .}}', 'shop']));
    expect(j.Image).toBe('sha256:aaa');
    expect(j.Config.Image).toBe('linkeon-product:base');
    // Исправлено по ревью: живой docker кладёт СВОИ переменные (-e, в
    // порядке argv) первыми, переменные образа — следом; было наоборот.
    expect(j.Config.Env).toEqual(['RUNNER_TOKEN=ткн', 'API_KEY=k', 'PATH=/usr/bin', 'CHECKOUT_PATH=/product']);
    expect(j.HostConfig.PortBindings).toEqual({ '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '8001' }] });
    expect(j.HostConfig.Memory).toBe(1073741824);
    expect(j.HostConfig.NanoCpus).toBe(1e9);
    // Исправлено по ревью: живой docker всегда отдаёт MaximumRetryCount.
    expect(j.HostConfig.RestartPolicy).toEqual({ Name: 'unless-stopped', MaximumRetryCount: 0 });
    expect(j.Mounts).toEqual([{ Type: 'bind', Source: '/srv/products/shop', Destination: '/product', RW: true }]);
    expect(j.State.Running).toBe(true);
  });

  it('-e поверх переменной образа — одна строка с новым значением, как у docker', async () => {
    host.tagImage('linkeon-product:base', 'sha256:aaa', ['TZ=UTC']);
    await host.run(['docker', 'run', '-d', '--name', 'b', '--restart', 'unless-stopped', '-e', 'TZ=Europe/Moscow', 'linkeon-product:base']);
    const j = JSON.parse(await host.run(['docker', 'inspect', '--format', '{{json .}}', 'b']));
    expect(j.Config.Env).toEqual(['TZ=Europe/Moscow']);
  });

  it('image inspect: метки и окружение образа; передвинутая метка смотрит на новый образ', async () => {
    host.tagImage('linkeon-product:base', 'sha256:old', []);
    host.tagImage('linkeon-product:src-111111111111', 'sha256:old', []);
    host.tagImage('linkeon-product:base', 'sha256:new', ['A=1']);
    const old = JSON.parse(await host.run(['docker', 'image', 'inspect', '--format', '{{json .}}', 'sha256:old']));
    expect(old.RepoTags).toEqual(['linkeon-product:src-111111111111']);
    const base = JSON.parse(await host.run(['docker', 'image', 'inspect', '--format', '{{json .}}', 'linkeon-product:base']));
    expect(base.Id).toBe('sha256:new');
    expect(base.Config.Env).toEqual(['A=1']);
    await expect(host.run(['docker', 'image', 'inspect', '--format', '{{json .}}', 'nope:1'])).rejects.toThrow(/No such image/);
  });

  it('rename переносит контейнер вместе с остановленностью; занятое имя — отказ', async () => {
    await run('shop', 8001);
    await host.run(['docker', 'stop', 'shop']);
    await host.run(['docker', 'rename', 'shop', 'shop__rekey']);
    expect(host.containers.has('shop')).toBe(false);
    expect(host.containers.has('shop__rekey')).toBe(true);
    expect(host.isRunning('shop__rekey')).toBe(false);
    await run('shop', 8001);
    await expect(host.run(['docker', 'rename', 'shop__rekey', 'shop'])).rejects.toThrow(/Conflict/);
  });

  it('exec node: здоров по правилу теста; остановленный — отказ', async () => {
    await run('bot');
    await expect(host.run(['docker', 'exec', 'bot', 'node', '-e', 'x'])).resolves.toBe('');
    host.healthy = () => false;
    await expect(host.run(['docker', 'exec', 'bot', 'node', '-e', 'x'])).rejects.toThrow(/exit/);
    host.healthy = () => true;
    await host.run(['docker', 'stop', 'bot']);
    await expect(host.run(['docker', 'exec', 'bot', 'node', '-e', 'x'])).rejects.toThrow(/not running/);
  });

  it('probePort отвечает за запущенный контейнер на порту и по тому же правилу здоровья', async () => {
    await run('shop', 8001);
    expect(host.probePort(8001)).toBe(true);
    expect(host.probePort(8002)).toBe(false);
    host.healthy = (_name, c) => c.env.API_KEY !== 'плохой';
    host.containers.get('shop')!.env.API_KEY = 'плохой';
    expect(host.probePort(8001)).toBe(false);
  });

  it('exec node: синтаксическая ошибка в скрипте — отказ ДО правила здоровья, а не вместо него', async () => {
    // node -e компилирует скрипт прежде, чем выполнить его; ломаная строка
    // (например, кривой HEALTH_INSIDE из rekey.ts) обязана упасть здесь же —
    // `healthy` вообще не должно вызываться.
    await run('bot');
    host.healthy = () => {
      throw new Error('healthy не должен был вызваться: скрипт не скомпилировался');
    };
    await expect(host.run(['docker', 'exec', 'bot', 'node', '-e', 'this ( is not valid js'])).rejects.toThrow(/exit/);
  });

  it('--memory: мусор — отказ как у docker; kb/mb/gb и ...ib принимаются', async () => {
    await expect(
      host.run(['docker', 'run', '-d', '--name', 'z1', '--restart', 'unless-stopped', '--memory=мусор', 'linkeon-product:base']),
    ).rejects.toThrow(/--memory/);

    await host.run(['docker', 'run', '-d', '--name', 'z2', '--restart', 'unless-stopped', '--memory=512mb', 'linkeon-product:base']);
    const j = JSON.parse(await host.run(['docker', 'inspect', '--format', '{{json .}}', 'z2']));
    expect(j.HostConfig.Memory).toBe(512 * 1024 ** 2);
  });

  it('--cpus: мусор и значение вне диапазона хоста (0.01..4) — отказ', async () => {
    const run2 = (name: string, cpus: string) =>
      host.run(['docker', 'run', '-d', '--name', name, '--restart', 'unless-stopped', `--cpus=${cpus}`, 'linkeon-product:base']);
    await expect(run2('z3', 'много')).rejects.toThrow(/--cpus/);
    await expect(run2('z4', '8')).rejects.toThrow(/Range of CPUs/);
    await expect(run2('z5', '0.001')).rejects.toThrow(/Range of CPUs/);
  });

  it('образ неизменяем: тот же id с другим окружением — отказ; переезд метки не меняет уже созданный контейнер', async () => {
    host.tagImage('linkeon-product:base', 'sha256:aaa', ['A=1']);
    await run('shop');

    expect(() => host.tagImage('linkeon-product:base', 'sha256:aaa', ['A=2'])).toThrow(/sha256:aaa/);

    // Переезд метки на НОВЫЙ id — это разрешённое обновление образа
    // (`product-image-roll.sh`): уже созданный контейнер своего id не теряет.
    host.tagImage('linkeon-product:base', 'sha256:bbb', ['B=1']);
    const j = JSON.parse(await host.run(['docker', 'inspect', '--format', '{{json .}}', 'shop']));
    expect(j.Image).toBe('sha256:aaa');
    expect(j.Config.Env).toEqual(['A=1']);
  });

  it('-p и -v в непонятной форме — отказ, а не тихий разбор мимо значения', async () => {
    const base = ['docker', 'run', '-d', '--name', 'z6', '--restart', 'unless-stopped'];
    await expect(host.run([...base, '-p', '8001:3000', 'linkeon-product:base'])).rejects.toThrow(/-p/);
    await expect(
      host.run([...base, '-v', '/srv/products/z6:/product:ro', 'linkeon-product:base']),
    ).rejects.toThrow(/-v/);
  });

  it('незнакомый образ (не DEFAULTS.image и не заведённый tagImage) — отказ, как у живого docker', async () => {
    await expect(
      host.run(['docker', 'run', '-d', '--name', 'z7', '--restart', 'unless-stopped', 'левый-образ:1']),
    ).rejects.toThrow(/Unable to find image/);
  });

  it('RestartPolicy "no" и MaximumRetryCount у контейнера без --restart (заведён вручную, как в provision.spec.ts)', async () => {
    host.containers.set('legacy', { mount: '', env: {}, image: 'linkeon-product:base', cmd: [] });
    const j = JSON.parse(await host.run(['docker', 'inspect', '--format', '{{json .}}', 'legacy']));
    expect(j.HostConfig.RestartPolicy).toEqual({ Name: 'no', MaximumRetryCount: 0 });
  });
});
