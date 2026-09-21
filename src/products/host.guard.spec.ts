import { Logger, UnauthorizedException } from '@nestjs/common';
import * as crypto from 'crypto';
import { HostGuard } from './host.guard';

/**
 * Документированная форма токена: `openssl rand -hex 32`. Набор строится именно
 * на ней, а не на удобной строке вроде 'секрет-машины': кириллический токен наш
 * же агент отправить не может (`http.request` бросает ERR_INVALID_CHAR), а
 * досланный сырым сокетом приходит latin1-строкой и расходится с записанным в
 * реестр. Позитивный тест на таком входе был бы зелёным на том, чего продакшен
 * не породит.
 */
const TOKEN = 'f2af8c8ae9fc4a1aa704c164ed4172fdcb92fe3bf410be9dde84fae16461bb7c';
const OTHER = '5ed790c9760a53385a44929641c569868bc0d0a5e65c338ce431c5aed1ca480d';

const sha = (t: string) => crypto.createHash('sha256').update(t).digest('hex');

/**
 * Заглушка базы, ведущая себя КАК ТАБЛИЦА, а не как «вернуть заранее
 * заготовленную строку».
 *
 * Разница принципиальная. Заглушка, отдающая `{ rows: [{ host_id: 'clients' }] }`
 * на любой вход, делает зелёными и «ищет по хешу», и «берёт метку той машины,
 * чей токен предъявлен», и «чужой токен отвергается» — все три при реализации,
 * которая вообще не смотрит на параметр. Здесь же поиск идёт по настоящему
 * sha256 и по настоящему реестру, поэтому половина набора ниже что-то значит.
 *
 * Форма ответа повторяет живую: `count(*)` приезжает из node-pg СТРОКОЙ
 * (bigint), а не числом. Реализация, сравнивающая total с нулём через `===`,
 * краснеет здесь, а не на проде. Сторож на живой базе — сценарии 45* в
 * provisioning.integration.spec.ts.
 */
const registry = (...machines: [id: string, token: string][]) => {
  const rows = machines.map(([id, token]) => ({ id, hash: sha(token) }));
  const query = jest.fn(async (_sql: string, params?: unknown[]) => ({
    rows: [
      {
        host_id: rows.find((r) => r.hash === params?.[0])?.id ?? null,
        total: String(rows.length),
      },
    ],
  }));
  return { query };
};

/**
 * `auth === undefined` даёт запрос вовсе без заголовка, а не с пустым: это
 * разные ветки разбора. Массив допущен намеренно — см. тесты про нестроковый
 * заголовок. `extra` подкладывает на запрос то, чего там быть не должно.
 */
const request = (auth?: string | string[], extra: Record<string, unknown> = {}) => ({
  headers: auth === undefined ? {} : { authorization: auth },
  ...extra,
});

const ctx = (req: unknown) => ({ switchToHttp: () => ({ getRequest: () => req }) }) as any;

/** Возвращает то, чем упал гвард, либо null — если не упал вовсе. */
const refusalOn = (pg: { query: unknown }, req: unknown): Promise<any> =>
  new HostGuard(pg as any).canActivate(ctx(req)).then(
    () => null,
    (e: unknown) => e,
  );

/** Отказ на реестре из одной чужой машины — самый частый вход набора. */
const refusal = (auth?: string | string[]): Promise<any> =>
  refusalOn(registry(['own', OTHER]), request(auth));

