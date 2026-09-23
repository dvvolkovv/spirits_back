/**
 * Сон и пробуждение против симулятора хоста — того же, что у заведения.
 *
 * ПОЧЕМУ СИМУЛЯТОР, А НЕ ЗАПИСЬ КОМАНД СТРОКАМИ. `expect(cmds).toContain(...)`
 * ловит форму команды, а не её следствие: проверка «звали docker stop»
 * одинаково зелена и когда контейнер погас, и когда его следом удалили, и
 * когда команда ушла по чужому имени. Здесь спрашивается СОСТОЯНИЕ хоста —
 * жив ли контейнер, запущен ли он, что отдаёт домен.
 */
import { FakeHost, deps } from './fake-host';
import { ProvisionDeps, provision } from './provision';
import { sleepProduct, wakeProduct } from './sleep';

let host: FakeHost;
beforeEach(() => {
  host = new FakeHost();
});

/** Заводит продукт по-настоящему — тем же `provision`, что и на хосте. */
async function seed(
  slug: string,
  kind: 'site' | 'bot' = 'site',
  over: Partial<ProvisionDeps> = {},
): Promise<number | undefined> {
  const res = await provision(
    { slug, kind, name: `имя ${slug}`, runnerToken: 'ткн-раннера', secrets: {} },
    deps(host, over),
  );
  return res.port;
}

describe('сон продукта', () => {
  it('контейнер остановлен, но НЕ удалён', async () => {
    // ГЛАВНОЕ СВОЙСТВО СНА. Удалённый контейнер теряет имя, монтирование и
    // отображение порта, а поднять его заново нечем: `docker run` требует
    // RUNNER_TOKEN, которого у сна нет и взять неоткуда — сервер хранит
    // только sha256, а поворачивать токен на пробуждении нельзя. То есть
    // `rm -f` делает сон невозвратным, и узнать об этом можно было бы только
    // при первом пополнении баланса.
    await seed('shop');

    await sleepProduct({ slug: 'shop', kind: 'site' }, deps(host));

    expect(host.containers.has('shop')).toBe(true);
    expect(host.isRunning('shop')).toBe(false);
    // Каталог и чекаут целы: сон — это про память, а не про данные.
    expect(host.dirs.has('/srv/products/shop')).toBe(true);
  });

  it('домен отдаёт заглушку, а не 502', async () => {
    // 502 читается посетителем как НАША поломка. Это не поломка, а штатное
    // состояние неоплаченного продукта.
    await seed('shop');

    await sleepProduct({ slug: 'shop', kind: 'site' }, deps(host));

    expect(host.vhostMode('shop')).toBe('asleep');
  });

  it('заглушка ставится ДО гашения контейнера', async () => {
    // Обратный порядок открывает окно, в котором домен смотрит на мёртвый
    // порт, — тот самый 502, ради ухода от которого заглушка и заведена.
    // Окно короткое, но приходится ровно на момент, когда владелец смотрит
    // на продукт.
    await seed('shop');
    host.calls.length = 0;

    await sleepProduct({ slug: 'shop', kind: 'site' }, deps(host));

    const vhost = host.calls.findIndex((c) => c[0] === 'product-vhost');
    const stop = host.calls.findIndex((c) => c[0] === 'docker' && c[1] === 'stop');
    expect(vhost).toBeGreaterThanOrEqual(0);
    expect(stop).toBeGreaterThan(vhost);
  });

  it('у бота заглушки нет — у него нет домена', async () => {
    // Заглушка боту завела бы в nginx конфиг на имя, которого никогда не
    // существовало: файл на диске, строка в `nginx -t` и домен, отдающий 503
    // неизвестно кому.
    await seed('bot', 'bot');

    await sleepProduct({ slug: 'bot', kind: 'bot' }, deps(host));

    expect(host.isRunning('bot')).toBe(false);
    expect(host.confFiles.size).toBe(0);
    expect(host.ran('product-vhost')).toHaveLength(0);
  });

  it('слаг проверяется здесь же, до единой команды', async () => {
    // Слаг приехал по сети. Проверка на сервере его не закрывает: она в
    // другом процессе на другой машине, а платит за неё эта. Ведущий дефис в
    // аргументе docker разбирается как флаг.
    await expect(sleepProduct({ slug: '-rf', kind: 'site' }, deps(host))).rejects.toThrow(/слаг/);

    expect(host.calls).toHaveLength(0);
  });

  it('неизвестная форма продукта — отказ до единой команды', async () => {
    await expect(
      sleepProduct({ slug: 'shop', kind: 'сайт' as any }, deps(host)),
    ).rejects.toThrow(/форма продукта/);

    expect(host.calls).toHaveLength(0);
  });

  it('несуществующий контейнер — отказ, а не тихий успех', async () => {
    // Сервер на отказе сна вернёт продукт в работу и напишет причину. Тихий
    // успех означал бы продукт, помеченный спящим, с работающим контейнером:
    // аренду не платит, гасить его больше нечем.
    await expect(sleepProduct({ slug: 'net-takogo', kind: 'bot' }, deps(host))).rejects.toThrow(
      /No such container/,
    );
  });

  it('домен соседа сон не трогает', async () => {
    // Мутация «гасить по имени из другого поля» иначе невидима: в хосте с
    // одним продуктом любое имя — это он.
    await seed('shop');
    await seed('sosed');

    await sleepProduct({ slug: 'shop', kind: 'site' }, deps(host));

    expect(host.isRunning('sosed')).toBe(true);
    expect(host.vhostMode('sosed')).toBe('live');
  });
});

