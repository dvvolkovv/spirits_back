import 'reflect-metadata';
import { BadRequestException, ConflictException, UnprocessableEntityException } from '@nestjs/common';
import * as crypto from 'crypto';
import { LimitsService } from './limits.service';
import { ProvisioningService } from './provisioning.service';
import { SecretsService } from './secrets.service';
import { ProductsModule } from './products.module';
import { ConfigService } from '@nestjs/config';
import { PgService } from '../common/services/pg.service';
import { DomainsService } from './domains.service';
import { ProductsController } from './products.controller';
import { FREE_MONTH_PRODUCTS } from './rent.service';

/**
 * Реестр машин. Отдаёт РАЗНЫЕ машины разным аудиториям и разные значения в
 * каждом поле: заглушка с одной машиной на всех зеленела бы и на реализации,
 * которая признак администратора не передаёт вовсе.
 *
 * Адрес, зона и метка не выводятся друг из друга — перепутанные местами поля
 * иначе неотличимы, а стоят они дорого: домен одной машины с адресом другой.
 */
const HOSTS: Record<string, any> = {
  own: { id: 'own', publicIp: '139.59.210.42', domainSuffix: 'p.linkeon.io' },
  clients: { id: 'clients', publicIp: '10.1.2.3', domainSuffix: 'c.linkeon.io' },
};

function makeService(over: any = {}) {
  const calls: { sql: string; params: any[] }[] = [];
  const hosts = {
    pickForNewProduct: jest.fn(async (isAdmin: boolean) => {
      if (over.noRoom) throw new UnprocessableEntityException('мест нет');
      return HOSTS[isAdmin === true ? 'own' : 'clients'];
    }),
  };
  const pg = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      // `startsWith`, а не `includes`: с бесплатным месяцем (26.10.2026,
      // позже уточнённым в ревью пунктом 11) сам INSERT INTO products несёт
      // внутри CASE подзапрос `(SELECT count(*) FROM products p2 WHERE …)` —
      // `includes` перехватывал бы и его, подменяя ответ INSERT ответом
      // проверки слага.
      if (sql.startsWith('SELECT count(*)')) return { rows: [{ count: over.slugTaken ? '1' : '0' }] };
      if (sql.includes('SELECT 1 FROM products WHERE tg_bot_id')) {
        return { rows: over.botBusy ? [{ x: 1 }] : [] };
      }
      if (sql.includes('INSERT INTO product_provision_jobs') && over.jobInsertFails) {
        throw Object.assign(new Error('деталь для лога'), { code: '23505' });
      }
      if (sql.includes('INSERT INTO products') && over.productInsertRace) {
        // Имя ограничения снято с живой базы, а не выдумано: products_slug_key.
        throw Object.assign(new Error('duplicate key value violates unique constraint'), {
          code: '23505',
          constraint: 'products_slug_key',
        });
      }
      if (sql.includes('INSERT INTO products') && over.productInsertError) {
        throw Object.assign(new Error('boom'), over.productInsertError);
      }
      if (sql.includes('INSERT INTO products')) {
        return { rows: [{ id: 'p-1', free_month: over.freeMonth ?? true }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    }),
  };
  const secrets = { encrypt: jest.fn(() => Buffer.from('шифр')) };
  // Предел аккаунта. Своим сервисом, а не веткой в заглушке pg: запрос предела
  // и запрос занятости слага оба начинаются с `SELECT count(*)`, и одна ветка
  // на двоих отвечала бы за оба — то есть «слаг занят» и «мест на аккаунте
  // нет» стали бы одним и тем же состоянием заглушки.
  const limits = {
    assertCanCreate: jest.fn(async () => {
      if (over.overLimit) throw new UnprocessableEntityException('предел аккаунта');
    }),
  };
  const svc = new ProvisioningService(pg as any, secrets as any, hosts as any, limits as any);
  // I2: без этой заглушки каждый тест ниже с kind:'bot' и секретом BOT_TOKEN
  // бил бы по настоящему Telegram (новая проверка в create()) — токены во
  // всех этих тестах фиктивные и заведомо не прошли бы getMe. По умолчанию —
  // «токен живой», чтобы форма и остальное поведение create() проверялись
  // как раньше, независимо от содержимого BOT_TOKEN. `over.botCheck`
  // подменяет результат целиком — для тестов самой этой проверки.
  const checkBot = jest.fn(async () => over.botCheck ?? { ok: true, id: 9000000001, username: 'studio_bot' });
  (svc as any).checkBot = checkBot;
  return {
    svc,
    calls,
    secrets,
    hosts,
    limits,
    checkBot,
  };
}

const sqlOf = (c: { sql: string }[]) => c.map((x) => x.sql).join('\n');

