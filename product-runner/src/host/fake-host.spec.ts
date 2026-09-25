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
