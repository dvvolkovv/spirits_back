import { ProvisioningService } from './provisioning.service';

type Call = { sql: string; params: any[] };

/**
 * ГРАНИЦА ЭТОГО ФАЙЛА. pg подменён целиком, поэтому SQL здесь НЕ
 * ИСПОЛНЯЕТСЯ: проверяется форма запроса, параметры и порядок вызовов.
 * Что запрос валиден, что CTE `stale` действительно возвращает product_id и
 * что частичный индекс product_provision_jobs_one_active освобождается —
 * меряется на живой базе, здесь сторожится только формой.
 *
 * Разбор запросов в моке идёт по ПЕРВОМУ СЛОВУ оператора (SELECT / WITH), а
 * НЕ по подстроке, которую охраняют утверждения. Ловушка, на которой в этом
 * плане уже горели: если мок ветвится по `status = 'provisioning'`, а тест
 * утверждает наличие того же куска, то мутация, снявшая условие, заодно
 * уводит запрос в безобидную ветку мока — и тест зеленеет ровно тогда, когда
 * защита сломана.
 */
function makeService(
  rows: any[],
  fetchImpl?: any,
  over: { stale?: any[]; onUpdate?: (c: Call) => void } = {},
) {
  const calls: Call[] = [];
  const pg = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      if (/^\s*SELECT/i.test(sql)) return { rows, rowCount: rows.length };
      if (/^\s*WITH/i.test(sql))
        return { rows: over.stale ?? [], rowCount: (over.stale ?? []).length };
      over.onUpdate?.({ sql, params });
      return { rows: [], rowCount: 1 };
    }),
  };
  const svc = new ProvisioningService(pg as any, {} as any);
  (svc as any).fetchFn = fetchImpl ?? (async () => ({ status: 200 }));
  return { svc, calls, pg };
}

/**
 * Переводы в running — КОНКРЕТНЫЕ запросы, а не подстрока в склейке всех.
 * `not.toContain("SET status = 'running'")` по склеенному SQL мимо формы
 * `SET provision_error = NULL, status = 'running'` проходит зелёным.
 */
const promotions = (calls: Call[]) =>
  calls.filter((c) => /UPDATE\s+products/i.test(c.sql) && /status\s*=\s*'running'/.test(c.sql));

const scan = (calls: Call[]) => calls.find((c) => /^\s*SELECT/i.test(c.sql))!;
const staleQuery = (calls: Call[]) => calls.find((c) => /^\s*WITH/i.test(c.sql))!;

const site = (over: any = {}) => ({
  id: 'p-1',
  slug: 's',
  kind: 'site',
  runner_seen_at: new Date(),
  ...over,
});

