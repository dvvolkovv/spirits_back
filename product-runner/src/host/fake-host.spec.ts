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

  it('docker ps без фильтра перечисляет имена: с -a — все, без — только запущенные', async () => {
    // Так стирание (purge.ts) ищет страховки обновления образа `<слаг>__pre_<хеш>`:
    // хеша оно не знает, а маску отдавать docker не хочет — сверяет имена само.
    await run('a');
    await run('b');
    await host.run(['docker', 'stop', 'b']);

    const all = await host.run(['docker', 'ps', '-a', '--format', '{{.Names}}']);
    const running = await host.run(['docker', 'ps', '--format', '{{.Names}}']);

    expect(all.split('\n').filter(Boolean).sort()).toEqual(['a', 'b']);
    expect(running.split('\n').filter(Boolean)).toEqual(['a']);
    await expect(host.run(['docker', 'ps', '-a', '--format', '{{.Ports}}'])).rejects.toThrow(/\{\{\.Names\}\}/);
    expect(await new FakeHost().run(['docker', 'ps', '-a', '--format', '{{.Names}}'])).toBe('');
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

  it('certificates --cert-name: блок с именами, как у живого certbot; нет сертификатов — «No certificates found.»', async () => {
    const list = (name: string) => host.run(['certbot', 'certificates', '--cert-name', name]);
    expect(await list('linkeon-shop')).toMatch(/No certificates found\./);

    await certonly('linkeon-shop', 'a.ru', 'www.a.ru');
    expect(await list('linkeon-shop')).toMatch(/Certificate Name: linkeon-shop\n[\s\S]*Domains: a\.ru www\.a\.ru\n/);
    // Чужое имя — пустой список под заголовком, а не чужой блок.
    const other = await list('linkeon-shop2');
    expect(other).toMatch(/Found the following matching certs:/);
    expect(other).not.toMatch(/Certificate Name/);

    await host.run(['certbot', 'delete', '--cert-name', 'linkeon-shop', '--non-interactive']);
    expect(await list('linkeon-shop')).toMatch(/No certificates found\./);
  });

  it('issueCert заводит сертификат с именами; заведённый без имён — отказ симулятора, а не выдуманные имена', async () => {
    host.issueCert('linkeon-x', ['*.linkeon.io']);
    expect(await host.run(['certbot', 'certificates', '--cert-name', 'linkeon-x'])).toMatch(/Domains: \*\.linkeon\.io\n/);

    host.certs.add('linkeon-bare');
    await expect(host.run(['certbot', 'certificates', '--cert-name', 'linkeon-bare'])).rejects.toThrow(/issueCert/);
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
    expect(j.State.Restarting).toBe(false);
  });

  it('inspect --type container: тот же JSON; не контейнер — «No such container»; иной тип — отказ', async () => {
    // Смена ключей спрашивает именно контейнер: без --type живой docker отдал
    // бы и образ с тем же именем, если контейнера нет.
    await run('shop', 8001);
    const plain = JSON.parse(await host.run(['docker', 'inspect', '--format', '{{json .}}', 'shop']));
    const typed = JSON.parse(await host.run(['docker', 'inspect', '--type', 'container', '--format', '{{json .}}', 'shop']));
    expect(typed).toEqual(plain);
    await expect(
      host.run(['docker', 'inspect', '--type', 'container', '--format', '{{json .}}', 'nope']),
    ).rejects.toThrow(/No such container: nope/);
    await expect(host.run(['docker', 'inspect', '--type', 'volume', '--format', '{{json .}}', 'shop'])).rejects.toThrow(/--type/);
  });

  it('падает сразу после старта: start отвечает успехом, inspect — restarting, exec и порт молчат', async () => {
    // Так живой docker показывает петлю перезапусков при --restart
    // unless-stopped: Running=true вместе с Restarting=true (StateString →
    // "restarting"). `docker start` при этом возвращает 0 — он отвечает за
    // запуск процесса, а не за то, что процесс удержался.
    await run('shop', 8001);
    await host.run(['docker', 'stop', 'shop']);
    host.crashing = (name) => name === 'shop';
    await expect(host.run(['docker', 'start', 'shop'])).resolves.toBe('shop');
    const j = JSON.parse(await host.run(['docker', 'inspect', '--type', 'container', '--format', '{{json .}}', 'shop']));
    expect(j.State).toEqual({ Running: true, Restarting: true, Status: 'restarting' });
    await expect(host.run(['docker', 'exec', 'shop', 'node', '-e', 'x'])).rejects.toThrow(/is restarting/);
    expect(host.probePort(8001)).toBe(false);
  });

  it('падает без политики перезапуска — exited, как у docker', async () => {
    host.containers.set('legacy', { mount: '', env: {}, image: 'linkeon-product:base', cmd: [] });
    host.crashing = () => true;
    const j = JSON.parse(await host.run(['docker', 'inspect', '--format', '{{json .}}', 'legacy']));
    expect(j.State).toEqual({ Running: false, Restarting: false, Status: 'exited' });
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

describe('файлы', () => {
  it('realpath — как fs.realpath в мире без ссылок: путь нормализован, несуществующий — ENOENT', async () => {
    // Ссылок симулятор не изображает: их проверяет purge.spec.ts на настоящей
    // ФС. Но код ENOENT обязан быть тем же, что у fs: по нему стирание
    // отличает «каталога уже нет» (повтор) от «путь не прочитан» (отказ).
    await host.writeFiles('/srv/products/shop', { 'server.js': '' });

    expect(await host.realpath('/srv/products/shop')).toBe('/srv/products/shop');
    expect(await host.realpath('/srv/products/x/../shop/')).toBe('/srv/products/shop');
    await expect(host.realpath('/srv/products/nope')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('каталог продуктов и каталог конфигов nginx есть и на пустом хосте; убранный — ENOENT', async () => {
    expect(await host.realpath('/srv/products')).toBe('/srv/products');
    expect(await host.realpath('/etc/nginx/sites-products/')).toBe('/etc/nginx/sites-products');
    host.baseDirs.delete('/srv/products');
    await expect(host.realpath('/srv/products')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('pathKind — как lstat: каталог, файл конфига nginx, ничего', async () => {
    await host.writeFiles('/srv/products/shop', {});
    await host.run(['product-vhost', 'shop', '8001']);

    expect(await host.pathKind('/srv/products/shop')).toBe('dir');
    expect(await host.pathKind('/etc/nginx/sites-products/shop.conf')).toBe('other');
    expect(await host.pathKind('/etc/nginx/sites-products/nope.conf')).toBe('absent');
    expect(await host.pathKind('/srv/products/nope')).toBe('absent');
  });
});

describe('идентификаторы контейнеров — для стирания', () => {
  it('ps --no-trunc {{.ID}} {{.Names}}: полный id; без --no-trunc — 12 знаков; id переживает rename', async () => {
    await run('a');
    const full = (await host.run(['docker', 'ps', '-a', '--no-trunc', '--format', '{{.ID}} {{.Names}}'])).trim();
    expect(full).toMatch(/^[0-9a-f]{64} a$/);
    const short = (await host.run(['docker', 'ps', '-a', '--format', '{{.ID}} {{.Names}}'])).trim();
    expect(short).toBe(`${full.slice(0, 12)} a`);

    await host.run(['docker', 'rename', 'a', 'b']);
    expect(host.idOf('b')).toBe(full.slice(0, 64));
  });

  it('rm ищет ссылку как docker: полный id → имя → начало id; неоднозначное начало — отказ', async () => {
    await run('a');
    await run('b');
    await run('c');
    host.containers.get('b')!.id = `ab${'1'.repeat(62)}`;
    host.containers.get('c')!.id = `ab${'2'.repeat(62)}`;

    await host.run(['docker', 'rm', '-f', '-v', host.idOf('a')]);
    expect(host.containers.has('a')).toBe(false);

    // Имени «ab» нет — docker берёт начало id, и тут оно неоднозначно.
    await expect(host.run(['docker', 'rm', '-f', 'ab'])).rejects.toThrow(/multiple IDs found/);
    // Однозначное начало снимает соседа: ровно эта опасность и закрыта
    // снятием по полному идентификатору (purge.ts).
    await host.run(['docker', 'rm', '-f', 'ab1']);
    expect([...host.containers.keys()]).toEqual(['c']);

    await expect(host.run(['docker', 'rm', '-f', '-x', 'c'])).rejects.toThrow(/флаг/);
    await expect(host.run(['docker', 'rm', '-v', 'c'])).rejects.toThrow(/без -f/);
  });

  it('ps --filter volume=<путь>: контейнеры, смонтировавшие ровно этот путь (источник или назначение), и с -a — остановленные', async () => {
    const mount = (name: string, v: string) =>
      host.run(['docker', 'run', '-d', '--name', name, '--restart', 'unless-stopped', '-v', v, 'linkeon-product:base']);
    await mount('own', '/srv/products/shop:/product');
    await mount('spy', '/srv/products/shop:/data');
    await mount('other', '/srv/products/shop2:/product');
    await host.run(['docker', 'stop', 'spy']);
    const ps = (...a: string[]) => host.run(['docker', 'ps', ...a, '--format', '{{.Names}}']);

    expect((await ps('-a', '--filter', 'volume=/srv/products/shop')).split('\n').filter(Boolean).sort()).toEqual(['own', 'spy']);
    expect((await ps('--filter', 'volume=/srv/products/shop')).trim()).toBe('own');
    // Замерено на docker 29.8.0: совпадение точное — ни хвостовой слэш, ни родитель не подходят.
    expect(await ps('-a', '--filter', 'volume=/srv/products/shop/')).toBe('');
    expect(await ps('-a', '--filter', 'volume=/srv/products')).toBe('');
    expect((await ps('-a', '--filter', 'volume=/data')).trim()).toBe('spy');
  });
});
