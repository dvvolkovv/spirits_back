import { Logger, UnprocessableEntityException } from '@nestjs/common';
import { HostsService } from './hosts.service';

/**
 * Заглушка базы, ведущая себя КАК ТАБЛИЦА, а не как «вернуть заготовленную
 * строку».
 *
 * Разница та же, что в host.guard.spec.ts: заглушка, отдающая один и тот же
 * ответ на любой вход, делает зелёными и «аудитория выводится из признака», и
 * «продукт админа уезжает на свою машину» — включая реализацию, которая на
 * параметр не смотрит вовсе. Здесь отбор идёт ПО ПАРАМЕТРУ запроса, поэтому
 * половина набора ниже что-то значит.
 *
 * Чего заглушка НЕ делает — не считает потолок и не смотрит на accepts_new:
 * это условия SQL, и проверить их можно только исполнением. Их сторожат
 * сценарии 51* в provisioning.integration.spec.ts; здесь `room` — просто
 * свойство фикстуры.
 *
 * Счётчики приезжают СТРОКАМИ: `count(*)` — bigint, и node-pg отдаёт его
 * строкой. Реализация, сравнивающая их с нулём через `===`, краснеет здесь.
 */
type Machine = { id: string; audience: string; room?: boolean };

const registry = (...machines: Machine[]) => {
  const calls: { sql: string; params: any[] }[] = [];
  const query = jest.fn(async (sql: string, params: any[] = []) => {
    calls.push({ sql, params });
    const audience = params[0];
    const chosen = [...machines]
      .filter((m) => m.audience === audience && m.room !== false)
      .sort((a, b) => a.id.localeCompare(b.id))[0];
    return {
      rows: [
        {
          // null-поля, а не отсутствие строки: запрос собран так, что строка
          // приезжает всегда (LEFT JOIN к `(SELECT 1)`), и именно поэтому
          // счётчики доступны вместе с отказом.
          id: chosen?.id ?? null,
          // Значения РАЗНЫЕ у каждой машины и не выводятся одно из другого:
          // перепутанные местами адрес и зона иначе неотличимы.
          public_ip: chosen ? `10.77.0.${chosen.id.length}` : null,
          domain_suffix: chosen ? `${chosen.id}.zone.test` : null,
          total: String(machines.length),
          in_audience: String(machines.filter((m) => m.audience === audience).length),
        },
      ],
    };
  });
  return { pg: { query }, calls };
};

const svcOn = (pg: any) => new HostsService(pg as any);

/** Чем упал выбор, либо null — если не упал. */
const refusal = (svc: HostsService, isAdmin: boolean): Promise<any> =>
  svc.pickForNewProduct(isAdmin).then(
    () => null,
    (e: unknown) => e,
  );