describe('HostGuard', () => {
  let warned: string[];
  let errored: string[];

  beforeEach(() => {
    // Лог глушится во всех тестах разом: иначе прогон засыпается отказами из
    // тестов про чужой токен. Записи собираем — на них держится проверка
    // «сервер не молчит».
    warned = [];
    errored = [];
    jest.spyOn(Logger.prototype, 'warn').mockImplementation((m: any) => {
      warned.push(String(m));
    });
    jest.spyOn(Logger.prototype, 'error').mockImplementation((m: any) => {
      errored.push(String(m));
    });
  });

  afterEach(() => jest.restoreAllMocks());

  it('фикстура совпадает с документированной формой токена', () => {
    // Если константы поедут, весь набор поедет вместе с ними молча.
    expect(TOKEN).toMatch(/^[0-9a-f]{64}$/);
    expect(OTHER).toMatch(/^[0-9a-f]{64}$/);
    expect(OTHER).not.toBe(TOKEN);
    // То, что такой токен вообще долетает по HTTP: значения заголовков latin1.
    expect(Buffer.byteLength(TOKEN)).toBe(TOKEN.length);
  });

  describe('токен превращается в метку машины', () => {
    it('метка берётся из базы по предъявленному токену', async () => {
      const req = request(`Bearer ${TOKEN}`);

      await expect(new HostGuard(registry(['clients', TOKEN]) as any).canActivate(ctx(req))).resolves.toBe(
        true,
      );

      expect((req as any).hostId).toBe('clients');
    });

    it('метка — ТОЙ машины, чей токен предъявлен, а не первой в реестре', async () => {
      // ГЛАВНЫЙ ТЕСТ ЗАДАЧИ. Ровно здесь ломается «задание достаётся тому, кто
      // первым спросил»: реализация, берущая первую строку реестра, отдала бы
      // агенту клиентской машины метку владельца — и продукт клиента уехал бы
      // разворачиваться туда, где его каталога нет.
      const pg = registry(['own', OTHER], ['clients', TOKEN]);
      const mine = request(`Bearer ${OTHER}`);
      const theirs = request(`Bearer ${TOKEN}`);

      await new HostGuard(pg as any).canActivate(ctx(mine));
      await new HostGuard(pg as any).canActivate(ctx(theirs));

      expect((mine as any).hostId).toBe('own');
      expect((theirs as any).hostId).toBe('clients');
    });

    it('ищет по ХЕШУ, а не по самому токену', async () => {
      // Открытый токен в базе означал бы, что её дамп даёт право заводить
      // продукты на любой машине. Тот же приём, что у runner-токена продукта.
      const pg = registry(['own', TOKEN]);

      await new HostGuard(pg as any).canActivate(ctx(request(`Bearer ${TOKEN}`)));

      const [sql, params] = pg.query.mock.calls[0];
      expect(params?.[0]).toBe(sha(TOKEN));
      expect(params?.[0]).not.toBe(TOKEN);
      // Форма запроса: заглушка SQL не исполняет, и ошибка в имени таблицы или
      // колонки прошла бы весь набор зелёной. Исполнением это закрыто на живой
      // базе (45*), здесь — дешёвый сторож от переименования вслепую.
      expect(sql).toMatch(/FROM product_hosts/);
      expect(sql).toMatch(/agent_token_hash = \$1/);
    });

    it('в базу не уезжает ни сам токен, ни его кусок', async () => {
      // Параметр — ровно один. Вторым «на всякий случай» однажды уедет сам
      // токен, и он останется в pg_stat_statements и в логах Postgres.
      const pg = registry(['own', TOKEN]);

      await new HostGuard(pg as any).canActivate(ctx(request(`Bearer ${TOKEN}`)));

      const [sql, params] = pg.query.mock.calls[0];
      expect(params).toHaveLength(1);
      expect(sql).not.toContain(TOKEN);
      expect(JSON.stringify(pg.query.mock.calls)).not.toContain(TOKEN);
    });

    it('решение целиком принимает база: своего представления о токене у гварда нет', async () => {
      // ФИКСИРУЕТ РЕШЕНИЕ ПРО СВЕРКУ ПОСТОЯННОГО ВРЕМЕНИ. Прежний гвард сверял
      // токен с `PRODUCT_HOST_TOKEN` через crypto.timingSafeEqual; теперь
      // сравнения в нашем коде нет вовсе — сравнивается sha256
      // высокоэнтропийного токена, а оракул по времени на ХЕШЕ бесполезен:
      // чтобы предъявить токен, нужен прообраз.
      //
      // Проверяется именно отсутствие второй сверки: заглушка узнаёт ЛЮБОЙ
      // правдоподобный токен, и гвард обязан пустить. Реализация, оставившая
      // рядом проверку по окружению, здесь покраснеет.
      const pg = { query: jest.fn(async () => ({ rows: [{ host_id: 'own', total: '1' }] })) };
      const spy = jest.spyOn(crypto, 'timingSafeEqual');
      const req = request(`Bearer ${'9'.repeat(64)}`);

      await expect(new HostGuard(pg as any).canActivate(ctx(req))).resolves.toBe(true);

      expect((req as any).hostId).toBe('own');
      expect(spy).not.toHaveBeenCalled();
    });

    it('верный токен ничего не пишет в журнал', async () => {
      await new HostGuard(registry(['own', TOKEN]) as any).canActivate(ctx(request(`Bearer ${TOKEN}`)));

      expect(warned).toEqual([]);
      expect(errored).toEqual([]);
    });
  });

  describe('метку нельзя заявить о себе', () => {
    it('тело запроса метку не подменяет', async () => {
      // Взятая из тела, метка была бы заявлением агента о себе: любой агент
      // объявил бы себя машиной владельца и забрал бы её задания.
      const req = request(`Bearer ${TOKEN}`, { body: { hostId: 'own' } });

      await new HostGuard(registry(['own', OTHER], ['clients', TOKEN]) as any).canActivate(ctx(req));

      expect((req as any).hostId).toBe('clients');
    });

    it('метка, подложенная на запрос ДО гварда, перетирается', async () => {
      // По HTTP `req.hostId` не подделать — тело живёт в req.body. Инвариант,
      // однако, держит Express, а не этот репозиторий; здесь он закреплён.
      const req = request(`Bearer ${TOKEN}`, { hostId: 'own' });

      await new HostGuard(registry(['clients', TOKEN]) as any).canActivate(ctx(req));

      expect((req as any).hostId).toBe('clients');
    });

    it('при отказе подложенная метка СНИМАЕТСЯ, а не остаётся лежать', async () => {
      // Гвард, который метку при отказе просто «не ставит», оставил бы чужую
      // нетронутой — и контроллер прочитал бы именно её.
      const req = request(`Bearer ${TOKEN}`, { hostId: 'own' });

      await expect(refusalOn(registry(['own', OTHER]), req)).resolves.toBeInstanceOf(
        UnauthorizedException,
      );

      expect((req as any).hostId).toBeUndefined();
    });

    it('метки не появляется ни при одном отказе', async () => {
      for (const auth of [undefined, 'Bearer ', `Bearer ${'ю'.repeat(64)}`, `Bearer ${OTHER}`]) {
        const req = request(auth);

        await expect(refusalOn(registry(['own', TOKEN]), req)).resolves.toBeInstanceOf(
          UnauthorizedException,
        );

        expect((req as any).hostId).toBeUndefined();
      }
    });
  });

  describe('неизвестный токен', () => {
    it('отказ, и метки на запросе не появляется', async () => {
      const req = request(`Bearer ${TOKEN}`);

      const err = await refusalOn(registry(['own', OTHER]), req);

      expect(err).toBeInstanceOf(UnauthorizedException);
      expect(err.message).toBe('Unknown host token');
      expect((req as any).hostId).toBeUndefined();
    });

    it('оставляет строку в журнале', async () => {
      // ОБЯЗАТЕЛЬНО. Снаружи агент с чужим токеном выглядит исправным: юнит
      // active, перезапусков нет, ошибок нет — он просто никогда не получает
      // работы (измерено в куске 2, сценарий 21д). Эта строка — единственное
      // место, где он вообще виден.
      await refusal(`Bearer ${TOKEN}`);

      expect(warned).toHaveLength(1);
      expect(warned[0]).toMatch(/неизвестн/i);
    });

    it('в журнал уезжает начало хеша, но не сам токен', async () => {
      // Логи читает больше людей, чем конфиги машин. Начало хеша, наоборот,
      // нужно: по нему отличимы повторы одного агента от перебора разными
      // токенами, и по нему же оператор проверяет реестр запросом.
      await refusal(`Bearer ${TOKEN}`);

      expect(warned[0]).toContain(sha(TOKEN).slice(0, 8));
      expect(warned[0]).not.toContain(TOKEN);
      expect(warned[0]).not.toContain(sha(TOKEN));
    });

    it('кривой токен до базы и до журнала не доходит', async () => {
      // `Bearer test` — это интернет-сканер, а не наш агент. Журнал, в который
      // пишет кто угодно снаружи, перестают читать; а читать его надо ровно
      // ради предыдущего теста.
      const pg = registry(['own', TOKEN]);

      for (const auth of [undefined, 'Bearer ', 'Bearer test', `Bearer ${TOKEN} `]) {
        await expect(refusalOn(pg, request(auth))).resolves.toBeInstanceOf(UnauthorizedException);
      }

      expect(pg.query).not.toHaveBeenCalled();
      expect(warned).toEqual([]);
      expect(errored).toEqual([]);
    });
  });

  describe('пустой реестр', () => {
    it('отличим от чужого токена и по сообщению, и по журналу', async () => {
      // Состояние ДОСТИЖИМОЕ: 005 при незаполненном PRODUCT_HOST_TOKEN на
      // чистой базе нарочно не заводит машину вовсе (сценарий 40в). Без
      // отдельного сообщения это выглядит как «у агента не тот токен», и
      // оператор уходит чинить конфиг машины, который в порядке.
      const err = await refusalOn(registry(), request(`Bearer ${TOKEN}`));

      expect(err).toBeInstanceOf(UnauthorizedException);
      expect(err.message).toBe('host registry not configured');
      expect(errored).toHaveLength(1);
      expect(errored[0]).toMatch(/реестр машин пуст/);
      expect(warned).toEqual([]);
    });

    it('счётчик приезжает строкой и всё равно читается как ноль', async () => {
      // node-pg отдаёт count(*) СТРОКОЙ: bigint не влезает в number. Сравнение
      // `total === 0` было бы ложным всегда, и пустой реестр докладывал бы о
      // себе как о чужом токене.
      const pg = { query: jest.fn(async () => ({ rows: [{ host_id: null, total: '0' }] })) };

      expect((await refusalOn(pg, request(`Bearer ${TOKEN}`))).message).toBe(
        'host registry not configured',
      );
    });

    it('непустой реестр пустым не объявляется', async () => {
      const pg = { query: jest.fn(async () => ({ rows: [{ host_id: null, total: '2' }] })) };

      expect((await refusalOn(pg, request(`Bearer ${TOKEN}`))).message).toBe('Unknown host token');
    });
  });

  describe('разбор заголовка', () => {
    it('отвергает запрос без токена', async () => {
      const err = await refusal();

      expect(err).toBeInstanceOf(UnauthorizedException);
      expect(err.message).toBe('Missing host token');
    });

    it('четыре отказа различимы по сообщению', async () => {
      // Сообщения — единственная диагностика на стороне того, кто поднимает
      // агента: «реестр пуст», «токен не той формы» и «токен чужой» ведут в
      // совершенно разные места. Без этой проверки рефактор, схлопнувший их в
      // одно, остался бы зелёным.
      const messages = [
        (await refusal()).message,
        (await refusal('Bearer test')).message,
        (await refusal(`Bearer ${TOKEN}`)).message,
        (await refusalOn(registry(), request(`Bearer ${TOKEN}`))).message,
      ];

      expect(new Set(messages).size).toBe(4);
      expect(messages).toEqual([
        'Missing host token',
        'Bad host token',
        'Unknown host token',
        'host registry not configured',
      ]);
    });

    it('заголовок без префикса Bearer не принимается', async () => {
      // Тест на отсутствие токена эту мутацию НЕ ловит: при фоллбэке на всю
      // строку запрос без заголовка всё равно даёт пустой токен и падает на
      // проверке `!token`. Нужен именно голый токен без префикса.
      expect((await refusal(TOKEN)).message).toBe('Missing host token');
    });

    it('префикс Bearer разбирается регистрозависимо', async () => {
      // RFC 7235 объявляет схему авторизации регистронезависимой, то есть мы
      // строже стандарта. Это осознанно и совпадает с RunnerGuard: агента
      // машины пишем мы сами, заголовок формирует наш же код.
      expect((await refusal(`bearer ${TOKEN}`)).message).toBe('Missing host token');
    });

    it('лишний пробел вокруг токена не прощается', async () => {
      // Токен не тримится. Тест фиксирует это как решение, а не как
      // случайность: молчаливый trim() прятал бы кривой конфиг агента.
      expect((await refusal(`Bearer ${TOKEN} `)).message).toBe('Bad host token');
      expect((await refusal(`Bearer  ${TOKEN}`)).message).toBe('Bad host token');
    });

    it('нестроковый заголовок даёт 401, а не падение гварда', async () => {
      const err = await refusal([`Bearer ${TOKEN}`, 'Bearer чужой']);

      expect(err).toBeInstanceOf(UnauthorizedException);
      expect(err).not.toBeInstanceOf(TypeError);
    });

    it('одноэлементный массив в заголовке не принимается', async () => {
      // `String(['Bearer x'])` даёт 'Bearer x', то есть при приведении строкой
      // такой заголовок ПРОХОДИЛ БЫ. Node дубликаты Authorization отбрасывает и
      // массива не отдаёт никогда — но это деталь ядра вне нашего репозитория, а
      // за гвардом лежат чужие секреты, поэтому не полагаемся на неё.
      expect(String([`Bearer ${TOKEN}`])).toBe(`Bearer ${TOKEN}`);

      expect((await refusal([`Bearer ${TOKEN}`])).message).toBe('Missing host token');
    });
  });

  describe('форма предъявленного токена', () => {
    it('короткий токен отвергается до запроса к базе', async () => {
      // `HOST_TOKEN=test` на тестовом стенде вероятнее, чем хотелось бы, а за
      // гвардом claimJob с расшифрованными секретами продуктов. Отбой до базы
      // ещё и не даёт сканеру гонять нам запросы.
      const pg = registry(['own', TOKEN]);

      for (const weak of ['test', 'changeme', 'a'.repeat(31)]) {
        const err = await refusalOn(pg, request(`Bearer ${weak}`));

        expect(err).toBeInstanceOf(UnauthorizedException);
        expect(err.message).toBe('Bad host token');
      }
      expect(pg.query).not.toHaveBeenCalled();
    });

    it('граница длины ровно на 32', async () => {
      // Иначе `>=`/`>` не различить, и 32-символьный токен из реестра молча
      // перестал бы приниматься.
      const short = 'b'.repeat(32);
      const req = request(`Bearer ${short}`);

      await expect(new HostGuard(registry(['own', short]) as any).canActivate(ctx(req))).resolves.toBe(
        true,
      );

      expect((req as any).hostId).toBe('own');
    });

    it('неASCII в токене отвергается, а не перекодируется молча', async () => {
      // Кириллический токен недостижим: агент его не отправит
      // (ERR_INVALID_CHAR), а досланный сырым сокетом придёт latin1-строкой и
      // даст не тот sha256. Снаружи это выглядело бы как «правильный токен не
      // подходит».
      const pg = registry(['own', TOKEN]);

      for (const bad of ['я'.repeat(40), `${TOKEN}\n`, `${TOKEN}\t`]) {
        expect((await refusalOn(pg, request(`Bearer ${bad}`))).message).toBe('Bad host token');
      }
      expect(pg.query).not.toHaveBeenCalled();
    });

    it('символы вне latin1 не схлопываются в настоящий токен', async () => {
      // Buffer.from(s, 'latin1'|'ascii') режет code point по младшему байту, так
      // что строка из символов «настоящий + 0x100» под такой кодировкой даёт
      // ровно байты токена (измерено). Отбой по форме закрывает это до всякого
      // хеширования — но проверяется именно исход, а не причина.
      const shadow = [...TOKEN].map((c) => String.fromCharCode(c.charCodeAt(0) + 0x100)).join('');
      expect(shadow).toHaveLength(TOKEN.length);
      expect(Buffer.from(shadow, 'latin1').equals(Buffer.from(TOKEN))).toBe(true);

      const err = await refusalOn(registry(['own', TOKEN]), request(`Bearer ${shadow}`));

      expect(err).toBeInstanceOf(UnauthorizedException);
      expect((err as any).message).not.toBe('Unknown host token');
    });

    it('токен-префикс настоящего не принимается', async () => {
      // Классический промах — сравнение через startsWith/indexOf вместо
      // равенства. Префикс намеренно длиной 32: форму он проходит, то есть
      // доезжает до базы, и отказ обязан прийти от несовпадения хеша.
      const prefix = TOKEN.slice(0, 32);
      expect(TOKEN.startsWith(prefix)).toBe(true);

      const pg = registry(['own', TOKEN]);

      expect((await refusalOn(pg, request(`Bearer ${prefix}`))).message).toBe('Unknown host token');
      expect(pg.query).toHaveBeenCalledTimes(1);
    });

    it('токен, отличающийся только регистром, не принимается', async () => {
      // hex в верхнем регистре — ровно то, что принесёт копипаста из другого
      // инструмента: форма та же, длина та же. Ловит мутацию с toLowerCase()
      // перед хешированием.
      const upper = TOKEN.toUpperCase();
      expect(upper).not.toBe(TOKEN);

      expect((await refusalOn(registry(['own', TOKEN]), request(`Bearer ${upper}`))).message).toBe(
        'Unknown host token',
      );
    });
  });

  describe('база не отвечает', () => {
    it('отказ базы даёт 500, а не 401', async () => {
      // Проглоченная ошибка базы выглядела бы как «у агента не тот токен»: и
      // оператор, и инсталлятор агента (`HTTP 401 → проверь HOST_TOKEN`) ушли
      // бы чинить конфиг вместо базы. Плюс 500 попадает в общий фильтр
      // исключений Nest, то есть в лог с трассой.
      const pg = { query: jest.fn(async () => Promise.reject(new Error('connection terminated'))) };

      const err = await refusalOn(pg, request(`Bearer ${TOKEN}`));

      expect(err).not.toBeInstanceOf(UnauthorizedException);
      expect(err.message).toBe('connection terminated');
    });

    it('отказ базы не оставляет метки на запросе', async () => {
      const pg = { query: jest.fn(async () => Promise.reject(new Error('connection terminated'))) };
      const req = request(`Bearer ${TOKEN}`, { hostId: 'own' });

      await refusalOn(pg, req);

      expect((req as any).hostId).toBeUndefined();
    });
  });

  it('сообщение об отказе не выдаёт ни сам токен, ни его длину', async () => {
    // Диагностика вида «ожидалось 64 символа, пришло 8» превращает отказ в
    // оракул длины: снаружи угадывать нечего, а изнутри подсказка есть.
    const err = await refusal(`Bearer ${TOKEN}`);

    // Сначала про сам отказ: без этого утверждения тест зелен вхолостую —
    // у пропустившего гварда err === null, message === '', и обе проверки
    // «ничего не выдаёт» проходят.
    expect(err).toBeInstanceOf(UnauthorizedException);

    const message = String(err?.message ?? '');
    expect(message).not.toContain(TOKEN);
    expect(message).not.toContain(sha(TOKEN));
    expect(message).not.toMatch(/\d/);
  });
});
