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
  over: {
    stale?: any[];
    silent?: any[];
    updateRowCount?: number;
    onUpdate?: (c: Call) => void;
  } = {},
) {
  const calls: Call[] = [];
  const pg = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      if (/^\s*SELECT/i.test(sql)) return { rows, rowCount: rows.length };
      if (/^\s*WITH/i.test(sql))
        return { rows: over.stale ?? [], rowCount: (over.stale ?? []).length };
      over.onUpdate?.({ sql, params });
      // `over.silent` заполняют только тесты, зовущие failStaleProvisioning в
      // одиночку, — там UPDATE может быть только вторым запросом таймаута.
      // rowCount по умолчанию 1: перевод в running читает именно его, и
      // подстановка нуля означала бы «запись никого не нашла».
      return { rows: over.silent ?? [], rowCount: over.updateRowCount ?? 1 };
    }),
  };
  // Реестр машин БРОСАЕТ при обращении: перевод в running и сборщик зависших
  // машину не выбирают — это дело одного только create(). Правдоподобная
  // заглушка молча приняла бы запрос к реестру на каждом обороте таймера.
  const hosts = {
    pickForNewProduct: jest.fn(() => {
      throw new Error('выбор машины здесь не зовётся: он живёт только в create()');
    }),
  };
  const svc = new ProvisioningService(pg as any, {} as any, hosts as any);
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
/** Вторая ветка таймаута: единственный UPDATE, когда зван только он. */
const silentQuery = (calls: Call[]) => calls.find((c) => /^\s*UPDATE/i.test(c.sql))!;

/**
 * ДОМЕН И СЛАГ РАЗНЫЕ, и не выводятся один из другого. Проба собирает адрес из
 * `products.domain`, а не из слага плюс зона: зона своя у каждой машины
 * реестра, и склейка проверяла бы продукт клиентской машины по адресу в зоне
 * владельца. На фикстуре вида `slug: 's', domain: 's.p.linkeon.io'` обе
 * реализации неотличимы — поэтому домен здесь в чужой зоне.
 */
const site = (over: any = {}) => ({
  id: 'p-1',
  slug: 's',
  kind: 'site',
  domain: 's.c.linkeon.io',
  runner_seen_at: new Date(),
  ...over,
});