describe('HostsService.pickForNewProduct', () => {
  let logged: { level: string; text: string }[];

  beforeEach(() => {
    logged = [];
    for (const level of ['warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((m: any) => {
        logged.push({ level, text: String(m) });
      });
    }
  });

  afterEach(() => jest.restoreAllMocks());

  describe('аудитория выводится из признака администратора', () => {
    it('продукт админа спрашивает машины own, продукт клиента — clients', async () => {
      // ГЛАВНОЕ РЕШЕНИЕ ЗАДАЧИ. Реализация, спрашивающая одну аудиторию на
      // всех, поставила бы чужой продукт рядом с боевыми — ровно та авария,
      // ради которой машины и разделяют.
      const { pg } = registry({ id: 'own', audience: 'own' }, { id: 'clients', audience: 'clients' });
      const svc = svcOn(pg);

      await expect(svc.pickForNewProduct(true)).resolves.toMatchObject({ id: 'own' });
      await expect(svc.pickForNewProduct(false)).resolves.toMatchObject({ id: 'clients' });
    });

    it('аудитория уезжает ПАРАМЕТРОМ, а не склейкой в текст запроса', async () => {
      // Склейка здесь безвредна (значение выводим мы сами, а не пользователь),
      // но параметр — это ещё и единственный способ, которым видно, что
      // условие в SQL вообще есть: запрос с зашитой строкой прошёл бы отбор по
      // одной аудитории всегда.
      const { pg, calls } = registry({ id: 'own', audience: 'own' });
      await svcOn(pg).pickForNewProduct(true);

      expect(calls).toHaveLength(1);
      expect(calls[0].params).toEqual(['own']);
      expect(calls[0].sql).toContain('h.audience = $1');
      expect(calls[0].sql).not.toContain("'own'");
      expect(calls[0].sql).not.toContain("'clients'");
    });

    it('не-true считается обычным пользователем, а не администратором', async () => {
      // Признак приезжает через `any` (@CurrentUser() user: any), и строка
      // 'false' истинна. Приведение к истинности поставило бы чужой продукт на
      // боевую машину — ошибка в опасную сторону. Строгое сравнение уводит
      // любое не-true в clients, где ошибка безобидна.
      const { pg, calls } = registry({ id: 'own', audience: 'own' }, { id: 'clients', audience: 'clients' });
      const svc = svcOn(pg);

      for (const bad of ['false', 'true', 1, {}, [], 'да']) {
        await svc.pickForNewProduct(bad as any).catch(() => undefined);
      }

      expect(calls.map((c) => c.params[0])).toEqual(Array(6).fill('clients'));
    });

    it('признак не додумывается из чего-либо ещё: false — это clients, и точка', async () => {
      // Реализация «нет clients — возьму own» выглядела бы удобной и означала
      // бы продукт клиента на машине владельца при первом же дне, когда второй
      // машины ещё нет. Это и есть сегодняшнее состояние прода.
      const { pg } = registry({ id: 'own', audience: 'own' });

      const e = await refusal(svcOn(pg), false);

      expect(e).toBeInstanceOf(UnprocessableEntityException);
    });
  });

  describe('что возвращается наружу', () => {
    it('метка, адрес и зона — каждое своим полем', async () => {
      // Перепутанные местами publicIp и domainSuffix дали бы продукту домен
      // вида `slug.10.77.0.3` и адрес `own.zone.test` в inet-колонке. Второе
      // упало бы на проде, первое — молчаливо.
      const { pg } = registry({ id: 'own', audience: 'own' });

      await expect(svcOn(pg).pickForNewProduct(true)).resolves.toEqual({
        id: 'own',
        publicIp: '10.77.0.3',
        domainSuffix: 'own.zone.test',
      });
    });

    it('хеш токена машины наружу не запрашивается вовсе', async () => {
      // Строка реестра несёт agent_token_hash. Выбор машины отдаёт ровно то,
      // что записывается в продукт, — по тому же правилу, по которому HostGuard
      // кладёт на запрос одну метку, а не всю строку.
      const { pg, calls } = registry({ id: 'own', audience: 'own' });
      await svcOn(pg).pickForNewProduct(true);

      expect(calls[0].sql).not.toContain('agent_token_hash');
      // Не голый not.toContain('*'): в запросе законно стоит count(*).
      // Перечисление колонок — единственное, что мешает следующей секретной
      // колонке реестра уехать наружу молча (тот же сторож у COLUMNS кабинета).
      expect(calls[0].sql).not.toMatch(/SELECT\s+\*/);
      expect(calls[0].sql).not.toMatch(/SELECT\s+h\.\*/);
    });

    it('один запрос, а не два: счётчики отказа приезжают вместе с машиной', async () => {
      // Второй запрос «за причиной» пришлось бы делать в тот самый момент,
      // ради которого всё написано, — когда с базой уже что-то не так.
      const { pg, calls } = registry({ id: 'own', audience: 'own' });
      await svcOn(pg).pickForNewProduct(true);

      expect(calls).toHaveLength(1);
    });
  });

  describe('форма отбора живёт в SQL', () => {
    /**
     * Эти утверждения — про ТЕКСТ запроса, и они честно слабые: заглушка SQL
     * не исполняет. Поведение тех же условий проверяется исполнением в
     * provisioning.integration.spec.ts (51б — потолок со спящими, 51в —
     * accepts_new, 51з — счёт по СВОЕЙ машине). Здесь они стоят, чтобы правка,
     * убравшая условие целиком, краснела и без живой базы.
     */
    let sql: string;

    beforeEach(async () => {
      const { pg, calls } = registry({ id: 'own', audience: 'own' });
      await svcOn(pg).pickForNewProduct(true);
      sql = calls[0].sql;
    });

    it('потолок сравнивается В БАЗЕ, а не в JavaScript', () => {
      // count(*) приезжает СТРОКОЙ. Сравнение, вынесенное в Node, дало бы
      // '9' < 10 → false и '10' < 9 → false: потолок то запирал бы пустую
      // машину, то не запирал полную.
      expect(sql).toMatch(/count\(\*\)[\s\S]*<\s*h\.capacity/);
    });

    it('потолок считает продукты СВОЕЙ машины и не считает архивные', () => {
      expect(sql).toContain('p.host_id = h.id');
      expect(sql).toContain('p.archived_at IS NULL');
    });

    it('машина, закрытая для новых, в отбор не входит', () => {
      expect(sql).toContain('h.accepts_new');
    });

    it('порядок задан явно: первая по метке, а не по воле планировщика', () => {
      expect(sql).toContain('ORDER BY h.id');
      expect(sql).toContain('LIMIT 1');
    });

    it('строка приезжает даже когда машины не нашлось', () => {
      // Без этого счётчики не доехали бы вместе с отказом — нулевая выборка
      // не несёт ничего, в том числе причин.
      expect(sql).toMatch(/LEFT JOIN chosen c ON true/);
    });
  });

  describe('отказ называет причину', () => {
    it('пустой реестр отличим от переполнения — и текстом, и уровнем', async () => {
      // Состояние ДОСТИЖИМОЕ: 005 нарочно ничего не заводит при незаполненном
      // PRODUCT_HOST_TOKEN. Без отдельного текста владелец пошёл бы добавлять
      // вторую машину вместо того, чтобы дописать переменную.
      const { pg } = registry();

      const e = await refusal(svcOn(pg), true);

      expect(e).toBeInstanceOf(UnprocessableEntityException);
      expect(e.message).toMatch(/не настроен/i);
      expect(logged).toEqual([{ level: 'error', text: expect.stringContaining('реестр машин пуст') }]);
    });

    it('машин этой аудитории нет вовсе — своя причина', async () => {
      // Это сегодняшний прод: машина own есть, клиентской ещё нет (кусок 4б).
      // «Мест нет» отправило бы разбираться с потолками, которых никто не
      // исчерпывал.
      const { pg } = registry({ id: 'own', audience: 'own' });

      const e = await refusal(svcOn(pg), false);

      expect(e.message).toMatch(/не открыт/i);
      expect(logged).toEqual([
        { level: 'error', text: expect.stringContaining('audience=clients') },
      ]);
    });

    it('мест нет — предупреждение, а не ошибка сервера', async () => {
      // Исчерпанный ресурс — не поломка. Но и не тишина: это единственный
      // признак того, что пора добавлять машину.
      const { pg } = registry({ id: 'clients', audience: 'clients', room: false });

      const e = await refusal(svcOn(pg), false);

      expect(e.message).toMatch(/свободных мест/i);
      expect(logged).toEqual([
        { level: 'warn', text: expect.stringContaining('свободных мест нет') },
      ]);
    });

    it('все три причины различимы между собой', async () => {
      // Три отдельных теста выше зелены и у реализации, которая отдаёт один и
      // тот же текст трижды: каждый смотрит только на свой регексп.
      const texts = await Promise.all([
        refusal(svcOn(registry().pg), true),
        refusal(svcOn(registry({ id: 'own', audience: 'own' }).pg), false),
        refusal(svcOn(registry({ id: 'c', audience: 'clients', room: false }).pg), false),
      ]).then((es) => es.map((e) => e.message));

      expect(new Set(texts).size).toBe(3);
    });

    it('счётчики приезжают СТРОКАМИ, и это не превращает пустой реестр в переполнение', async () => {
      // `row.total === 0` ложно всегда: bigint едет строкой. Мутация, снявшая
      // Number(), уводит пустой реестр в ветку «мест нет» — то есть владелец
      // читает про исчерпанные машины, которых в реестре ни одной.
      const pg = {
        query: jest.fn(async () => ({
          rows: [{ id: null, public_ip: null, domain_suffix: null, total: '0', in_audience: '0' }],
        })),
      };

      const e = await refusal(svcOn(pg), true);

      expect(e.message).toMatch(/не настроен/i);
    });

    it('отказ — не 409: этим кодом кабинет называет занятый слаг', async () => {
      // ИЗМЕРЕНО в spirits_front: explain() в ProductsListView.tsx разбирает
      // код, а не текст, и на 409 показывает «Этот адрес уже занят — выберите
      // другой». Владелец переименовывал бы продукт бесконечно. Всё, что
      // `>= 500`, кабинет глушит своей формулировкой «Сервер не принял
      // продукт» — причина пропала бы тоже. 422 попадает в ветку, которая
      // печатает наш текст.
      const { pg } = registry();

      const e = await refusal(svcOn(pg), true);

      expect(e.getStatus()).toBe(422);
    });

    it('ни один отказ не предлагает попробовать позже', async () => {
      // Ни одна из трёх причин сама не пройдёт. «Попробуйте позже» означает
      // человека, который жмёт кнопку сутками и не пишет в поддержку, — отказ
      // становится невидимым с обеих сторон.
      for (const r of [registry(), registry({ id: 'own', audience: 'own' })]) {
        const e = await refusal(svcOn(r.pg), false);
        expect(e.message).not.toMatch(/позже|повтор/i);
      }
    });

    it('в текст для браузера не уезжают ни метки машин, ни их число', async () => {
      // Внутренняя топология не показывается в браузере — то же правило, по
      // которому из выборки кабинета вычеркнуты host_ip и checkout_path. В
      // журнал она при этом уезжает вся.
      const { pg } = registry({ id: 'own', audience: 'own' }, { id: 'clients-2', audience: 'clients', room: false });

      const e = await refusal(svcOn(pg), false);

      expect(e.message).not.toContain('clients-2');
      expect(e.message).not.toContain('audience');
      expect(logged[0].text).toContain('audience=clients');
    });
  });
});