describe('ProvisioningService.create', () => {
  it('заводит продукт в статусе provisioning и ставит задание', async () => {
    const { svc, calls } = makeService();

    await svc.create({ userId: 'u-1', isAdmin: false, name: 'Сайт', slug: 'site1', kind: 'site', secrets: {} });

    expect(sqlOf(calls)).toContain('INSERT INTO products');
    expect(sqlOf(calls)).toContain('INSERT INTO product_provision_jobs');
    const insert = calls.find((c) => c.sql.includes('INSERT INTO products'))!;
    expect(insert.params).toContain('provisioning');
  });

  it('занятый слаг отвергается до всякой записи', async () => {
    // Без этой проверки вторая запись падала бы на UNIQUE, но уже после
    // выпуска токена — и в базе оставался бы висячий продукт.
    const { svc, calls } = makeService({ slugTaken: true });

    await expect(
      svc.create({ userId: 'u-1', isAdmin: false, name: 'X', slug: 'site1', kind: 'site', secrets: {} }),
    ).rejects.toThrow(/слаг/i);

    expect(sqlOf(calls)).not.toContain('INSERT INTO products');
  });

  it('в базу уходит хеш, а живой токен наружу не выпускается вовсе', async () => {
    // Тест плана требовал вернуть открытый токен. Возвращать его некуда:
    // агенту токен отдаётся один раз в теле задания, и выпускает его заново
    // claimJob (задача 4) на каждую выдачу. Выпущенный здесь токен
    // RunnerGuard принял бы, вызывающий получил бы его в ответе и в лог — и
    // через минуту токен обесценился бы. Живой креденшл, который никому не
    // нужно показывать, не должен существовать.
    const { svc, calls } = makeService();

    const res = await svc.create({ userId: 'u-1', isAdmin: false, name: 'X', slug: 's', kind: 'site', secrets: {} });

    expect(res).toEqual({ productId: expect.any(String), freeMonth: expect.any(Boolean) });
    const insert = calls.find((c) => c.sql.includes('INSERT INTO products'))!;
    expect(insert.params[7]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('секреты шифруются, а не кладутся как есть', async () => {
    const { svc, calls, secrets } = makeService();

    await svc.create({ userId: 'u-1', isAdmin: false, name: 'Бот', slug: 'b', kind: 'bot', secrets: { BOT_TOKEN: 'т' } });

    expect(secrets.encrypt).toHaveBeenCalledWith({ BOT_TOKEN: 'т' }, expect.any(String));
    const insert = calls.find((c) => c.sql.includes('INSERT INTO products'))!;
    expect(insert.params).not.toContain('т');
  });

  it('форма продукта проверяется', async () => {
    const { svc } = makeService();

    await expect(
      svc.create({ userId: 'u-1', isAdmin: false, name: 'X', slug: 's', kind: 'вирус' as any, secrets: {} }),
    ).rejects.toThrow(/форма/i);
  });

  it('секреты шифруются ПОД ТЕМ ЖЕ id, что уходит в INSERT', async () => {
    // Иначе коробка не расшифруется никогда: AAD не совпадёт. Отказ был бы
    // отложенным — заведение прошло бы, а упало бы позже, при сборке задания.
    //
    // Сверка идёт с КОНКРЕТНЫМ id, а не через params.toContain(usedId), как
    // было в первой редакции. toContain — принадлежность, а не позиция:
    // слаг 'b' и userId 'u-1' тоже лежат в params, поэтому AAD от слага или
    // от userId проходил зелёным. Измерено, мутации M1 и M2.
    const { svc, calls, secrets } = makeService();

    const res = await svc.create({
      userId: 'u-1',
      isAdmin: false,
      name: 'Бот',
      slug: 'b',
      kind: 'bot',
      secrets: { BOT_TOKEN: 'т' },
    });

    const usedId = (secrets.encrypt as jest.Mock).mock.calls[0][1];
    expect(usedId).toBe(res.productId);
    const insert = calls.find((c) => c.sql.includes('INSERT INTO products'))!;
    expect(insert.params[0]).toBe(usedId);
  });

  // --- проверки сверх плана ---------------------------------------------
  // Каждая закрывает мутацию, которую все шесть проверок выше переживали
  // зелёными. Измерено, а не предположено.

  it('коробка шифровальщика доезжает до INSERT, а сырой объект секретов — нет', async () => {
    // Проверка «секреты шифруются» ЛОЖНО ЗЕЛЁНАЯ на главной мутации: если
    // положить в params `input.secrets` вместо `box`, encrypt всё равно
    // вызывается (первое утверждение проходит), а `not.toContain('т')`
    // сравнивает строку с объектом {BOT_TOKEN:'т'} и тоже проходит. То есть
    // секреты уехали бы в базу открытым текстом при зелёном тесте.
    const { svc, calls, secrets } = makeService();

    await svc.create({ userId: 'u-1', isAdmin: false, name: 'Бот', slug: 'bot1', kind: 'bot', secrets: { BOT_TOKEN: 'т' } });

    const box = (secrets.encrypt as jest.Mock).mock.results[0].value;
    const insert = calls.find((c) => c.sql.includes('INSERT INTO products'))!;
    expect(insert.params).toContain(box);
    expect(insert.params).not.toContainEqual({ BOT_TOKEN: 'т' });
  });

  it('продукт без секретов пишет NULL, а не пустую коробку', async () => {
    // NULL — признак «секретов нет», по которому задача 4 решает, звать ли
    // decrypt. Коробка от {} читалась бы как «секреты есть», и в контейнер
    // уехал бы пустой набор переменных вместо честного «их не задавали».
    const { svc, calls, secrets } = makeService();

    await svc.create({ userId: 'u-1', isAdmin: false, name: 'Сайт', slug: 'site2', kind: 'site', secrets: {} });

    expect(secrets.encrypt).not.toHaveBeenCalled();
    const insert = calls.find((c) => c.sql.includes('INSERT INTO products'))!;
    expect(insert.params).toContain(null);
  });

  it('форма INSERT закреплена: колонки, плейсхолдеры и порядок значений', async () => {
    // Перестановка двух текстовых колонок (name/slug, slug/kind) не меняет ни
    // одного утверждения выше: типы одинаковые, длины произвольные. Продукт
    // завёлся бы под именем вместо слага — то есть с чужим доменом и чужим
    // каталогом, без единой ошибки. Колонки и плейсхолдеры сторожатся
    // раздельно: переставить можно любое из двух, а params при этом не
    // меняется.
    const { svc, calls } = makeService();

    const res = await svc.create({
      userId: 'u-1',
      isAdmin: false,
      name: 'Сайт',
      slug: 'site1',
      kind: 'site',
      secrets: {},
    });

    const insert = calls.find((c) => c.sql.includes('INSERT INTO products'))!;
    expect(insert.sql).toContain(
      '(id, user_id, name, slug, kind, status, checkout_path, runner_token_hash,\n' +
        '                               secrets_encrypted, domain, host_ip, health_url, host_id, tg_bot_id, paid_until)',
    );
    // paid_until, пятнадцатой колонкой: CASE внутри самого INSERT (решение
    // владельца 26.10.2026, см. комментарий в create()) — первым
    // FREE_MONTH_PRODUCTS продуктам человека за всю историю месяц, остальным
    // now(). $2 — тот же userId, что и второй колонкой выше; второй раз он
    // назван здесь не для красоты: это и есть «кому принадлежит счёт».
    //
    // Ревью, пункт 11: считаются не ВСЕ строки этого userId, а только те, у
    // которых есть след успешного провижининга (EXISTS по
    // product_provision_jobs kind='provision' status='done') — продукт, чьё
    // заведение так и не поднялось, бесплатный месяц не жжёт.
    expect(insert.sql).toContain(
      'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,\n' +
        "                 CASE WHEN (SELECT count(*) FROM products p2 WHERE p2.user_id = $2\n" +
        "                              AND EXISTS (SELECT 1 FROM product_provision_jobs j\n" +
        "                                           WHERE j.product_id = p2.id AND j.kind = 'provision' AND j.status = 'done')) < $15\n" +
        "                        THEN now() + interval '1 month'\n" +
        '                        ELSE now()\n' +
        '                      END)',
    );
    expect(insert.params).toEqual([
      res.productId,
      'u-1',
      'Сайт',
      'site1',
      'site',
      'provisioning',
      // Путь внутри контейнера продукта: раннер спавнит claude -p именно там.
      // Хостовый путь (наследие прежней схемы) увёл бы агента в чужой каталог.
      '/product',
      expect.stringMatching(/^[0-9a-f]{64}$/),
      null,
      // Три колонки ручной product-provision.sh заполнял, а автозаведение не
      // заполняло — поймано живой проверкой. Пустой domain прячет от владельца
      // ссылку на его же работающий сайт, а пустой health_url ВЫКЛЮЧАЕТ
      // автооткат: waitHealthy(null) возвращает истину. Поведение сторожит
      // сценарий 18в интеграционного сьюта; здесь закреплена форма запроса —
      // порядок значений ниоткуда больше не виден.
      //
      // Домен и адрес — у ВЫБРАННОЙ машины: заведение от имени обычного
      // пользователя уезжает на clients, то есть в зону c.linkeon.io и на
      // 10.1.2.3. Константы, стоявшие здесь до куска 4а, дали бы
      // 'site1.p.linkeon.io' и '139.59.210.42' независимо от машины.
      'site1.c.linkeon.io',
      '10.1.2.3',
      'http://127.0.0.1:3000/health',
      // МЕТКА МАШИНЫ, тринадцатой колонкой. Без неё продукт не виден выдаче
      // заданий вовсе (`p.host_id = NULL` не равно ничему): задание висит в
      // очереди, через десять минут его хоронит сборщик зависших, и владелец
      // читает про истёкший срок.
      'clients',
      // tg_bot_id, четырнадцатой колонкой. Студия сайт/бота без токена
      // заводит и это поле не передаёт вовсе — null, а не колонка по
      // умолчанию в DDL: заведение задаёт его явно, как и прочие поля.
      null,
      // FREE_MONTH_PRODUCTS, пятнадцатым параметром — порог CASE выше.
      FREE_MONTH_PRODUCTS,
    ]);
  });

  // --- выбор машины (кусок 4а, задача 4) --------------------------------

  it('продукт админа уезжает на свою машину, продукт клиента — на клиентскую', async () => {
    // ГЛАВНОЕ ПОВЕДЕНИЕ ЗАДАЧИ, и видно его в трёх колонках сразу: метка,
    // домен и адрес обязаны приехать от ОДНОЙ машины.
    const admin = makeService();
    const client = makeService();

    await admin.svc.create({ userId: 'u-1', isAdmin: true, name: 'X', slug: 's1', kind: 'site', secrets: {} });
    await client.svc.create({ userId: 'u-2', isAdmin: false, name: 'X', slug: 's2', kind: 'site', secrets: {} });

    const params = (c: typeof admin) =>
      c.calls.find((x) => x.sql.includes('INSERT INTO products'))!.params;
    expect(params(admin).slice(9)).toEqual([
      's1.p.linkeon.io',
      '139.59.210.42',
      'http://127.0.0.1:3000/health',
      'own',
      null,
      FREE_MONTH_PRODUCTS,
    ]);
    expect(params(client).slice(9)).toEqual([
      's2.c.linkeon.io',
      '10.1.2.3',
      'http://127.0.0.1:3000/health',
      'clients',
      null,
      FREE_MONTH_PRODUCTS,
    ]);
  });

  it('признак администратора доезжает до выбора машины как есть', async () => {
    // Реализация, зовущая pickForNewProduct() без аргумента, получила бы
    // undefined — то есть clients — и прошла бы предыдущий тест наполовину
    // зелёной (клиентская половина сошлась бы).
    const { svc, hosts } = makeService();

    await svc.create({ userId: 'u-1', isAdmin: true, name: 'X', slug: 's', kind: 'site', secrets: {} });

    expect(hosts.pickForNewProduct).toHaveBeenCalledTimes(1);
    expect(hosts.pickForNewProduct).toHaveBeenCalledWith(true);
  });

  it('машина выбирается ДО проверки слага: «мест нет» чинится не переименованием', async () => {
    // Порядок осознанный. Скажи мы сначала про занятый слаг — человек
    // переименует продукт, нажмёт снова и только тогда узнает, что заводить
    // его некуда. Обратный порядок ничего не стоит: обе проверки идут до
    // выпуска токена и любой записи.
    const { svc, calls } = makeService({ noRoom: true, slugTaken: true });

    // Слаг ЗАКОННЫЙ по форме: кириллица отбилась бы ещё раньше, проверкой
    // формы, и тест проверял бы не тот порядок.
    await expect(
      svc.create({ userId: 'u-1', isAdmin: false, name: 'X', slug: 'taken', kind: 'site', secrets: {} }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);

    expect(calls).toEqual([]);
  });

  it('предел аккаунта спрашивается ДО машины и ДО слага, и признак админа едет как есть', async () => {
    // Порядок: «у вас уже два продукта» не чинится ни переименованием, ни
    // ожиданием, поэтому звучит первым. Стой он после выбора машины — на
    // забитой машине владелец двух продуктов услышал бы про нехватку мест и
    // стал бы ждать (поведение сторожит сценарий 90 на живой базе).
    //
    // Признак администратора передаётся ТУДА ЖЕ, откуда его берёт выбор
    // машины: два понятия «свой пользователь» означали бы предел, считаемый по
    // одному правилу, и машину, выбранную по другому.
    const { svc, calls, hosts, limits } = makeService({ overLimit: true, noRoom: true, slugTaken: true });

    await expect(
      svc.create({ userId: 'u-7', isAdmin: false, name: 'X', slug: 'taken', kind: 'site', secrets: {} }),
    ).rejects.toThrow(/предел/i);

    expect(limits.assertCanCreate).toHaveBeenCalledWith('u-7', false);
    expect(hosts.pickForNewProduct).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('предел аккаунта спрашивают на КАЖДОМ заведении, и признак админа доезжает истинным', async () => {
    // Заглушка, зовущая предел один раз на сервис (мемоизация «этому уже
    // можно»), прошла бы тест выше зелёной. И обратная сторона: `isAdmin`
    // обязан доехать НЕ приведённым к ложному — иначе админ отбивался бы
    // пределом, которого для него нет.
    const { svc, limits } = makeService();

    await svc.create({ userId: 'u-a', isAdmin: true, name: 'X', slug: 's1', kind: 'site', secrets: {} });
    await svc.create({ userId: 'u-a', isAdmin: true, name: 'X', slug: 's2', kind: 'site', secrets: {} });

    expect(limits.assertCanCreate).toHaveBeenCalledTimes(2);
    expect(limits.assertCanCreate).toHaveBeenLastCalledWith('u-a', true);
  });

  it('кривая форма продукта до предела аккаунта не доходит', async () => {
    // Разбор формы в базу не ходит вовсе, а слаг проверяет ещё и труба
    // валидации: запрашивать предел ради заведомо невалидного тела незачем.
    const { svc, limits } = makeService();

    await expect(
      svc.create({ userId: 'u-1', isAdmin: false, name: 'X', slug: 'Мой Сайт!', kind: 'site', secrets: {} }),
    ).rejects.toThrow(/дефис/i);

    expect(limits.assertCanCreate).not.toHaveBeenCalled();
  });

  it('отказ выбора машины не оставляет ни продукта, ни задания', async () => {
    // Отказ ДО всякой записи. Продукт, записанный «на всякий случай» без
    // метки, занял бы слаг и не достался бы ни одному агенту.
    const { svc, calls } = makeService({ noRoom: true });

    await expect(
      svc.create({ userId: 'u-1', isAdmin: false, name: 'X', slug: 's', kind: 'site', secrets: {} }),
    ).rejects.toThrow(/мест/i);

    expect(sqlOf(calls)).not.toContain('INSERT INTO');
  });

  it('форма продукта проверяется ДО похода в реестр', async () => {
    // Кривой слаг не должен стоить запроса к базе — и не должен занимать место
    // в рассуждении о том, почему отказали.
    const { svc, hosts } = makeService();

    await expect(
      svc.create({ userId: 'u-1', isAdmin: false, name: 'X', slug: 'Мой Сайт!', kind: 'site', secrets: {} }),
    ).rejects.toThrow(/дефис/i);

    expect(hosts.pickForNewProduct).not.toHaveBeenCalled();
  });

  it('у бота домена нет, а адрес проверки здоровья есть', async () => {
    // Бот не принимает входящих соединений: домен ему не нужен по форме, а не
    // по недосмотру. Здоровье при этом проверяется так же, как у сайта, —
    // иначе автооткат у ботов молча выключен.
    const { svc, calls } = makeService();

    await svc.create({ userId: 'u-1', isAdmin: false, name: 'Бот', slug: 'bot1', kind: 'bot', secrets: {} });

    const insert = calls.find((c) => c.sql.includes('INSERT INTO products'))!;
    expect(insert.params[9]).toBeNull();
    expect(insert.params[11]).toBe('http://127.0.0.1:3000/health');
    // Метка машины боту нужна ровно так же, как сайту: по ней выдача заданий
    // решает, чей агент поднимет его контейнер. Домена нет — машина есть.
    expect(insert.params[12]).toBe('clients');
    expect(insert.params[10]).toBe('10.1.2.3');
  });

  it('хеш не выводится из значений, которые вызывающий и так знает', async () => {
    // RunnerGuard ищет продукт по sha256 ПРЕДЪЯВЛЕННОГО токена. Если в
    // runner_token_hash лежит sha256 от productId (или от слага, имени,
    // userId), то это значение и есть рабочий токен: кто знает id продукта —
    // тот проходит охрану раннера. Проверка длины «64 hex» такую подмену не
    // видит вовсе.
    const { svc, calls } = makeService();

    const res = await svc.create({ userId: 'u-1', isAdmin: false, name: 'X', slug: 'site1', kind: 'site', secrets: {} });

    const insert = calls.find((c) => c.sql.includes('INSERT INTO products'))!;
    const sha = (v: string) => crypto.createHash('sha256').update(v).digest('hex');
    for (const known of [res.productId, 'site1', 'u-1', 'X', '/product', 'site']) {
      expect(insert.params[7]).not.toBe(sha(known));
    }
  });

  it('хеш считается от 32 случайных байт и ни от чего другого', async () => {
    // Перечисление известных значений закрывает только голое sha256 РОВНО от
    // них. Измерено: sha256(productId + slug) и sha256('linkeon:' + productId)
    // список переживают — а это ровно то, от чего проверка выше названа
    // защищать: кто знает id продукта, тот проходит RunnerGuard. Переживает
    // список и уменьшение энтропии до одного байта.
    //
    // Поэтому привязка идёт к самому источнику случайности, а не к перебору
    // того, чем он НЕ является.
    const spy = jest.spyOn(crypto, 'randomBytes');
    try {
      const { svc, calls } = makeService();

      await svc.create({ userId: 'u-1', isAdmin: false, name: 'X', slug: 'site1', kind: 'site', secrets: {} });

      const insert = calls.find((c) => c.sql.includes('INSERT INTO products'))!;
      const drawn = spy.mock.results.map((r) => r.value as Buffer).filter(Buffer.isBuffer);
      // Ровно один розыгрыш: второй означал бы, что в хеш попало не то, что
      // разыграно (или что часть случайности выброшена).
      expect(drawn).toHaveLength(1);
      expect(drawn[0]).toHaveLength(32);
      expect(insert.params[7]).toBe(crypto.createHash('sha256').update(drawn[0]).digest('hex'));
    } finally {
      // claimJob тоже зовёт randomBytes; шпиона нельзя оставлять на модуле.
      spy.mockRestore();
    }
  });

  it('хеш у каждого продукта свой', async () => {
    // Константа вместо randomBytes проходит и «не выводится из известного», и
    // проверку длины. А колонка UNIQUE: второе заведение падало бы на
    // products_runner_token_hash_key — то есть заводился бы ровно один
    // продукт на всю установку.
    const a = makeService();
    const b = makeService();

    const one = await a.svc.create({ userId: 'u-1', isAdmin: false, name: 'X', slug: 'site1', kind: 'site', secrets: {} });
    const two = await b.svc.create({ userId: 'u-1', isAdmin: false, name: 'X', slug: 'site2', kind: 'site', secrets: {} });

    const hashOf = (c: { sql: string; params: any[] }[]) =>
      c.find((x) => x.sql.includes('INSERT INTO products'))!.params[7];
    expect(hashOf(a.calls)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashOf(b.calls)).not.toBe(hashOf(a.calls));
    expect(two.productId).not.toBe(one.productId);
  });

  it('возвращается id, который реально записан, а не то, что ответила база', async () => {
    // Мок отдаёт на INSERT строку {id:'p-1'}. Реализация, читающая id из
    // ответа, вернула бы вызывающему один id, а секреты зашифровала бы под
    // другим — и коробка не расшифровалась бы никогда.
    const { svc, calls } = makeService();

    const res = await svc.create({ userId: 'u-1', isAdmin: false, name: 'X', slug: 'site1', kind: 'site', secrets: {} });

    const insert = calls.find((c) => c.sql.includes('INSERT INTO products'))!;
    expect(insert.params).toContain(res.productId);
    expect(res.productId).not.toBe('p-1');
  });

  // --- бесплатный месяц (решение владельца 26.10.2026) ------------------

  it('freeMonth в ответе — ровно то, что вернул free_month из RETURNING', async () => {
    // `=== true` в реализации: подложенное отсюда — не boolean, а строка или
    // отсутствующая строка, — обязано читаться как «не бесплатно», а не как
    // истина через приведение типа.
    const trueCase = makeService({ freeMonth: true });
    const falseCase = makeService({ freeMonth: false });

    const resTrue = await trueCase.svc.create({ userId: 'u-1', isAdmin: false, name: 'X', slug: 's1', kind: 'site', secrets: {} });
    const resFalse = await falseCase.svc.create({ userId: 'u-1', isAdmin: false, name: 'X', slug: 's2', kind: 'site', secrets: {} });

    expect(resTrue.freeMonth).toBe(true);
    expect(resFalse.freeMonth).toBe(false);
  });

  it('пустая или сломанная выдача RETURNING читается как «не бесплатно», а не как истина', async () => {
    const pg = {
      query: jest.fn(async (sql: string, params: any[] = []) => {
        // `startsWith`, а не `includes` (ревью, пункт 8): с задачи 11 сам
        // INSERT несёт внутри CASE подзапрос `(SELECT count(*) FROM products
        // p2 WHERE … EXISTS …)` — `includes` перехватывал бы и его, подменяя
        // ответ INSERT ответом проверки слага, и ветка «пустая выдача» ниже
        // для INSERT никогда не исполнялась бы на самом деле.
        if (sql.startsWith('SELECT count(*)')) return { rows: [{ count: '0' }] };
        if (sql.includes('INSERT INTO products')) return { rows: [], rowCount: 1 }; // пустая выдача
        return { rows: [], rowCount: 1 };
      }),
    };
    const hosts = { pickForNewProduct: jest.fn(async () => ({ id: 'clients', publicIp: '10.1.2.3', domainSuffix: 'c.linkeon.io' })) };
    const limits = { assertCanCreate: jest.fn(async () => undefined) };
    const secrets = { encrypt: jest.fn(() => Buffer.from('шифр')) };
    const broken = new ProvisioningService(pg as any, secrets as any, hosts as any, limits as any);

    const res = await broken.create({ userId: 'u-1', isAdmin: false, name: 'X', slug: 'site3', kind: 'site', secrets: {} });

    expect(res.freeMonth).toBe(false);
  });

  it('CASE считает продуктов этого userId внутри самого INSERT, порогом — FREE_MONTH_PRODUCTS', async () => {
    const { svc, calls } = makeService();

    await svc.create({ userId: 'u-7', isAdmin: false, name: 'X', slug: 'site4', kind: 'site', secrets: {} });

    const insert = calls.find((c) => c.sql.includes('INSERT INTO products'))!;
    expect(insert.sql).toContain('(SELECT count(*) FROM products p2 WHERE p2.user_id = $2');
    // Ревью, пункт 11: считаются не ВСЕ строки, а только со следом успешного
    // провижининга — EXISTS по product_provision_jobs.
    expect(insert.sql).toContain("kind = 'provision' AND j.status = 'done'");
    expect(insert.params[1]).toBe('u-7');
    expect(insert.params[14]).toBe(FREE_MONTH_PRODUCTS);
  });

  it('задание ставится ПОСЛЕ продукта и ровно на него', async () => {
    // product_id в заданиях — внешний ключ на products. Задание, поставленное
    // раньше продукта или на другой id, упало бы на FK уже на проде, а на
    // моке проходит молча.
    const { svc, calls } = makeService();

    const res = await svc.create({ userId: 'u-1', isAdmin: false, name: 'X', slug: 'site1', kind: 'site', secrets: {} });

    const iProduct = calls.findIndex((c) => c.sql.includes('INSERT INTO products'));
    const iJob = calls.findIndex((c) => c.sql.includes('INSERT INTO product_provision_jobs'));
    expect(iProduct).toBeGreaterThanOrEqual(0);
    expect(iJob).toBeGreaterThan(iProduct);
    expect(calls[iJob].params).toEqual([res.productId]);
    expect(calls[iJob].sql).toContain("'queued'");
  });

  it('занятость слага проверяется по всем продуктам, включая архивные', async () => {
    // UNIQUE на products.slug архивные строки не исключает. Проверка с
    // `archived_at IS NULL` рапортовала бы «свободен», а INSERT падал бы на
    // UNIQUE — то есть ровно тот отказ после выпуска токена, который эта
    // проверка и должна предотвращать.
    const { svc, calls } = makeService();

    await svc.create({ userId: 'u-1', isAdmin: false, name: 'X', slug: 'site1', kind: 'site', secrets: {} });

    const check = calls.find((c) => c.sql.includes('SELECT count(*)'))!;
    expect(check.sql).toContain('FROM products');
    expect(check.sql).toContain('slug = $1');
    expect(check.sql).not.toContain('archived_at');
    expect(check.params).toEqual(['site1']);
  });

  it('слаг не по форме отвергается, и база при этом не опрашивается', async () => {
    // Слаг становится именем контейнера, каталогом на хосте и меткой домена.
    // Без проверки «Мой Сайт!» уехал бы в docker run и nginx как есть.
    const { svc, calls } = makeService();

    await expect(
      svc.create({ userId: 'u-1', isAdmin: false, name: 'X', slug: 'Мой Сайт!', kind: 'site', secrets: {} }),
    ).rejects.toThrow(/дефис/i);

    expect(calls).toEqual([]);
  });

  it('слаг вне алфавита и с дефисом по краям отвергается', async () => {
    // `-rf` первым аргументом docker/nginx разбирается как флаг, а метка
    // домена с дефисом по краям невалидна. Регексп из плана
    // /^[a-z0-9-]{2,40}$/ такое пропускает.
    //
    // Алфавит проверяется отдельно, потому что комментарий и текст ошибки
    // обещают «строчные латинские, цифры и дефис», а измерение показало: без
    // этих трёх случаев мутация, разрешающая `_`, `.` и заглавные, зелёная.
    // Опаснее всех точка: `a.b` дало бы `a.b.p.linkeon.io`, а сертификат
    // `*.p.linkeon.io` вторую метку не покрывает — TLS отвалился бы уже
    // ПОСЛЕ развёртывания, то есть на успешно заведённом продукте.
    const { svc } = makeService();

    for (const slug of ['-site', 'site-', '--', 'my_site', 'a.b', 'Site1']) {
      await expect(
        svc.create({ userId: 'u-1', isAdmin: false, name: 'X', slug, kind: 'site', secrets: {} }),
      ).rejects.toThrow(/дефис/i);
    }
  });

  it('слаг длиннее сорока символов отвергается', async () => {
    const { svc } = makeService();

    await expect(
      svc.create({ userId: 'u-1', isAdmin: false, name: 'X', slug: 'a'.repeat(41), kind: 'site', secrets: {} }),
    ).rejects.toThrow(/дефис/i);
  });

  it('обе законные формы продукта проходят', async () => {
    // Проверка kind, сделанная «наоборот» (пропускать только 'site'), красит
    // лишь этот тест: остальные о bot не спрашивают.
    for (const kind of ['site', 'bot'] as const) {
      const { svc, calls } = makeService();

      await svc.create({ userId: 'u-1', isAdmin: false, name: 'X', slug: 'site1', kind, secrets: {} });

      const insert = calls.find((c) => c.sql.includes('INSERT INTO products'))!;
      expect(insert.params).toContain(kind);
    }
  });

  it('нестроковое и пустое значение секрета отвергается на заведении', async () => {
    // encrypt форму значений не проверяет: коробку он соберёт, а взорвётся это
    // при расшифровке — в задаче 4, у агента на хосте, где отказ выглядит как
    // «провижининг сорвался» без указания на причину. Пустая строка доезжает
    // до контейнера переменной без значения — ботом это читается как «токена
    // нет», и он молча не стартует.
    for (const bad of [{ A: 42 }, { A: null }, { A: { b: 'c' } }, { A: '' }]) {
      const { svc, calls } = makeService();

      await expect(
        svc.create({ userId: 'u-1', isAdmin: false, name: 'X', slug: 'site1', kind: 'site', secrets: bad as any }),
      ).rejects.toThrow(/секрет/i);

      expect(sqlOf(calls)).not.toContain('INSERT INTO products');
    }
  });

  it('секреты имеют потолок: число, длина имени и длина значения', async () => {
    // Без потолков десять мегабайт уезжают в шифротекст, в строку продукта, в
    // тело задания и дальше в окружение контейнера, где предел живёт уже в
    // ядре хоста (ARG_MAX) — то есть отказ вылезает при ЗАПУСКЕ продукта, на
    // чужой машине и без объяснения.
    const cases: [string, Record<string, any>][] = [
      ['число', Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`K${i}`, 'v']))],
      ['длина имени', { ['K'.repeat(65)]: 'v' }],
      ['длина значения', { K: 'ы'.repeat(8193) }],
    ];
    for (const [, bad] of cases) {
      const { svc, calls } = makeService();

      await expect(
        svc.create({ userId: 'u-1', isAdmin: false, name: 'X', slug: 'site1', kind: 'site', secrets: bad }),
      ).rejects.toBeInstanceOf(BadRequestException);

      // Отбой ДО всякой записи: иначе продукт остался бы висеть без секретов.
      expect(sqlOf(calls)).not.toContain('INSERT INTO products');
    }
  });

  it('набор по самой границе потолков проходит', async () => {
    // Обратная сторона: потолок, поставленный на единицу ниже нужного,
    // отрезает законный случай — и без этой половины такое ужесточение
    // прошло бы зелёным.
    const { svc } = makeService();
    const secrets = Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`K${i}`, 'v']));
    secrets['K0'] = 'ы'.repeat(8192);
    secrets['K'.repeat(64)] = 'v';
    delete secrets['K63'];

    await expect(
      svc.create({ userId: 'u-1', isAdmin: false, name: 'X', slug: 'site1', kind: 'site', secrets }),
    ).resolves.toMatchObject({ productId: expect.any(String) });
  });

  it('имя секрета вне формы переменной окружения отвергается', async () => {
    // Имена уезжают в окружение контейнера. 'A B' и 'A=1' там либо теряются,
    // либо подменяют соседнюю переменную — в зависимости от того, как агент
    // соберёт env-файл.
    for (const bad of [{ 'A B': 'x' }, { 'A=1': 'x' }, { '': 'x' }, { 'A\nB': 'x' }]) {
      const { svc, calls } = makeService();

      await expect(
        svc.create({ userId: 'u-1', isAdmin: false, name: 'X', slug: 'site1', kind: 'site', secrets: bad }),
      ).rejects.toThrow(/секрет/i);

      expect(sqlOf(calls)).not.toContain('INSERT INTO products');
    }
  });

  // ОДНА ТАБЛИЦА НА ТРИ КОПИИ ПРОВЕРКИ: дословно та же стоит в
  // product-runner/src/host/provision.spec.ts (агент хоста) и в
  // spirits_front/src/components/products/secretNames.test.ts (форма). Она
  // перечисляет КАЖДОЕ точное имя и по примеру на каждое семейство — имя,
  // выпавшее из одной копии, не пройдёт незамеченным.
  const RESERVED_TABLE = [
    // точные
    'LINKEON_URL', 'RUNNER_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'PRODUCT_START_SCRIPT', 'CHECKOUT_PATH',
    'CLAUDE_BIN', 'PORT', 'HOME', 'PATH', 'NODE_OPTIONS', 'SHELL', 'USER', 'BASH_ENV', 'ENV',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'POLL_INTERVAL_MS', 'TURN_TIMEOUT_MS', 'POLL_TIMEOUT_MS', 'REQUEST_TIMEOUT_MS',
    // семейства
    'ANTHROPIC_BASE_URL', 'CLAUDE_CONFIG_DIR', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NPM_CONFIG_REGISTRY',
    'LD_PRELOAD', 'GIT_SSH_COMMAND', 'PM2_HOME', 'SSL_CERT_FILE', 'DOTENV_CONFIG_PATH',
    // регистр не спасает
    'https_proxy', 'port', 'npm_config_registry', 'dotenv_key',
  ];
  const ALLOWED_TABLE = [
    'NODE_ENV', 'node_env', 'TZ', 'OZON_API_KEY', 'MY_ANTHROPIC_KEY', 'GITHUB_TOKEN', 'NODEJS_VERSION',
    'POLL_INTERVAL', 'SSH_KEY', 'BOT_TOKEN',
  ];

  it('имя секрета, занятое платформой, отвергается до всякой записи', async () => {
    // Пока проверка жила только на агенте хоста, сервер такое имя принимал,
    // продукт записывался, а заведение падало в failed уже на машине
    // продуктов — с текстом, которого человек на своём экране не видит.
    for (const name of RESERVED_TABLE) {
      const { svc, calls } = makeService();

      await expect(
        svc.create({
          userId: 'u-1', isAdmin: false, name: 'X', slug: 'bot1', kind: 'bot',
          secrets: { BOT_TOKEN: 't', [name]: 'v' },
        }),
      ).rejects.toThrow(/занято/);

      expect(sqlOf(calls)).not.toContain('INSERT INTO products');
    }
  });

  it('соседи занятых семейств проходят', async () => {
    // Обратная сторона: семейство по префиксу, поставленное шире нужного,
    // отрезало бы законный ключ — GITHUB_TOKEN начинается на GIT, но не на GIT_.
    for (const name of ALLOWED_TABLE) {
      const { svc } = makeService();

      await expect(
        svc.create({
          userId: 'u-1', isAdmin: false, name: 'X', slug: 'bot1', kind: 'bot',
          secrets: { BOT_TOKEN: 't', [name]: 'v' },
        }),
      ).resolves.toMatchObject({ productId: expect.any(String) });
    }
  });

  it('секреты не переданы вовсе — заведение проходит, в базу идёт NULL', async () => {
    // Guard `input.secrets ?? {}` без этой проверки не сторожился ничем:
    // снятие обоих `?? {}` не роняло ни одного теста. Сервис лежит в exports
    // модуля, и следующий вызывающий (не контроллер задачи 7, который подаёт
    // `body.secrets ?? {}`) получил бы TypeError на Object.entries(undefined).
    const { svc, calls, secrets } = makeService();

    const res = await svc.create({
      userId: 'u-1',
      isAdmin: false,
      name: 'X',
      slug: 'site1',
      kind: 'site',
      secrets: undefined as any,
    });

    expect(res.productId).toEqual(expect.any(String));
    expect(secrets.encrypt).not.toHaveBeenCalled();
    const insert = calls.find((c) => c.sql.includes('INSERT INTO products'))!;
    expect(insert.params[8]).toBeNull();
  });

  it('многострочное значение секрета проходит: PEM-ключ законен', async () => {
    // Решение, а не недосмотр: перенос строки внутри ЗНАЧЕНИЯ не запрещается,
    // потому что приватный ключ в PEM — обычный секрет продукта. Запрет
    // выглядел бы как ужесточение защиты, а на деле отрезал бы законный
    // случай, и без этой проверки такое ужесточение прошло бы зелёным.
    //
    // Обратная сторона: инъекция `KEY=x\nOTHER=y` в env-файле остаётся
    // возможной, и экранировать обязан тот, кто env собирает (задача 4) —
    // либо отдавать секреты через -e/JSON, а не построчным файлом. Имена
    // секретов перенос строки не пропускают (проверка выше).
    const { svc, secrets } = makeService();
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----';

    await svc.create({ userId: 'u-1', isAdmin: false, name: 'X', slug: 'site1', kind: 'site', secrets: { KEY: pem } });

    expect(secrets.encrypt).toHaveBeenCalledWith({ KEY: pem }, expect.any(String));
  });

  it('слаг, занятый в гонке между проверкой и вставкой, даёт 409, а не 500', async () => {
    // Между SELECT count(*) и INSERT слаг может занять параллельный запрос.
    // Продукта при этом не остаётся, но пользователь получал бы страницу
    // ошибки вместо «слаг занят, выберите другой».
    const { svc } = makeService({ productInsertRace: true });

    await expect(
      svc.create({ userId: 'u-1', isAdmin: false, name: 'X', slug: 'site1', kind: 'site', secrets: {} }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('прочие ошибки вставки продукта не выдаются за занятый слаг', async () => {
    // Условие обязано быть узким, как в turns.service: безусловный
    // ConflictException превратил бы падение базы, нарушение CHECK и
    // столкновение по products_runner_token_hash_key в спокойное «слаг занят»
    // без следа в логах — 4xx не попадает в отчёты об ошибках.
    for (const err of [
      { code: '23514' },
      { code: '23505', constraint: 'products_runner_token_hash_key' },
    ]) {
      const { svc } = makeService({ productInsertError: err });

      await expect(
        svc.create({ userId: 'u-1', isAdmin: false, name: 'X', slug: 'site1', kind: 'site', secrets: {} }),
      ).rejects.not.toBeInstanceOf(ConflictException);
    }
  });

  it('сорванная постановка задания не оставляет продукт вечно в provisioning', async () => {
    // Транзакции здесь нет (BEGIN через пул в этом репозитории уже
    // рапортовал об откате, которого не было), поэтому продукт остаётся
    // записанным. Без пометки failed он висел бы в provisioning навсегда: ни
    // задания, чтобы его развернуть, ни ошибки в карточке, а слаг занят — и
    // повторить заведение под тем же слагом уже нельзя.
    const { svc, calls } = makeService({ jobInsertFails: true });

    await expect(
      svc.create({ userId: 'u-1', isAdmin: false, name: 'X', slug: 'site1', kind: 'site', secrets: {} }),
    ).rejects.toThrow();

    const fix = calls.find((c) => c.sql.includes('UPDATE products'))!;
    expect(fix).toBeDefined();
    expect(fix.sql).toContain("status = 'failed'");
    expect(fix.sql).toContain('provision_error');
    expect(fix.params[0]).toBe(
      calls.find((c) => c.sql.includes('INSERT INTO products'))!.params[0],
    );
  });

  // --- I2: Студия заводит бота без tgBotId — create() проверяет токен сам ---

  it('I2: отвергнутый токен — 400 до всякой записи', async () => {
    const { svc, calls, checkBot } = makeService({ botCheck: { ok: false, reason: 'rejected' } });

    await expect(
      svc.create({ userId: 'u-1', isAdmin: false, name: 'Бот', slug: 'studio-bot', kind: 'bot', secrets: { BOT_TOKEN: '123456:настоящийНастоящийНастоящий' } }),
    ).rejects.toThrow(/Telegram не принял токен/);

    expect(checkBot).toHaveBeenCalledWith('123456:настоящийНастоящийНастоящий');
    expect(sqlOf(calls)).not.toContain('INSERT INTO products');
  });

  it('I2: форма токена не подходит — тот же 400, до записи', async () => {
    const { svc, calls } = makeService({ botCheck: { ok: false, reason: 'bad_form' } });

    await expect(
      svc.create({ userId: 'u-1', isAdmin: false, name: 'Бот', slug: 'studio-bot2', kind: 'bot', secrets: { BOT_TOKEN: 'не токен' } }),
    ).rejects.toThrow(/Telegram не принял токен/);

    expect(sqlOf(calls)).not.toContain('INSERT INTO products');
  });

  it('I2: Telegram недоступен — продукт заводится, tg_bot_id — NULL', async () => {
    const { svc, calls } = makeService({ botCheck: { ok: false, reason: 'unreachable' } });

    const res = await svc.create({
      userId: 'u-1', isAdmin: false, name: 'Бот', slug: 'studio-bot3', kind: 'bot',
      secrets: { BOT_TOKEN: '123456:чтоУгодно' },
    });

    expect(res.productId).toEqual(expect.any(String));
    const insert = calls.find((c) => c.sql.includes('INSERT INTO products'))!;
    // tgBotId — предпоследним параметром: последний теперь FREE_MONTH_PRODUCTS
    // (порог CASE paid_until, решение владельца 26.10.2026).
    expect(insert.params[insert.params.length - 2]).toBeNull();
  });

  it('I2: токен живой — tg_bot_id от getMe уходит в INSERT', async () => {
    const { svc, calls } = makeService({ botCheck: { ok: true, id: 555, username: 'studio_bot' } });

    const res = await svc.create({
      userId: 'u-1', isAdmin: false, name: 'Бот', slug: 'studio-bot4', kind: 'bot',
      secrets: { BOT_TOKEN: '123456:чтоУгодно' },
    });

    expect(res.productId).toEqual(expect.any(String));
    const insert = calls.find((c) => c.sql.includes('INSERT INTO products'))!;
    expect(insert.params[insert.params.length - 2]).toBe(555);
  });

  it('I2: тот же бот уже работает в другом продукте — 409 до записи', async () => {
    const { svc, calls } = makeService({ botCheck: { ok: true, id: 555 }, botBusy: true });

    await expect(
      svc.create({ userId: 'u-1', isAdmin: false, name: 'Бот', slug: 'studio-bot5', kind: 'bot', secrets: { BOT_TOKEN: '123456:чтоУгодно' } }),
    ).rejects.toThrow(/бот уже работает в другом продукте/);

    expect(sqlOf(calls)).not.toContain('INSERT INTO products');
  });

  it('I2: tgBotId уже передан (путь ассистента) — свой getMe не зовётся', async () => {
    // Полная противоположность всем тестам выше: completeCreateBot уже
    // проверил токен и передал готовый tgBotId — повторный поход в Telegram
    // здесь был бы вторым getMe за тот же токен без всякой нужды.
    const { svc, calls, checkBot } = makeService();

    await svc.create({
      userId: 'u-1', isAdmin: false, name: 'Бот', slug: 'studio-bot6', kind: 'bot',
      secrets: { BOT_TOKEN: '123456:чтоУгодно' }, tgBotId: 777,
    });

    expect(checkBot).not.toHaveBeenCalled();
    const insert = calls.find((c) => c.sql.includes('INSERT INTO products'))!;
    expect(insert.params[insert.params.length - 2]).toBe(777);
  });

  it('I2: бот без секрета BOT_TOKEN вовсе — getMe не зовётся, tg_bot_id — NULL', async () => {
    const { svc, calls, checkBot } = makeService();

    const res = await svc.create({ userId: 'u-1', isAdmin: false, name: 'Бот', slug: 'studio-bot7', kind: 'bot', secrets: {} });

    expect(checkBot).not.toHaveBeenCalled();
    const insert = calls.find((c) => c.sql.includes('INSERT INTO products'))!;
    expect(insert.params[insert.params.length - 2]).toBeNull();
    expect(res.productId).toEqual(expect.any(String));
  });
});

describe('регистрация в ProductsModule', () => {
  // Каждый тест выше собирает сервис руками, поэтому забытый провайдер ими не
  // ловится вообще. Сейчас ProvisioningService ещё никто не инжектит (вход
  // появится задачей 6), так что и Nest на старте промолчит: приложение
  // поднимется, а кнопка заведения продукта упадёт 500 при первом нажатии.
  const providers = (Reflect.getMetadata('providers', ProductsModule) ?? []) as any[];

  it('ProvisioningService и SecretsService объявлены провайдерами', () => {
    expect(providers).toContain(ProvisioningService);
    // SecretsService — зависимость ProvisioningService. Без него в списке
    // модуль не соберётся вовсе.
    expect(providers).toContain(SecretsService);
  });

  it('LimitsService объявлен провайдером', () => {
    // Зависимость ProvisioningService, как и SecretsService: забытая в списке
    // роняет подъём всего модуля — то есть API не стартует. Громко, но найти
    // это проще по тесту, чем по строке Nest в логе pm2.
    expect(providers).toContain(LimitsService);
  });

  it('DomainsService объявлен провайдером и экспортируется', () => {
    // Конструкторская зависимость ProductsController: без неё в списке не
    // поднимается контроллер, то есть весь API. Экспорт — для инструмента
    // ассистента, живущего в другом модуле.
    expect(providers).toContain(DomainsService);
    expect(Reflect.getMetadata('exports', ProductsModule) ?? []).toContain(DomainsService);
  });

  // Сборка DI без Nest: @nestjs/testing в зависимостях нет, а поднимать
  // настоящий модуль значило бы подключаться к Redis и Postgres. Вместо этого
  // — то же правило, по которому Nest резолвит конструктор: каждая
  // зависимость каждого провайдера и контроллера модуля обязана быть его
  // провайдером, экспортом импортированного модуля или глобальным
  // ConfigService (ConfigModule.forRoot({ isGlobal: true }) в AppModule).
  // Забытая регистрация здесь краснеет именем класса, а не падением pm2 на проде.
  it('каждая конструкторская зависимость модуля резолвится', () => {
    const imported = ((Reflect.getMetadata('imports', ProductsModule) ?? []) as any[]).flatMap(
      (m) => (Reflect.getMetadata('exports', m) ?? []) as any[],
    );
    const known = new Set<any>([...providers, ...imported, ConfigService]);
    const controllers = (Reflect.getMetadata('controllers', ProductsModule) ?? []) as any[];
    const unresolved: string[] = [];
    for (const cls of [...providers, ...controllers]) {
      const deps = (Reflect.getMetadata('design:paramtypes', cls) ?? []) as any[];
      for (const [i, dep] of deps.entries()) {
        // undefined — тип, стёртый при компиляции (интерфейс, `import type`):
        // Nest его тоже не резолвит, и это такая же поломка.
        if (!known.has(dep)) unresolved.push(`${cls.name}[${i}] → ${dep?.name ?? String(dep)}`);
      }
    }
    expect(unresolved).toEqual([]);
    // Проверка не пустышка: у контроллера и сервиса доменов зависимости есть.
    expect(Reflect.getMetadata('design:paramtypes', ProductsController)).toContain(DomainsService);
    expect(Reflect.getMetadata('design:paramtypes', DomainsService)).toEqual([PgService]);
  });
});