describe('ProvisioningService.promoteReady', () => {
  it('сайт без heartbeat не переводится, даже если отвечает', async () => {
    const { svc, calls } = makeService([site({ runner_seen_at: null })]);

    await expect(svc.promoteReady()).resolves.toBe(0);

    expect(promotions(calls)).toEqual([]);
  });

  it('протухший heartbeat связью не считается', async () => {
    // Штатный ход повтора: claimJob повернул runner_token_hash, старый раннер
    // аутентифицироваться больше не может и отметку не двигает, а прошлое
    // значение остаётся в строке навсегда. Старая версия сайта при этом
    // отвечает 200. Измерено: продукт объявлялся рабочим, хотя новый раннер
    // не поднялся и ходы уезжали в никого.
    const { svc, calls } = makeService([
      site({ runner_seen_at: new Date(Date.now() - 9 * 24 * 3600 * 1000) }),
    ]);

    await expect(svc.promoteReady()).resolves.toBe(0);

    expect(promotions(calls)).toEqual([]);
  });

  it('heartbeat минутной давности ещё считается связью', async () => {
    // Порог не может быть тесным: запись отметки в turns.touchRunner
    // загрублена до одного раза в 30 секунд, long-poll держится до 35 секунд.
    // Убивает порог в 30 секунд — с ним живой продукт мигал бы.
    const { svc, calls } = makeService([site({ runner_seen_at: new Date(Date.now() - 60_000) })]);

    await svc.promoteReady();

    expect(promotions(calls)).toHaveLength(1);
  });

  it('heartbeat пятиминутной давности связью не считается', async () => {
    // Убивает разболтанный порог (час, сутки): пять минут молчания — это уже
    // мёртвый раннер, а не пауза между опросами.
    const { svc, calls } = makeService([
      site({ runner_seen_at: new Date(Date.now() - 5 * 60_000) }),
    ]);

    await svc.promoteReady();

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

  it('запись сверяет состояние сама, а не полагается на выборку', async () => {
    // Между выборкой и записью проходит вся проба — до PROBE_TIMEOUT_MS, и
    // всё это время состояние продукта может поменять кто угодно. Измерено на
    // PostgreSQL 16, три исхода незащищённой записи: «повторить» во время
    // пробы уводит продукт в running и задание не выдаётся уже никогда;
    // таймаут во время пробы хоронит продукт, а вернувшаяся проба воскрешает
    // его с затёртой причиной; архивация во время пробы даёт archived_at при
    // статусе running.
    const { svc, calls } = makeService([site()]);

    await svc.promoteReady();

    const sql = promotions(calls)[0].sql;
    expect(sql).toMatch(/status\s*=\s*'provisioning'/);
    expect(sql).toMatch(/archived_at\s+IS\s+NULL/i);
    expect(sql).toMatch(/NOT\s+EXISTS/i);
    expect(sql).toMatch(/j\.product_id\s*=\s*products\.id/);
    expect(sql).toMatch(/j\.status\s+IN\s*\('queued','running'\)/);
  });

  it('не засчитывает перевод, которого не было', async () => {
    // rowCount = 0 означает, что защита в записи сработала: состояние успело
    // измениться. Безусловный promoted++ рапортовал бы об оживших продуктах,
    // которых нет, и первый признак срабатывания защиты пропал бы.
    const { svc } = makeService([site()], undefined, { updateRowCount: 0 });

    await expect(svc.promoteReady()).resolves.toBe(0);
  });

  it('перевод снимает причину прошлого отказа', async () => {
    // Без этого карточка ожившего продукта продолжает показывать ошибку
    // предыдущей попытки, а provision_error переписывается только следующим
    // отказом — то есть висит до конца жизни продукта.
    const { svc, calls } = makeService([site()]);

    await svc.promoteReady();

    expect(promotions(calls)[0].sql).toMatch(/provision_error\s*=\s*NULL/);
  });

  it('перевод снимает и признак сна', async () => {
    // Разбуженный продукт с надписью «не хватило токенов на аренду» в
    // карточке — это работающий продукт, который до конца жизни объясняет,
    // почему он не работает. Колонку переписывает только новое усыпление.
    const { svc, calls } = makeService([site()]);

    await svc.promoteReady();

    expect(promotions(calls)[0].sql).toMatch(/sleep_reason\s*=\s*NULL/);
  });

  it('спящий берётся в отбор наравне с заводящимся', async () => {
    // ДЫРА, КОТОРУЮ ЭТО ЗАКРЫВАЕТ. Отбор был только по 'provisioning', и
    // разбуженный продукт в running не возвращался сам НИКОГДА: агент поднял
    // контейнер, отчитался, задание закрылось — и продукт остался спящим.
    // Аренду он не платит (списание берёт running/degraded), правок не
    // принимает (turns.enqueue требует running), гасить его больше нечем —
    // заданий на него нет. Контейнер живой, продукт мёртвый, ошибки нигде.
    const { svc, calls } = makeService([site()]);

    await svc.promoteReady();

    for (const sql of [scan(calls).sql, promotions(calls)[0].sql]) {
      expect(sql).toMatch(/status\s*=\s*'provisioning'\s*OR\s*\(\s*status\s*=\s*'sleeping'/);
    }
  });

  it('спящего пускает только ПОСЛЕДНЕЕ задание — удавшееся пробуждение', async () => {
    // Два отдельных сторожа, и оба нужны.
    //
    // Без условия вообще: спящий продукт, чей контейнер почему-то не погас
    // (сон отказал, агент умер на полпути), даёт живой раннер и живой ответ —
    // и сам возвращался бы в running, снова начиная платить аренду, которой
    // не хватило. Продукт мигал бы между статусами с суточным периодом.
    //
    // Через EXISTS вместо «последнего»: `EXISTS (kind='wake' AND
    // status='done')` истинен НАВСЕГДА после первого удачного пробуждения, и
    // продукт, уснувший во второй раз, воскресал бы сам на ближайшем тике.
    const { svc, calls } = makeService([site()]);

    await svc.promoteReady();

    for (const sql of [scan(calls).sql, promotions(calls)[0].sql]) {
      expect(sql).toMatch(/j\.kind\s*=\s*'wake'\s+AND\s+j\.status\s*=\s*'done'/);
      expect(sql).toMatch(/ORDER BY j\.created_at DESC[\s\S]*?LIMIT 1/);
      expect(sql).not.toMatch(/EXISTS\s*\(\s*SELECT[\s\S]*?j\.kind\s*=\s*'wake'/);
      // Трёхзначная логика: подзапрос без строк даёт NULL, а NULL в AND —
      // это не «нет». Явный false вместо надежды на «сойдёт».
      expect(sql).toMatch(/COALESCE\(\(/);
    }
  });

  it('проба идёт по публичному адресу продукта и со сроком', async () => {
    // ПУБЛИЧНЫЙ адрес, не 127.0.0.1: до петли на хосте бэкенд не дотянется, а
    // заодно ответ подтверждает, что vhost заведён и TLS работает.
    //
    // АДРЕС БЕРЁТСЯ ИЗ products.domain ЦЕЛИКОМ. Слаг здесь нарочно не сходится
    // с доменом: склейка «слаг плюс зона из константы» дала бы
    // `selyanska.p.linkeon.io`, то есть проверку продукта по адресу чужой
    // машины — ответа нет никогда, и через десять минут сборщик зависших
    // хоронит исправный сайт.
    const probe = jest.fn(async () => ({ status: 200 }));
    const { svc } = makeService([site({ slug: 'selyanska', domain: 'selyanska.c.linkeon.io' })], probe);

    await svc.promoteReady();

    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe.mock.calls[0][0]).toBe('https://selyanska.c.linkeon.io/health');
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
      // domain у бота NULL по форме, а не по недосмотру: входящих соединений
      // он не принимает. Ветка «сайт без домена» его касаться не должна.
      [{ id: 'p-2', slug: 'b', kind: 'bot', domain: null, runner_seen_at: new Date() }],
      probe,
    );

    await svc.promoteReady();

    expect(probe).not.toHaveBeenCalled();
    expect(promotions(calls).map((c) => c.params)).toEqual([['p-2']]);
  });

  it('выборка забирает domain: без него пробу собирать не из чего', async () => {
    // Колонка, пропавшая из перечисления, не ломает ни одного запроса — она
    // приезжает undefined, и КАЖДЫЙ сайт становится «сайтом без домена». То
    // есть переводов не будет вовсе, а в логе будет ошибка про пустую колонку,
    // которая в базе заполнена.
    const { svc, calls } = makeService([]);

    await svc.promoteReady();

    expect(scan(calls).sql).toContain('products.domain');
  });

  it('сайт без домена не переводится, не опрашивается и оставляет строку в логе', async () => {
    // Адрес пробы больше не угадывается из слага: зона своя у каждой машины.
    // Пустой domain означает продукт, до которого не может дойти и владелец —
    // ссылку в кабинете рисуют из той же колонки. Молчаливый пропуск отправил
    // бы его читать через десять минут про истёкший срок.
    const probe = jest.fn(async () => ({ status: 200 }));
    const { svc, calls } = makeService([site({ domain: null })], probe);
    const err = jest.spyOn((svc as any).logger, 'error').mockImplementation(() => undefined);

    await expect(svc.promoteReady()).resolves.toBe(0);

    expect(probe).not.toHaveBeenCalled();
    expect(promotions(calls)).toEqual([]);
    expect(err.mock.calls.map(String).join('\n')).toMatch(/пустой domain/);
  });

  it('пустая строка в domain — то же самое, а не адрес https:///health', async () => {
    // `if (!p.domain)` против `if (p.domain === null)`: пустая строка собрала
    // бы `https:///health`, а это не отказ DNS, а мгновенный TypeError внутри
    // fetch — то есть пойманное молчание вместо строки о причине.
    const probe = jest.fn(async () => ({ status: 200 }));
    const { svc } = makeService([site({ domain: '' })], probe);
    jest.spyOn((svc as any).logger, 'error').mockImplementation(() => undefined);

    await svc.promoteReady();

    expect(probe).not.toHaveBeenCalled();
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

  it('продукт с незакрытым заданием не переводится, даже если отвечает', async () => {
    // Повтор поверх работающего сайта: старый раннер шлёт heartbeat, старая
    // версия отвечает 200. Перевод в running отнял бы у claimJob право выдать
    // задание (там EXISTS по status='provisioning'), и повтор умер бы молча:
    // кнопка нажата, ничего не произошло, ошибки нет.
    //
    // ГРАНИЦА: pg замокан, отбор строк здесь не исполняется — сторожится
    // форма условия. Что оно действительно отсекает повтор и действительно
    // пропускает первичное заведение с закрытым заданием, измерено на
    // PostgreSQL 16 (promotescratch на тестовой ноде).
    const { svc, calls } = makeService([]);

    await svc.promoteReady();

    const sql = scan(calls).sql;
    expect(sql).toMatch(/NOT\s+EXISTS/i);
    expect(sql).toMatch(/FROM\s+product_provision_jobs\s+j/i);
    // Скоррелировано ИМЕННО с этим продуктом: без сверки product_id одно
    // чужое активное задание запирало бы весь реестр.
    expect(sql).toMatch(/j\.product_id\s*=\s*products\.id/);
    // Именно незакрытые. Со списком done/failed выборка пустела бы навсегда,
    // и в running не выходил бы уже никто.
    expect(sql).toMatch(/j\.status\s+IN\s*\('queued','running'\)/);
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

  it('хоронит и продукт с ЗАКРЫТЫМ заданием, который так и не ожил', async () => {
    // Первая ветка ходит по заданиям и такой продукт не видит: агент
    // отчитался об успехе, задание в done, адрес молчит (сертификат не
    // выписан, vhost не тот, контейнер в перезапуске) — и продукт остаётся в
    // provisioning НАВСЕГДА. Тупик, ради выхода из которого написан файл,
    // просто на шаг позже. Измерено на PostgreSQL 16.
    const { svc, calls } = makeService([]);

    await svc.failStaleProvisioning();

    const sql = silentQuery(calls).sql;
    expect(sql).toMatch(/UPDATE\s+products\s+p/i);
    expect(sql).toMatch(/p\.status\s*=\s*'provisioning'/);
    // Активное задание — не этот случай: им занимается первая ветка, а здесь
    // такой продукт похоронили бы, не дав агенту доработать.
    expect(sql).toMatch(/NOT\s+EXISTS/i);
    expect(sql).toMatch(/j\.status\s+IN\s*\('queued','running'\)/);
    // Срок по САМОМУ СВЕЖЕМУ заданию, иначе повтор старого продукта умирает
    // из-за девятидневной давности первой попытки.
    expect(sql).toMatch(/max\(COALESCE\(j\.started_at,\s*j\.created_at\)\)/);
    expect(sql).toMatch(/interval\s*'10 minutes'/);
    expect(sql).toMatch(/archived_at\s+IS\s+NULL/i);
    // Утверждение из первой ветки, перенесённое сюда: срок считается по
    // заданию, а p.created_at — только фолбэк.
    expect(sql).not.toMatch(/p\.created_at\s*</);
    // И именно ВТОРЫМ операндом COALESCE. Перестановка местами — не описка:
    // измерено, что с ней повтор девятидневного продукта хоронится через
    // десять секунд после закрытия задания. Сам фолбэк снимать тоже нельзя —
    // измерено, что без него продукт без задания не хоронится никогда
    // (99 минут в provisioning).
    expect(sql).toMatch(
      /COALESCE\(\(SELECT max\(COALESCE\(j\.started_at,\s*j\.created_at\)\)[\s\S]*?\),\s*p\.created_at\)/,
    );
  });

  it('причина отличает молчащий раннер от неотчитавшегося агента', async () => {
    // Продукт, который ОТВЕЧАЕТ, с надписью «не уложился в срок» — это
    // владелец, видящий рабочий сайт и текст про таймаут. Если раннер на
    // связи, правда другая, и написать надо её.
    const { svc, calls } = makeService([]);

    await svc.failStaleProvisioning();

    for (const sql of [staleQuery(calls).sql, silentQuery(calls).sql]) {
      expect(sql).toMatch(/CASE[\s\S]*WHEN\s+p\.runner_seen_at\s*>\s*now\(\)\s*-/i);
      expect(sql).toMatch(/ELSE/i);
      // Порог живости уезжает в SQL текстом, собранным из миллисекундной
      // константы. Пересчёт в секунды — не формальность: 120000 секунд это
      // 33 часа, и раннер, молчащий час, объявлялся бы «на связи». Сегодня
      // цена ошибки — слово в карточке; первый же перенос константы в WHERE
      // сделает ту же тысячекратную ошибку ошибкой СОСТОЯНИЯ.
      expect(sql).toContain("interval '120 seconds'");
    }
    // Тексты в двух ветках CASE обязаны РАЗЛИЧАТЬСЯ, иначе CASE — декорация.
    //
    // Достаются ИМЕННО операнды THEN и ELSE. Первая редакция этой проверки
    // собирала все строки в кавычках регуляркой /'([^']{20,})'/g и была
    // ложно-зелёной: кавычки в SQL спариваются как 1-я со 2-й, 3-я с 4-й, и
    // регулярка вырезала куски КОДА между литералами, а не сами литералы.
    // Мутация «сделать оба текста одинаковыми» её пережила.
    //
    // Одного «различаются» тоже мало: ПЕРЕСТАНОВКА веток проходила зелёной, а
    // означает она ровно ту ложь, ради которой CASE и написан — живой раннер
    // получал «срок заведения истёк», мёртвый «агент не отчитался». Поэтому
    // ниже пришпилено НАПРАВЛЕНИЕ: THEN — ветка живого раннера.
    const stale = staleQuery(calls).sql.match(/THEN\s+'([^']+)'\s*\n?\s*ELSE\s+'([^']+)'/);
    expect(stale).not.toBeNull();
    expect(stale![1]).not.toBe(stale![2]);
    expect(stale![1].length).toBeGreaterThan(10);
    expect(stale![1]).toMatch(/агент не отчитался/);
    expect(stale![2]).toMatch(/срок заведения истёк/);

    const silent = silentQuery(calls).sql.match(/THEN\s+'([^']+)'\s*\n?\s*ELSE\s+'([^']+)'/);
    expect(silent).not.toBeNull();
    expect(silent![1]).not.toBe(silent![2]);
    expect(silent![1].length).toBeGreaterThan(10);
    expect(silent![1]).toMatch(/раннер на связи/);
    expect(silent![2]).toMatch(/раннер не выходит на связь/);
  });

  it('оба запроса таймаута уходят даже когда хоронить нечего', async () => {
    // Убивает «сделать вторую ветку по остаточному принципу»: если она
    // вызывается только при непустой первой, продукт с закрытым заданием не
    // будет похоронен никогда — первая ветка про него ничего не знает.
    const { svc, calls } = makeService([]);

    await svc.failStaleProvisioning();

    expect(staleQuery(calls)).toBeDefined();
    expect(silentQuery(calls)).toBeDefined();
  });

  it('считает похороненных обеими ветками', async () => {
    const { svc } = makeService([], undefined, {
      stale: [{ slug: 'a' }],
      silent: [{ slug: 'c' }],
    });
    const warn = jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);

    await expect(svc.failStaleProvisioning()).resolves.toBe(2);

    expect(warn.mock.calls[0][0]).toContain('a');
    expect(warn.mock.calls[0][0]).toContain('c');
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

  /** Оборот асинхронный: между двумя методами стоит await. */
  const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  const turn = async (n = 1) => {
    for (let i = 0; i < n; i++) {
      jest.advanceTimersByTime(30_000);
      await flush();
    }
  };

  it('таймер зовёт и перевод в running, и таймаут', async () => {
    svc.onModuleInit();
    await turn();

    expect(promote).toHaveBeenCalled();
    expect(stale).toHaveBeenCalled();
  });

  it('зовёт на каждом обороте, а не однажды', async () => {
    // Убивает «позвать один раз в onModuleInit»: заведение оживало бы только
    // у тех, кто успел к старту процесса.
    svc.onModuleInit();
    await turn(3);

    expect(promote).toHaveBeenCalledTimes(3);
    expect(stale).toHaveBeenCalledTimes(3);
  });

  it('оборот не чаще чем раз в 30 секунд', async () => {
    // Убивает разгон интервала: проба ходит наружу по каждому сайту.
    svc.onModuleInit();
    jest.advanceTimersByTime(29_999);
    await flush();

    expect(promote).not.toHaveBeenCalled();
  });

  it('оборот не наезжает на предыдущий', async () => {
    // PROBE_TIMEOUT_MS ограничивает ОДНУ пробу, а продукты обходятся
    // последовательно: семи заводящихся сайтов с чёрной дырой в DNS хватает,
    // чтобы оборот перерос период таймера. Здесь предыдущий оборот не
    // завершён (микрозадачи не сливались), и такты обязаны пропускаться.
    svc.onModuleInit();
    jest.advanceTimersByTime(90_000);
    await flush();

    expect(promote).toHaveBeenCalledTimes(1);
  });

  it('после долгого оборота такты возобновляются', async () => {
    // Обратная сторона флага занятости: если его забыть снять, таймер умрёт
    // навсегда и молча — тупик той же формы, что и весь этот файл.
    svc.onModuleInit();
    jest.advanceTimersByTime(90_000);
    await flush();
    await turn();

    expect(promote).toHaveBeenCalledTimes(2);
  });

  it('оборот возобновляется и после падения', async () => {
    // Отпускать флаг обязан finally: без него первая же ошибка базы
    // останавливала бы провижининг до перезапуска процесса.
    promote.mockRejectedValue(new Error('pg down'));
    jest.spyOn((svc as any).logger, 'error').mockImplementation(() => undefined);

    svc.onModuleInit();
    await turn(2);

    expect(promote).toHaveBeenCalledTimes(2);
  });

  it('остановка гасит таймер', async () => {
    svc.onModuleInit();
    svc.onModuleDestroy();
    await turn(4);

    expect(promote).not.toHaveBeenCalled();
  });

  it('падение одного метода не отменяет второй и не остаётся необработанным', async () => {
    promote.mockRejectedValue(new Error('pg down'));
    const err = jest.spyOn((svc as any).logger, 'error').mockImplementation(() => undefined);

    svc.onModuleInit();
    await turn();

    expect(stale).toHaveBeenCalled();
    expect(err).toHaveBeenCalled();
  });

  it('таймаут идёт ПОСЛЕ перевода, а не параллельно ему', async () => {
    // Без await между ними таймаут работал одновременно с пробой: пока
    // promoteReady ждал ответа сайта, failStaleProvisioning хоронил тот же
    // продукт. Порядок незачем оставлять случайным.
    const order: string[] = [];
    promote.mockImplementation(async () => {
      order.push('promote:start');
      await Promise.resolve();
      order.push('promote:end');
      return 0;
    });
    stale.mockImplementation(async () => {
      order.push('stale:start');
      return 0;
    });

    svc.onModuleInit();
    await turn();

    expect(order).toEqual(['promote:start', 'promote:end', 'stale:start']);
  });
});