describe('пробуждение продукта', () => {
  /** Заведён и усыплён — ровно то состояние, в котором приходит задание wake. */
  async function asleep(slug: string, kind: 'site' | 'bot' = 'site') {
    const port = await seed(slug, kind);
    await sleepProduct({ slug, kind }, deps(host));
    host.calls.length = 0;
    return port;
  }

  it('контейнер поднят, домен вернулся в боевой режим', async () => {
    const port = await asleep('shop');

    await wakeProduct({ slug: 'shop', kind: 'site', port }, deps(host));

    expect(host.isRunning('shop')).toBe(true);
    expect(host.vhostMode('shop')).toBe('live');
    expect(host.liveVhosts.get('shop')).toBe(port);
  });

  it('домен возвращается на ТОТ ЖЕ порт, а не на выбранный заново', async () => {
    // Порт приезжает с сервера — на хосте он живёт в остановленном
    // контейнере. Новый выбор дал бы домен, смотрящий мимо контейнера: 502
    // при живом продукте, и `promoteReady` не переведёт его в работу никогда.
    await seed('pervy');
    const port = await asleep('vtoroy');
    expect(port).toBe(8002);

    await wakeProduct({ slug: 'vtoroy', kind: 'site', port }, deps(host));

    expect(host.liveVhosts.get('vtoroy')).toBe(8002);
    expect(host.containers.get('vtoroy')!.publish).toBe('127.0.0.1:8002:3000');
  });

  it('не поднявшийся контейнер — отказ, а не тихий успех', async () => {
    const port = await asleep('shop');

    await expect(
      wakeProduct({ slug: 'shop', kind: 'site', port }, deps(host, { waitPort: async () => false })),
    ).rejects.toThrow(/не ответил/);
  });

  it('домен НЕ возвращён, пока продукт не ответил', async () => {
    // Иначе посетитель получает 502 вместо честной заглушки, а `promoteReady`
    // видит неотвечающий адрес и продукт остаётся спящим — то есть заглушку
    // сняли ни за чем.
    const port = await asleep('shop');

    await wakeProduct(
      { slug: 'shop', kind: 'site', port },
      deps(host, { waitPort: async () => false }),
    ).catch(() => undefined);

    expect(host.vhostMode('shop')).toBe('asleep');
  });

  it('ожидание идёт ДО возврата домена, а не после', async () => {
    // Сторож порядка. Проверка «домен не возвращён при отказе» переживает
    // перестановку, если ожидание успешно: оба шага случились, порядок не
    // виден. Здесь он пришпилен явно.
    const port = await asleep('shop');
    const seen: string[] = [];

    await wakeProduct(
      { slug: 'shop', kind: 'site', port },
      deps(host, {
        run: async (argv, opts) => {
          seen.push(argv[0] === 'docker' ? `${argv[0]} ${argv[1]}` : argv[0]);
          return host.run(argv, opts);
        },
        waitPort: async () => {
          seen.push('waitPort');
          return true;
        },
      }),
    );

    expect(seen).toEqual(['docker start', 'waitPort', 'product-vhost']);
  });

  it('сайт без порта: порт восстанавливается у контейнера', async () => {
    // ЖИВОЙ ДЕФЕКТ ПРОДА (замерено 23.09.2026). Продукты, заведённые до
    // появления колонки `port`, хранят в реестре NULL: `demo` и `shop2` от
    // 09.09. Погашенный такой продукт не поднимался НИКОГДА — задание `wake`
    // падало «нет порта» каждую минуту, сайт отдавал 503, и кнопка снятия
    // блокировки была односторонней.
    //
    // Порт при этом никуда не девался: публикация задаётся при `docker run` и
    // `docker start` её не меняет, то есть контейнер знает её сам.
    await seed('pervy');
    const port = await asleep('vtoroy');
    expect(port).toBe(8002);
    const waitPort = jest.fn(async () => true);

    await wakeProduct({ slug: 'vtoroy', kind: 'site', port: null }, deps(host, { waitPort }));

    expect(waitPort).toHaveBeenCalledWith(8002, expect.any(Number));
    // Проверяется именно ВОПРОС КОНТЕЙНЕРУ, а не совпадение числа: `freePort`
    // считает порт спящего свободным (см. fake-host) и вернул бы здесь те же
    // 8002 — то есть «выбрать заново» выглядело бы рабочим на симуляторе и
    // отдавало бы домен на порт, где никто не слушает, на машине продуктов.
    expect(host.ran('docker').map((c) => c[1])).toEqual(['inspect', 'start']);
    expect(host.isRunning('vtoroy')).toBe(true);
    expect(host.vhostMode('vtoroy')).toBe('live');
    expect(host.liveVhosts.get('vtoroy')).toBe(8002);
  });

  it('восстановленный порт уезжает наружу — иначе реестр не вылечится', async () => {
    // Сервер лечит строку продукта отчётом: `completeJob` делает
    // `UPDATE products SET port = COALESCE($2, port)`. Молча поднятый продукт с
    // NULL в реестре проснулся бы ровно один раз — до следующего гашения.
    await seed('pervy');
    await asleep('vtoroy');

    await expect(
      wakeProduct({ slug: 'vtoroy', kind: 'site', port: null }, deps(host)),
    ).resolves.toEqual({ port: 8002 });
  });

  it('восстановление порта видно в журнале хоста', async () => {
    // Продукты с NULL в реестре месяц не поднимались, и по журналу машины
    // продуктов должно быть видно, что именно вылечило такой продукт: иначе
    // разбор следующего похожего случая начнётся с нуля.
    const phases: string[] = [];
    await seed('pervy');
    await asleep('vtoroy');

    await wakeProduct(
      { slug: 'vtoroy', kind: 'site', port: null },
      deps(host, { onPhase: (m) => phases.push(m) }),
    );

    expect(phases.join('\n')).toMatch(/vtoroy.*8002|8002.*vtoroy/);
  });

  it('сайт С портом: у контейнера ничего не спрашивают, порт наружу не едет', async () => {
    // Порт задания — истина реестра, и лишний `docker inspect` на каждом
    // пробуждении не нужен. А порт в отчёте — это НОВОСТЬ для сервера; там,
    // где новостей нет, `{ ok: true, port: … }` читается в журнале как
    // «порт откуда-то взялся».
    const port = await asleep('shop');

    await expect(
      wakeProduct({ slug: 'shop', kind: 'site', port }, deps(host)),
    ).resolves.toEqual({});

    expect(host.ran('docker').map((c) => c[1])).toEqual(['start']);
  });

  it('контейнер не назвал порта — прежний отказ, и docker start НЕ звался', async () => {
    // Выдумать порт нельзя. Контейнер всё равно поднимется на СВОЁМ старом, а
    // домен уехал бы на порт, где никто не слушает: громкий отказ превратился
    // бы в тихий, который видно только по молчащему сайту.
    await asleep('shop');

    await expect(
      wakeProduct(
        { slug: 'shop', kind: 'site', port: null },
        deps(host, {
          // Команда уходит на хост как обычно (и попадает в host.calls),
          // подменяется только ВЫДАЧА: так проверяется и то, что старта не
          // было, а не только то, что отказ случился.
          run: async (argv, opts) => {
            const out = await host.run(argv, opts);
            return argv[1] === 'inspect' ? 'не-порт\n' : out;
          },
        }),
      ),
    ).rejects.toThrow(/нет порта/);

    expect(host.isRunning('shop')).toBe(false);
    expect(host.ran('docker').map((c) => c[1])).toEqual(['inspect']);
  });

  it('контейнера нет вовсе — отказ про порт, а не «No such container» от старта', async () => {
    // `docker inspect` тут БРОСАЕТ, и это не повод поднимать контейнер вслепую:
    // дождаться его всё равно будет нечем.
    await expect(
      wakeProduct({ slug: 'net-takogo', kind: 'site', port: null }, deps(host)),
    ).rejects.toThrow(/нет порта/);

    expect(host.ran('docker').map((c) => c[1])).toEqual(['inspect']);
  });

  it('бот просыпается без порта, домена и ожидания — и без вопросов контейнеру', async () => {
    // У бота публикации порта нет вовсе, спрашивать нечего: `docker inspect`
    // отдал бы пустую строку, а восстановление превратилось бы в отказ там,
    // где отказывать не за что.
    await asleep('bot', 'bot');
    const waitPort = jest.fn(async () => true);

    await wakeProduct({ slug: 'bot', kind: 'bot' }, deps(host, { waitPort }));

    expect(host.isRunning('bot')).toBe(true);
    expect(waitPort).not.toHaveBeenCalled();
    expect(host.ran('product-vhost')).toHaveLength(0);
    expect(host.ran('docker').map((c) => c[1])).toEqual(['start']);
  });

  it('слаг проверяется и здесь, до единой команды', async () => {
    await expect(
      wakeProduct({ slug: '../etc', kind: 'site', port: 8001 }, deps(host)),
    ).rejects.toThrow(/слаг/);

    expect(host.calls).toHaveLength(0);
  });

  it('порт, занятый чужим продуктом за время сна, — честный отказ', async () => {
    // ИЗМЕРЕННЫЙ СТЫК, А НЕ ВЫДУМКА. `hostDeps.freePort` спрашивает
    // `docker ps` БЕЗ `-a`, то есть порт остановленного контейнера считает
    // свободным и отдаёт новому продукту. Пробуждение после этого упирается в
    // «port is already allocated».
    //
    // Отказ обязан БЫТЬ и обязан доехать: сервер оставит продукт спящим и
    // напишет причину в карточку. Тихий успех дал бы «разбудили» при
    // погашенном контейнере — и ходы уезжали бы в никого.
    const port = await asleep('spyashchiy');
    // Пока он спал, завели соседа — и тот получил его порт.
    await seed('novyy');
    expect(host.containers.get('novyy')!.publish).toBe('127.0.0.1:8001:3000');

    await expect(
      wakeProduct({ slug: 'spyashchiy', kind: 'site', port }, deps(host)),
    ).rejects.toThrow(/port is already allocated/);

    expect(host.isRunning('spyashchiy')).toBe(false);
    expect(host.vhostMode('spyashchiy')).toBe('asleep');
  });

  it('сон и пробуждение возвращают хост ровно туда, откуда взяли', async () => {
    // Сквозная проверка обратимости: имя, порт, монтирование, переменные
    // окружения и режим домена обязаны совпасть с исходными. Любой шаг,
    // пересоздающий контейнер, здесь разойдётся.
    const port = await seed('krug');
    const before = { ...host.containers.get('krug')!, env: { ...host.containers.get('krug')!.env } };

    await sleepProduct({ slug: 'krug', kind: 'site' }, deps(host));
    await wakeProduct({ slug: 'krug', kind: 'site', port }, deps(host));

    const after = host.containers.get('krug')!;
    expect(after.publish).toBe(before.publish);
    expect(after.mount).toBe(before.mount);
    expect(after.env).toEqual(before.env);
    expect(after.image).toBe(before.image);
    expect(host.vhostMode('krug')).toBe('live');
    expect(host.isRunning('krug')).toBe(true);
  });

  it('повторное задание сна не ломается о уже погашенный контейнер', async () => {
    // Ретрай отчёта и повторная выдача задания — законные пути (см. deliver).
    // Отказ здесь означал бы «сон не удался» у продукта, который уже спит:
    // сервер вернул бы его в degraded и стал бы усыплять по кругу.
    await seed('dvazhdy');

    await sleepProduct({ slug: 'dvazhdy', kind: 'site' }, deps(host));
    await expect(
      sleepProduct({ slug: 'dvazhdy', kind: 'site' }, deps(host)),
    ).resolves.toBeUndefined();

    expect(host.isRunning('dvazhdy')).toBe(false);
  });
});