describe('ProvisioningService.promoteReady', () => {
  it('сайт без heartbeat не переводится, даже если отвечает', async () => {
    const { svc, calls } = makeService([site({ runner_seen_at: null })]);

    await expect(svc.promoteReady()).resolves.toBe(0);

    expect(promotions(calls)).toEqual([]);
  });

  it('сайт с heartbeat, но не отвечающий, не переводится', async () => {
    // Иначе продукт объявляется рабочим, не отвечая: ровно то, что мы
    // ловили сверкой sha в куске 1.
    const { svc, calls } = makeService([site()], async () => ({ status: 502 }));

    await expect(svc.promoteReady()).resolves.toBe(0);

    expect(promotions(calls)).toEqual([]);
  });

  it('сайт с heartbeat и ответом переводится', async () => {
    const { svc, calls } = makeService([site()]);

    await expect(svc.promoteReady()).resolves.toBe(1);

    // Параметр пришпилен позиционно: подстановка слага вместо id или сдвиг
    // на $2 иначе прошли бы зелёными.
    expect(promotions(calls).map((c) => c.params)).toEqual([['p-1']]);
  });

  it('перевод снимает причину прошлого отказа', async () => {
    // Без этого карточка ожившего продукта продолжает показывать ошибку
    // предыдущей попытки, а provision_error переписывается только следующим
    // отказом — то есть висит до конца жизни продукта.
    const { svc, calls } = makeService([site()]);

    await svc.promoteReady();

    expect(promotions(calls)[0].sql).toMatch(/provision_error\s*=\s*NULL/);
  });

  it('проба идёт по публичному адресу продукта и со сроком', async () => {
    // ПУБЛИЧНЫЙ адрес, не 127.0.0.1: до петли на хосте бэкенд не дотянется, а
    // заодно ответ подтверждает, что vhost заведён и TLS работает.
    const probe = jest.fn(async () => ({ status: 200 }));
    const { svc } = makeService([site({ slug: 'selyanska' })], probe);

    await svc.promoteReady();

    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe.mock.calls[0][0]).toBe('https://selyanska.p.linkeon.io/health');
    // Проба существует ради НЕотвечающих адресов: без своего срока чёрная
    // дыра держит тик на дефолтах undici, и следующий тик наезжает на этот.
    expect((probe.mock.calls[0] as any[])[1]?.signal).toBeDefined();
  });

  it('204 считается ответом', async () => {
    // Убивает `res.status === 200`.
    const { svc, calls } = makeService([site()], async () => ({ status: 204 }));

    await svc.promoteReady();

    expect(promotions(calls)).toHaveLength(1);
  });

  it('редирект ответом не считается', async () => {
    // Убивает `res.status < 400`: 301 на страницу-заглушку регистратора —
    // это «домена ещё нет», а не «продукт работает».
    const { svc, calls } = makeService([site()], async () => ({ status: 301 }));

    await svc.promoteReady();

    expect(promotions(calls)).toEqual([]);
  });

  it('упавшая проба не переводит продукт и не роняет прогон', async () => {
    // Отказ DNS/TLS — самый частый вид «сайта ещё нет». Непойманный он унёс
    // бы весь тик, и вместе с ним — все остальные продукты.
    const { svc, calls } = makeService([site()], async () => {
      throw new Error('ENOTFOUND');
    });

    await expect(svc.promoteReady()).resolves.toBe(0);

    expect(promotions(calls)).toEqual([]);
  });

  it('упавшая проба не пишется в лог как ошибка', async () => {
    // «Сайт ещё не отвечает» — штатное состояние заводящегося продукта, а не
    // происшествие. Оборот идёт раз в 30 секунд: без своего catch внутри
    // answers каждый ENOTFOUND всплывал бы наверх и уходил в ERROR по каждому
    // незаведённому сайту дважды в минуту, топя лог, в котором ищут настоящие
    // отказы. Мутация «убрать catch из answers» иначе выживает: внешний
    // per-product catch делает результат тем же и виден только по логу.
    const { svc } = makeService([site()], async () => {
      throw new Error('ENOTFOUND');
    });
    const err = jest.spyOn((svc as any).logger, 'error').mockImplementation(() => undefined);

    await svc.promoteReady();

    expect(err).not.toHaveBeenCalled();
  });

  it('боту публичный адрес не проверяется — его нет', async () => {
    const probe = jest.fn(async () => ({ status: 404 }));
    const { svc, calls } = makeService(
      [{ id: 'p-2', slug: 'b', kind: 'bot', runner_seen_at: new Date() }],
      probe,
    );

    await svc.promoteReady();

    expect(probe).not.toHaveBeenCalled();
    expect(promotions(calls).map((c) => c.params)).toEqual([['p-2']]);
  });

  it('выборка ограничена заводящимися и неархивными', async () => {
    const { svc, calls } = makeService([]);

    await svc.promoteReady();

    const sql = scan(calls).sql;
    expect(sql).toMatch(/status\s*=\s*'provisioning'/);
    // Архивный продукт отвечать может (vhost ещё жив) — и без этого условия
    // воскресал бы в running сам по себе.
    expect(sql).toMatch(/archived_at\s+IS\s+NULL/i);
  });

  it('на пустой выборке ничего не пишет', async () => {
    const { svc, calls } = makeService([]);

    await expect(svc.promoteReady()).resolves.toBe(0);

    expect(calls.filter((c) => /UPDATE/i.test(c.sql))).toEqual([]);
  });

  it('переводится только готовый из нескольких', async () => {
    // Убивает «перевести всё, что выбрала выборка».
    const { svc, calls } = makeService([
      site({ id: 'p-1', slug: 'a', runner_seen_at: null }),
      site({ id: 'p-2', slug: 'b' }),
    ]);

    await expect(svc.promoteReady()).resolves.toBe(1);

    expect(promotions(calls).map((c) => c.params)).toEqual([['p-2']]);
  });

  it('отказ на одном продукте не отменяет остальные', async () => {
    // Один продукт с битым состоянием иначе запирает в provisioning ВСЮ
    // очередь — та же форма молчаливого тупика, ради выхода из которого этот
    // метод и написан.
    const { svc, calls } = makeService(
      [site({ id: 'p-1', slug: 'a' }), site({ id: 'p-2', slug: 'b' })],
      undefined,
      {
        onUpdate: (c) => {
          if (c.params[0] === 'p-1') throw new Error('deadlock detected');
        },
      },
    );

    await expect(svc.promoteReady()).resolves.toBe(1);

    expect(promotions(calls).map((c) => c.params)).toEqual([['p-1'], ['p-2']]);
  });
});

describe('ProvisioningService.failStaleProvisioning', () => {
  it('валит заведение, не уложившееся в срок', async () => {
    const { svc, calls } = makeService([]);

    await svc.failStaleProvisioning();

    const sql = staleQuery(calls).sql;
    expect(sql).toMatch(/status\s*=\s*'failed'/);
    // Срок по ЗАДАНИЮ, а не по продукту: иначе повтор старого продукта
    // умирает в тот же тик, не успев дойти до агента. Условие пришпилено к
    // своему операнду целиком — `toContain("interval '10 minutes'")` рядом с
    // `p.created_at <` прошёл бы зелёным.
    expect(sql).toMatch(
      /COALESCE\(started_at,\s*created_at\)\s*<\s*now\(\)\s*-\s*interval\s*'10 minutes'/,
    );
    expect(sql).not.toMatch(/p\.created_at\s*</);
  });

  it('снимает и само задание, иначе повтор запрещён навсегда', async () => {
    // Частичный индекс product_provision_jobs_one_active держит продукт
    // запертым, пока задание в queued/running: вставка второго падает с
    // duplicate key. Проверено на живой базе.
    const { svc, calls } = makeService([]);

    await svc.failStaleProvisioning();

    const sql = staleQuery(calls).sql;
    expect(sql).toMatch(/UPDATE\s+product_provision_jobs/i);
    expect(sql).toMatch(/status\s+IN\s*\('queued','running'\)/i);
  });

  it('живой продукт не хоронится вместе с просроченным заданием', async () => {
    // Задание могло зависнуть у продукта, который уже в running (повтор
    // поверх работающего). Без сверки статуса таймаут гасил бы рабочий сайт.
    const { svc, calls } = makeService([]);

    await svc.failStaleProvisioning();

    expect(staleQuery(calls).sql).toMatch(/p\.status\s*=\s*'provisioning'/);
  });

  it('возвращает число похороненных и называет их в логе', async () => {
    const { svc } = makeService([], undefined, { stale: [{ slug: 'a' }, { slug: 'b' }] });
    const warn = jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);

    await expect(svc.failStaleProvisioning()).resolves.toBe(2);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('a');
    expect(warn.mock.calls[0][0]).toContain('b');
  });

  it('молчит, когда хоронить нечего', async () => {
    // Тик раз в 30 секунд: лишняя строка на каждом обороте утопила бы лог.
    const { svc } = makeService([]);
    const warn = jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);

    await expect(svc.failStaleProvisioning()).resolves.toBe(0);

    expect(warn).not.toHaveBeenCalled();
  });
});

describe('проводка таймера', () => {
  // В куске 1 сверка sha жила в deploy.ts и была там покрыта, а удаление
  // одной строки в turn.ts отключало защиту целиком, оставляя все 77
  // тестов зелёными. Здесь то же: тесты выше проверяют SQL внутри
  // методов, но не то, что методы кто-то зовёт.
  let svc: ProvisioningService;
  let promote: jest.SpyInstance;
  let stale: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    svc = makeService([]).svc;
    promote = jest.spyOn(svc, 'promoteReady').mockResolvedValue(0);
    stale = jest.spyOn(svc, 'failStaleProvisioning').mockResolvedValue(0);
  });

  afterEach(() => {
    svc.onModuleDestroy();
    jest.useRealTimers();
  });

  it('таймер зовёт и перевод в running, и таймаут', () => {
    svc.onModuleInit();
    jest.advanceTimersByTime(30_000);

    expect(promote).toHaveBeenCalled();
    expect(stale).toHaveBeenCalled();
  });

  it('зовёт на каждом обороте, а не однажды', () => {
    // Убивает «позвать один раз в onModuleInit»: заведение оживало бы только
    // у тех, кто успел к старту процесса.
    svc.onModuleInit();
    jest.advanceTimersByTime(90_000);

    expect(promote).toHaveBeenCalledTimes(3);
    expect(stale).toHaveBeenCalledTimes(3);
  });

  it('оборот не чаще чем раз в 30 секунд', () => {
    // Убивает разгон интервала: проба ходит наружу по каждому сайту.
    svc.onModuleInit();
    jest.advanceTimersByTime(29_999);

    expect(promote).not.toHaveBeenCalled();
  });

  it('остановка гасит таймер', () => {
    svc.onModuleInit();
    svc.onModuleDestroy();
    jest.advanceTimersByTime(120_000);

    expect(promote).not.toHaveBeenCalled();
  });

  it('падение одного метода не отменяет второй и не остаётся необработанным', async () => {
    promote.mockRejectedValue(new Error('pg down'));
    const err = jest.spyOn((svc as any).logger, 'error').mockImplementation(() => undefined);

    svc.onModuleInit();
    jest.advanceTimersByTime(30_000);
    await Promise.resolve();
    await Promise.resolve();

    expect(stale).toHaveBeenCalled();
    expect(err).toHaveBeenCalled();
  });
});
