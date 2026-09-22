import { ConflictException, NotFoundException } from '@nestjs/common';
import * as crypto from 'crypto';
import { ProvisioningService } from './provisioning.service';
import { SecretsService } from './secrets.service';

/**
 * Реестр машин, который БРОСАЕТ при обращении.
 *
 * Ни один метод в этом файле машину под новый продукт не выбирает — это дело
 * одного только create(). Заглушка, отдающая правдоподобную машину, приняла бы
 * молча правку, при которой выдача заданий или сон начинают спрашивать реестр
 * на каждый оборот; такая заглушка «работает» ровно до прода. Отказ здесь
 * громкий и адресный.
 */
const noHosts = () =>
  ({
    pickForNewProduct: jest.fn(() => {
      throw new Error('выбор машины здесь не зовётся: он живёт только в create()');
    }),
  }) as any;

// Предел аккаунта — тоже дело одного только create(). БРОСАЕТ при обращении по
// той же причине, что и реестр выше: молчаливая заглушка приняла бы запрос из
// выдачи заданий или отчёта агента и не сказала бы об этом ни слова.
const noLimits = () =>
  ({
    assertCanCreate: jest.fn(() => {
      throw new Error('предел аккаунта здесь не спрашивают: он живёт только в create()');
    }),
  }) as any;

// Строка, какой её отдаёт финальный SELECT: id задания и id продукта РАЗНЫЕ,
// слаг и форма тоже — иначе перепутанные местами поля проходили бы зелёными.
// Имена ключей — те, что заданы алиасами в запросе: потеря алиаса ломает
// чтение (проверяется отдельно).
const ROW = {
  job_id: 'j-1',
  product_id: 'p-1',
  slug: 's',
  // Имя и слаг РАЗНЫЕ: в каркас продукта уезжает имя, и потеря алиаса или
  // перестановка с слагом на одинаковых значениях была бы невидима.
  name: 'Селянська',
  kind: 'site',
  // Вид ЗАДАНИЯ, а не продукта: `kind` теперь есть у обеих таблиц, и значения
  // взяты разные ('site' против 'provision') ровно затем, чтобы перепутанные
  // местами колонки не проходили зелёными.
  job_kind: 'provision',
  port: null,
  // Признак «токен выпущен» приезжает ИЗ БАЗЫ (i.id IS NOT NULL), а не
  // выводится в коде из вида задания.
  token_issued: true,
  box: Buffer.from('коробка'),
};

function makeService(over: any = {}) {
  const calls: { sql: string; params: any[] }[] = [];
  const pg = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      if (sql.includes("SET status = 'running'") && sql.includes('product_provision_jobs')) {
        return { rows: over.claim ?? [ROW], rowCount: 1 };
      }
      return { rows: [], rowCount: over.rowCount ?? 1 };
    }),
  };
  const secrets = over.secrets ?? { decrypt: jest.fn(() => ({ BOT_TOKEN: 'т' })) };
  return { svc: new ProvisioningService(pg as any, secrets as any, noHosts(), noLimits()), calls, secrets };
}

const sqlOf = (c: { sql: string }[]) => c.map((x) => x.sql).join('\n');
const find = (c: { sql: string; params: any[] }[], needle: string) =>
  c.find((x) => x.sql.includes(needle))!;

/**
 * Отчёт агента — ОДИН оператор, поэтому обе записи лежат в одной строке SQL, и
 * `find(calls, 'UPDATE products')` возвращает её же целиком. Запреты вида «в
 * записи по продукту нет слова X» обязаны спрашивать СВОЙ кусок: замок
 * `AND status = 'running'` в закрытии задания иначе краснит запрет,
 * поставленный на запись по продукту, и блокирует верный код.
 *
 * Заодно это сторож самой формы: обе записи обязаны присутствовать и идти в
 * порядке «сначала задание, потом продукт» — продукт берётся из CTE закрытия,
 * а не наоборот.
 */
const partsOf = (sql: string) => {
  const j = sql.indexOf('UPDATE product_provision_jobs');
  const p = sql.indexOf('UPDATE products');
  expect(j).toBeGreaterThanOrEqual(0);
  expect(p).toBeGreaterThan(j);
  return { job: sql.slice(j, p), product: sql.slice(p) };
};
const jobPart = (c: { sql: string }[]) => partsOf(find(c as any, 'UPDATE products').sql).job;
const productPart = (c: { sql: string }[]) => partsOf(find(c as any, 'UPDATE products').sql).product;

// Ключ из secrets.spec.ts: НЕоднородный намеренно, на 'a'.repeat(64) выживала
// мутация «ключ из первой половины hex дважды».
const KEY = '00112233445566778899aabbccddeeff0f1e2d3c4b5a69788796a5b4c3d2e1f0';
const realSecrets = () =>
  new SecretsService({
    get: (k: string) => (k === 'PRODUCT_SECRETS_KEY' ? KEY : undefined),
  } as any);

/**
 * ГРАНИЦА ЭТОГО ФАЙЛА. Мок подменяет pg целиком, поэтому SQL здесь НЕ
 * ИСПОЛНЯЕТСЯ: всё, что можно проверить, — форма запроса и параметры. Ровно
 * поэтому мок отдаёт свою строку независимо от того, что перечислено в
 * RETURNING, и потеря алиаса `AS box` была невидима всему файлу, пока это не
 * измерили на живой базе.
 *
 * Что проверено на настоящем PostgreSQL 16 (provscratch на тестовой ноде) и
 * потому здесь сторожится только формой:
 *   - запрос выдачи валиден: три скоррелированных подзапроса, FOR UPDATE
 *     SKIP LOCKED внутри CTE;
 *   - два одновременных claim разошлись по разным заданиям;
 *   - на пустой очереди новый хеш не достаётся ни одному продукту;
 *   - EXISTS отсекает задания похороненных и архивных продуктов;
 *   - `AND status = 'running'` превращает повторный отчёт в UPDATE 0, и
 *     работающий продукт остаётся нетронутым;
 *   - `SET port = $2` при NULL сносит порт, `COALESCE($2, port)` — нет.
 */

describe('ProvisioningService.claimJob', () => {
  it('берёт задание атомарно и не отдаёт его второму агенту', async () => {
    const { svc, calls } = makeService();

    await svc.claimJob('own');

    const sql = sqlOf(calls);
    expect(sql).toContain('FOR UPDATE');
    expect(sql).toContain('SKIP LOCKED');
    expect(sql).toContain("status = 'queued'");
    // toContain — принадлежность, а не соседство. `FOR UPDATE` в одном месте и
    // `SKIP LOCKED` в комментарии рядом дали бы обычную блокирующую выборку,
    // при которой второй агент ЖДЁТ то же задание и получает его следом.
    // Измерено на живой базе: без SKIP LOCKED второй claim ждал 2.08 с вместо
    // 0.06 с и получил ТО ЖЕ задание.
    expect(calls[0].sql).toMatch(/FOR UPDATE\s+SKIP LOCKED/);
    expect(calls[0].sql).toMatch(/LIMIT 1/);
  });

  it('очередь читается ТОЛЬКО по queued', async () => {
    // `WHERE status = 'queued' OR status = 'running'` проверку выше проходит:
    // подстрока "status = 'queued'" на месте. А означает это, что уже выданное
    // задание достаётся второму агенту — ровно то, от чего поставлен
    // SKIP LOCKED. Дизъюнкции в этом запросе нет нигде и быть не должно.
    const { svc, calls } = makeService();

    await svc.claimJob('own');

    expect(calls[0].sql).not.toMatch(/\bOR\b/);
  });

  it('очередь разбирается с головы: старшее задание первым', async () => {
    // `ORDER BY created_at DESC` — это LIFO: продукт, заведённый первым, ждёт
    // за всеми, кто пришёл после, и при непрерывном потоке не дожидается
    // никогда. Проверка на присутствие `ORDER BY created_at` совпадает и с
    // DESC, поэтому направление сторожится отдельно.
    const { svc, calls } = makeService();

    await svc.claimJob('own');

    expect(calls[0].sql).toMatch(/ORDER BY\s+j\.created_at\s+ASC/);
    expect(calls[0].sql).not.toMatch(/DESC/i);
  });

  it('задание похороненного или архивного продукта не выдаётся', async () => {
    // Без EXISTS агент разворачивает то, что система считает мёртвым:
    // задание переживает и перевод продукта в failed, и архивацию. Измерено
    // на живой базе — задания продуктов dead и arch оставались queued только
    // благодаря этому условию.
    const { svc, calls } = makeService();

    await svc.claimJob('own');

    expect(calls[0].sql).toMatch(/EXISTS\s*\(\s*SELECT 1 FROM products p/);
    expect(calls[0].sql).toMatch(/p\.status = 'provisioning'/);
    expect(calls[0].sql).toMatch(/p\.archived_at IS NULL/);
  });

  it('задание отбирается по МЕТКЕ МАШИНЫ, и метка уезжает вторым параметром', async () => {
    // Сегодня без этого условия задание достаётся тому, кто первым спросил:
    // продукт клиента разворачивается на машине владельца, где его каталога
    // нет. Метка спрашивается у ПРОДУКТА — у задания своей колонки машины нет.
    const { svc, calls } = makeService();

    // Не 'own': на метке машины владельца зелёной прошла бы константа в
    // запросе, которая пока была бы ещё и верной.
    await svc.claimJob('clients');

    expect(calls[0].sql).toMatch(/p\.host_id = \$2/);
    expect(calls[0].params[1]).toBe('clients');
  });

  it('метка сверяется НАД разбором по виду задания, а не внутри него', async () => {
    // Условие, уехавшее в ветку CASE `WHEN 'provision'`, проходит главный
    // сценарий зелёным и выпускает на чужую машину сон и пробуждение: сон
    // гасит там контейнер, которого нет, отчитывается отказом, а продукт
    // остаётся работать неоплаченным. Поведенческий сторож — 46в на живой базе;
    // здесь пришпилен порядок условий, потому что мок SQL не исполняет.
    const { svc, calls } = makeService();

    await svc.claimJob('own');

    expect(calls[0].sql).toMatch(
      /p\.archived_at IS NULL[\s\S]*?AND p\.host_id = \$2[\s\S]*?AND CASE j\.kind/,
    );
  });

  it('выдача без метки машины падает ГРОМКО и до базы не доходит', async () => {
    // `p.host_id = NULL` в SQL не равно ничему: claimJob без метки вернул бы
    // «очередь пуста» на любой непустой очереди. Агент опрашивал бы нас вечно и
    // молча не получал работы — ровно тот отказ без единого признака, ради
    // которого написан весь кусок. Пустая строка и undefined проверяются обе:
    // первая — забытый параметр в контроллере, вторая — снятый гвард.
    for (const bad of ['', undefined as any, null as any]) {
      const { svc, calls } = makeService();

      await expect(svc.claimJob(bad)).rejects.toThrow(/метк/i);

      expect(calls).toHaveLength(0);
    }
  });

  it('выданное задание помечается начатым, а не только «running»', async () => {
    // НАЙДЕНО ИЗМЕРЕНИЕМ: снятие `started_at = now()` переживали все проверки
    // файла. Колонка нужна ровно для одного — понять, сколько задание висит.
    // Без неё задание, застрявшее в 'running' (агент умер посреди
    // развёртывания), неотличимо от только что выданного: сборщик зависших не
    // назовёт ни одно просроченным, а частичный индекс one_active держит
    // продукт запертым. Отказ молчаливый — статус-то правильный.
    const { svc, calls } = makeService();

    await svc.claimJob('own');

    expect(calls[0].sql).toMatch(/started_at\s*=\s*now\(\)/);
  });

  it('выдача задания и выпуск токена — ОДИН оператор', async () => {
    // Двумя запросами на пуле (без транзакции — BEGIN через пул в этом
    // репозитории уже рапортовал об откате, которого не было) падение второго
    // оставляло бы задание в 'running' с токеном, не доехавшим до агента, а
    // частичный индекс one_active запирал бы продукт до сборщика зависших.
    // Тот же класс, что resolveOrCreate в identity.
    const { svc, calls } = makeService();

    await svc.claimJob('own');

    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toMatch(/^\s*WITH\b/);
  });

  it('выпускает НОВЫЙ runner-токен при выдаче задания', async () => {
    // Старый восстановить нельзя: в базе только sha256. Переиспользование
    // означало бы, что раннер в новом контейнере не аутентифицируется, —
    // и отказ был бы молчаливым.
    const { svc, calls } = makeService();

    const job = await svc.claimJob('own');

    expect(job!.runnerToken).toMatch(/^[0-9a-f]{64}$/);
    expect(sqlOf(calls)).toContain('runner_token_hash');
    // Обе проверки выше ЛОЖНО ЗЕЛЁНЫЕ на самой правдоподобной мутации —
    // отдать раннеру то, что лежит в базе. Хеш — тоже 64 hex, и слово
    // runner_token_hash в SQL тоже появляется. Раннер предъявил бы хеш,
    // RunnerGuard посчитал бы от него sha256 ещё раз и не нашёл продукт:
    // молчаливый отказ ровно того вида, который эта проверка обязана
    // предотвращать.
    // Список ЦЕЛИКОМ, а не `params[0]`: порядок параметров — это связь с
    // текстом запроса ($1 — хеш, $2 — метка машины), и перепутанные местами они
    // дают сверку host_id с хешем токена, то есть пустую выдачу на любой
    // очереди. Молча.
    expect(calls[0].params).toEqual([
      crypto.createHash('sha256').update(job!.runnerToken).digest('hex'),
      'own',
    ]);
    // Открытый токен в базу не ложится ни при каком раскладе.
    expect(calls[0].params).not.toContain(job!.runnerToken);
  });

  it('токен достаётся продукту ВЫДАННОГО задания, а не найденному по слагу', async () => {
    // `WHERE slug = $1` обновляет ноль строк: раннер получает токен, который
    // не аутентифицирует ничего, а сам claim при этом успешен. На живой базе
    // это ещё и типовая ошибка (slug text против product_id uuid), но здесь
    // мок SQL не исполняет — сторожим форму: продукт выбирается ровно из
    // выданного задания.
    const { svc, calls } = makeService();

    await svc.claimJob('own');

    expect(calls[0].sql).toMatch(
      /UPDATE products\s+SET runner_token_hash = \$1\s+WHERE id IN \(SELECT c\.product_id FROM claimed c WHERE c\.kind = 'provision'\)/,
    );
  });

  it('каждое читаемое поле названо в запросе своим алиасом', async () => {
    // САМАЯ ДОРОГАЯ ИЗ ПРОПУЩЕННЫХ: мок отдаёт свою строку независимо от того,
    // что перечислено в RETURNING, поэтому потеря алиаса невидима всему файлу.
    // Подтверждено на PostgreSQL: без `AS box` колонка приезжает как
    // secrets_encrypted, row.box становится undefined — и бот уезжает в
    // контейнер БЕЗ ТОКЕНА, молча, с успешным заведением.
    //
    // `p.slug AS slug` избыточен синтаксически и намеренно оставлен: алиас
    // выписан у всех полей, чтобы сторож был однородным.
    //
    // ДВА `kind` В ОДНОМ ЗАПРОСЕ. У задания это вид работы, у продукта —
    // форма. Без разных алиасов (`c.kind AS job_kind` против `p.kind AS kind`)
    // одно значение затирало бы другое в строке результата, и агент получал бы
    // 'site' там, где ждёт 'provision'.
    const { svc, calls } = makeService();

    await svc.claimJob('own');

    const sql = calls[0].sql;
    expect(sql).toMatch(/secrets_encrypted AS box/);
    expect(sql).toMatch(/c\.id AS job_id/);
    expect(sql).toMatch(/c\.kind AS job_kind/);
    expect(sql).toMatch(/p\.id AS product_id/);
    expect(sql).toMatch(/p\.slug AS slug/);
    expect(sql).toMatch(/p\.name AS name/);
    expect(sql).toMatch(/p\.kind AS kind/);
    expect(sql).toMatch(/p\.port AS port/);
    expect(sql).toMatch(/p\.secrets_encrypted AS box/);
    expect(sql).toMatch(/\(i\.id IS NOT NULL\) AS token_issued/);
  });

  it('токен берётся из 32 случайных байт, а не выводится из данных задания', async () => {
    // Привязка к самому источнику случайности. Проверки «64 hex» и «sha256 от
    // токена уехал параметром» вместе переживают уменьшение энтропии до
    // одного байта: randomBytes(1).toString('hex').repeat(32) — тоже 64 hex, и
    // хеш сойдётся. Перебор 256 вариантов даёт доступ к раннеру.
    const spy = jest.spyOn(crypto, 'randomBytes');
    try {
      const { svc } = makeService();

      const job = await svc.claimJob('own');

      const drawn = spy.mock.results.map((r) => r.value as Buffer).filter(Buffer.isBuffer);
      expect(drawn).toHaveLength(1);
      expect(drawn[0]).toHaveLength(32);
      expect(job!.runnerToken).toBe(drawn[0].toString('hex'));
    } finally {
      spy.mockRestore();
    }
  });

  it('две выдачи одного и того же задания дают разные токены', async () => {
    // Константа вместо случайных байт проходит и «64 hex», и сверку с sha256.
    // Один токен на все продукты означал бы, что раннер любого продукта
    // проходит охрану от имени соседнего.
    const a = await makeService().svc.claimJob('own');
    const b = await makeService().svc.claimJob('own');

    expect(a!.runnerToken).not.toBe(b!.runnerToken);
  });

  it('секреты отдаются расшифрованными', async () => {
    const { svc, secrets } = makeService();

    const job = await svc.claimJob('own');

    expect(secrets.decrypt).toHaveBeenCalled();
    expect(job!.secrets).toEqual({ BOT_TOKEN: 'т' });
    // toHaveBeenCalled ничего не говорит об аргументах, а их тут ровно два и
    // оба содержательные. Вызов одним аргументом (как в первой редакции
    // плана) и вызов с чужим id обе эту проверку переживают.
    expect(secrets.decrypt).toHaveBeenCalledWith(ROW.box, 'p-1');
  });

  it('пустая очередь — не ошибка', async () => {
    const { svc } = makeService({ claim: [] });

    expect(await svc.claimJob('own')).toBeNull();
  });

  it('на пустой очереди ничего не записывается', async () => {
    // Токен считается ДО запроса, чтобы уместиться в один оператор, поэтому
    // слово runner_token_hash в SQL есть всегда. Записи, однако, не
    // происходит: CTE issued обновляет только строки из claimed, а claimed
    // пуста. Проверено на живой базе — третий claim при пустой очереди не
    // оставил свой хеш ни у одного из четырёх продуктов. Здесь сторожим то,
    // что вообще выразимо через мок: второго запроса нет и секреты не
    // трогаются.
    const { svc, calls, secrets } = makeService({ claim: [] });

    await svc.claimJob('own');

    expect(calls).toHaveLength(1);
    expect(secrets.decrypt).not.toHaveBeenCalled();
  });

  it('поля задания не перепутаны местами', async () => {
    // id задания и id продукта — оба uuid, слаг и форма — обе строки.
    // Перестановка любой пары не меняет ни одного утверждения выше: агент
    // развернул бы продукт в каталог с чужим именем и отчитался бы по чужому
    // заданию.
    const { svc } = makeService();

    const job = await svc.claimJob('own');

    expect(job).toEqual({
      jobId: 'j-1',
      productId: 'p-1',
      slug: 's',
      name: 'Селянська',
      kind: 'site',
      jobKind: 'provision',
      port: null,
      runnerToken: expect.stringMatching(/^[0-9a-f]{64}$/),
      secrets: { BOT_TOKEN: 'т' },
    });
  });

  it('имя продукта уезжает агенту вместе с заданием', async () => {
    // Агенту нужно человеческое имя: оно идёт в каркас (заголовок страницы,
    // имя бота), и слаг там не годится — 'my-shop' вместо «Мой магазин».
    // Забытая колонка в CTE issued даёт name: undefined, а каркас с undefined
    // виден только глазами и уже на готовом продукте.
    const { svc, calls } = makeService();

    const job = await svc.claimJob('own');

    expect(job!.name).toBe('Селянська');
    // Поля продукта берутся ПРЯМО ИЗ products, а не из RETURNING правки
    // токена: у сна и пробуждения токен не выпускается, тот CTE пуст, и
    // внутреннее соединение с ним выбросило бы задание целиком — агент
    // получил бы `{ job: null }` при непустой очереди.
    expect(calls[0].sql).toMatch(/JOIN products p ON p\.id = c\.product_id/);
    expect(calls[0].sql).toMatch(/p\.name AS name/);
  });

  it('продукт без секретов не роняет выдачу задания', async () => {
    // secrets_encrypted у продукта без секретов — NULL (задача 3 кладёт именно
    // NULL, а не коробку от {}). decrypt(null) — сырой TypeError, поэтому
    // признак «секретов нет» обязан читаться ДО вызова.
    const { svc, secrets } = makeService({ claim: [{ ...ROW, box: null }] });

    const job = await svc.claimJob('own');

    expect(job!.secrets).toEqual({});
    expect(secrets.decrypt).not.toHaveBeenCalled();
  });
});

describe('claimJob: вид задания', () => {
  it('вид доезжает до агента', async () => {
    // Без вида агент разворачивает продукт заново на задании «усыпить»:
    // каталог занят, отказ, и владелец читает про занятый каталог вместо сна.
    const { svc } = makeService({
      claim: [{ ...ROW, job_kind: 'sleep', token_issued: false, port: 8003 }],
    });

    const job = await svc.claimJob('own');

    expect(job!.jobKind).toBe('sleep');
  });

  it('вид ЗАДАНИЯ не подменяется формой ПРОДУКТА', async () => {
    // `kind` есть у обеих таблиц. Неуточнённая ссылка (или потерянный алиас)
    // кладёт в одно поле значение другого: агент получает 'site' там, где
    // ждёт вид работы, и уезжает в ветку неизвестного вида на каждом задании.
    const { svc } = makeService({
      claim: [{ ...ROW, kind: 'bot', job_kind: 'wake', token_issued: false }],
    });

    const job = await svc.claimJob('own');

    expect([job!.kind, job!.jobKind]).toEqual(['bot', 'wake']);
  });

  it('сон и пробуждение выдаются СПЯЩЕМУ, заведение — заводящемуся', async () => {
    // ТУПИК, КОТОРЫЙ ЭТО ЗАКРЫВАЕТ. Прежнее условие было одно на всех —
    // `p.status = 'provisioning'`, — а сон и пробуждение ставятся продукту в
    // 'sleeping'. Такое задание не выдавалось бы НИКОГДА: висит в очереди,
    // one_active запирает продукт, через 10 минут его хоронит сборщик
    // зависших. Кабинет при этом показывает «спит», контейнер работает,
    // аренда не платится, ошибки нет нигде.
    //
    // Условие сверяется В СВЯЗКЕ с видом, а не списком статусов: `status IN
    // ('provisioning','sleeping')` выдал бы ЗАВЕДЕНИЕ спящему продукту, то
    // есть развернул бы каркас поверх живого каталога клиента.
    const { svc, calls } = makeService();

    await svc.claimJob('own');

    expect(calls[0].sql).toMatch(
      /CASE j\.kind\s+WHEN 'provision' THEN p\.status = 'provisioning'\s+ELSE p\.status = 'sleeping'\s+END/,
    );
  });

  it('на сне и пробуждении токен НЕ выпускается', async () => {
    // Раннер живёт ВНУТРИ контейнера. На пробуждении поднимается тот же
    // процесс с тем же RUNNER_TOKEN в окружении, и повёрнутый хеш означал бы
    // контейнер, который стартовал и не может аутентифицироваться: «разбудили»
    // в мёртвое состояние, лечится только пересозданием.
    const { svc } = makeService({
      claim: [{ ...ROW, job_kind: 'wake', token_issued: false }],
    });

    const job = await svc.claimJob('own');

    // Ключа НЕТ, а не пустая строка: пустая строка — это третье состояние,
    // которое дальше по коду читается как «токен есть, но пустой».
    expect('runnerToken' in job!).toBe(false);
  });

  it('признак выпуска берётся из базы, а не выводится из вида в коде', async () => {
    // Условие выпуска живёт в SQL (`WHERE c.kind = 'provision'`). Повтор этого
    // условия в TypeScript дал бы два места, которые обязаны совпадать, и
    // разъехались бы они молча: агент получил бы токен, которого в базе нет.
    // Здесь вид «заведение», а база говорит «не выпускали» — верить надо базе.
    const { svc } = makeService({ claim: [{ ...ROW, token_issued: false }] });

    expect('runnerToken' in (await svc.claimJob('own'))!).toBe(false);
  });

  it('сну и пробуждению секреты не расшифровываются', async () => {
    // Контейнер уже собран, переменные окружения в нём. Расшифровка здесь
    // гоняла бы секреты клиента по сети на каждое усыпление ни за чем.
    const { svc, secrets } = makeService({
      claim: [{ ...ROW, job_kind: 'sleep', token_issued: false }],
    });

    const job = await svc.claimJob('own');

    expect(job!.secrets).toEqual({});
    expect(secrets.decrypt).not.toHaveBeenCalled();
  });

  it('порт продукта уезжает агенту: пробуждать некуда без него', async () => {
    // Домен возвращают на ТОТ ЖЕ порт, с которого сняли. Знает его только
    // сервер: на хосте порт живёт в остановленном контейнере.
    const { svc } = makeService({
      claim: [{ ...ROW, job_kind: 'wake', token_issued: false, port: 8007 }],
    });

    expect((await svc.claimJob('own'))!.port).toBe(8007);
  });

  it('у заведения порта нет, и это NULL, а не ноль', async () => {
    // Порт при заведении ВЫБИРАЕТ агент. `Number(null)` — это 0, то есть
    // «порт ноль»: наивное приведение превратило бы «порта нет» в законное
    // значение, и wakeProduct пошёл бы ждать ответа на порту 0.
    const { svc } = makeService();

    expect((await svc.claimJob('own'))!.port).toBeNull();
  });
});

describe('claimJob: живой роундтрип через настоящий SecretsService', () => {
  // ЕДИНСТВЕННОЕ место, где SecretsService не мокается. Мок отвечает на любой
  // вызов одинаково, поэтому мимо него проходят и вызов одним аргументом, и
  // расшифровка под чужим id: тест зелёный, а на первом же продукте с
  // секретами провижининг срывается у агента на хосте. Измерено обеими
  // сторонами: в редакции плана (мок без сверки аргументов, живого роундтрипа
  // нет) обе мутации проходили зелёными, 19 из 19.

  it('коробка, зашифрованная при заведении, читается при выдаче задания', async () => {
    const secrets = realSecrets();
    // Ровно то, что легло бы в bytea на INSERT из задачи 3.
    const box = secrets.encrypt({ BOT_TOKEN: '123:abc' }, 'p-1');
    const { svc } = makeService({
      secrets,
      claim: [
        { job_id: 'j-1', product_id: 'p-1', slug: 's', kind: 'bot', job_kind: 'provision', box },
      ],
    });

    const job = await svc.claimJob('own');

    expect(job!.secrets).toEqual({ BOT_TOKEN: '123:abc' });
  });

  it('живой роундтрип переживает продукт без секретов', async () => {
    // Настоящий сервис на NULL падает TypeError, мок — нет.
    const { svc } = makeService({ secrets: realSecrets(), claim: [{ ...ROW, box: null }] });

    const job = await svc.claimJob('own');

    expect(job!.secrets).toEqual({});
  });

  it('коробка соседнего продукта в выдачу не проходит', async () => {
    // Ошибочный WHERE, подтянувший чужой secrets_encrypted, обязан упасть, а
    // не отдать чужой токен бота в контейнер. Эта проверка в одиночку ловит
    // проглоченную ошибку расшифровки: с `catch { return {} }` бот уезжает в
    // контейнер с пустым набором переменных и молча не стартует.
    const secrets = realSecrets();
    const чужая = secrets.encrypt({ BOT_TOKEN: 'чужой' }, 'p-99');
    const { svc } = makeService({
      secrets,
      claim: [{ ...ROW, product_id: 'p-1', box: чужая }],
    });

    await expect(svc.claimJob('own')).rejects.toThrow();
  });
});

describe('ProvisioningService.completeJob', () => {
  it('отказ пишет задание и продукт одним оператором', async () => {
    // Два запроса без транзакции оставляли бы продукт в provisioning без
    // причины при смерти процесса между ними: реаппер его не увидит (задание
    // уже failed), promoteReady не переведёт (развёртывание сорвалось), retry
    // требует status = 'failed' и вернёт 404. Продукт не спасает никто — тупик
    // той же формы, о котором предупреждает спека куска 1. Частично его
    // добирала вторая ветка таймаута, но с ЧУЖОЙ формулировкой: владелец видел
    // «заведение не уложилось в 10 минут» там, где агент отчитался об отказе
    // минуту назад.
    //
    // Транзакции здесь нет и не будет: BEGIN через пул в этом репозитории уже
    // рапортовал об откате, которого не было (identity.resolveOrCreate).
    const { svc, calls } = makeService();

    await svc.completeJob('j-1', { ok: false, error: 'порт занят' });

    const writes = calls.filter((c) => c.sql.includes('UPDATE'));
    expect(writes).toHaveLength(1);
    expect(writes[0].sql).toContain('WITH');
    expect(writes[0].sql).toContain('product_provision_jobs');
    expect(writes[0].sql).toContain('UPDATE products');
    // `toContain('WITH')` в одиночку ложно-зелёный: слово встречается и в
    // комментарии. Оператор обязан НАЧИНАТЬСЯ с CTE — как в claimJob.
    expect(writes[0].sql).toMatch(/^\s*WITH\b/);
  });

  it('успех пишет задание и продукт одним оператором', async () => {
    // Успешный путь мягче отказного, но не безобиден: продукт вылезет через
    // promoteReady, а port останется NULL навсегда — хранится он только здесь,
    // восстановить неоткуда.
    const { svc, calls } = makeService();

    await svc.completeJob('j-1', { ok: true, port: 8003 });

    const writes = calls.filter((c) => c.sql.includes('UPDATE'));
    expect(writes).toHaveLength(1);
    expect(writes[0].sql).toContain('WITH');
    expect(writes[0].sql).toContain('product_provision_jobs');
    expect(writes[0].sql).toContain('UPDATE products');
    expect(writes[0].sql).toMatch(/^\s*WITH\b/);
  });

  it('успех НЕ переводит продукт в running сам по себе', async () => {
    // Выход из provisioning — по измеримому факту (heartbeat плюс публичный
    // 200), а не по отчёту агента. Иначе продукт объявляется рабочим, не
    // отвечая.
    //
    // Слово 'running' запрещено ИМЕННО в КУСКЕ по продукту, а не во всём
    // операторе: сторож `not.toContain('running')` по всему тексту краснел на
    // верной правке `... WHERE id = $1 AND status = 'running'` в закрытии
    // ЗАДАНИЯ — запрещал слово там, где имелся в виду перевод продукта, и
    // блокировал починку. После свёртки в один оператор оба куска живут в
    // одной строке, и разделение стало обязательным, а не осторожностью.
    const { svc, calls } = makeService();

    await svc.completeJob('j-1', { ok: true, port: 8003 });

    const prod = productPart(calls);
    expect(prod).not.toContain('running');
    expect(prod).not.toContain('status');
    // Старая причина отказа не подчищается: перезапишет следующая попытка.
    expect(prod).not.toContain('provision_error');
  });

  it('успех сохраняет порт, выбранный агентом', async () => {
    const { svc, calls } = makeService();

    await svc.completeJob('j-1', { ok: true, port: 8003 });

    const prod = find(calls, 'UPDATE products');
    expect(productPart(calls)).toContain('port');
    expect(prod.params).toEqual(['j-1', 8003]);
  });

  it('успех БЕЗ порта не затирает уже сохранённый порт', async () => {
    // Прежняя редакция этой проверки узаконивала дыру: она требовала ровно
    // `SET port = $2` и params ['j-1', null] — то есть закрепляла запись NULL
    // в колонку. Измерено на живой базе: у работающего продукта с port 8003
    // повторный успешный отчёт без порта сносил порт в NULL. Порт хранится
    // только здесь, восстановить его неоткуда, а без него не собрать ни
    // vhost, ни проверку живости.
    //
    // На отказном пути та же дыра закрыта тем, что порт не упоминается вовсе;
    // здесь порт писать НУЖНО, поэтому присваивание обязано быть условным.
    const { svc, calls } = makeService();

    await svc.completeJob('j-1', { ok: true });

    const prod = find(calls, 'UPDATE products');
    expect(productPart(calls)).toMatch(/port\s*=\s*COALESCE\(\s*\$2\s*,\s*port\s*\)/);
    expect(prod.params).toEqual(['j-1', null]);
  });

  it('успех закрывает задание — иначе повтор заведения заблокирован навсегда', async () => {
    // Частичный уникальный индекс product_provision_jobs_one_active запрещает
    // второе активное задание на продукт. Задание, оставшееся в 'running',
    // держит этот индекс: ни повтор, ни новое развёртывание уже не пройдут.
    const { svc, calls } = makeService();

    await svc.completeJob('j-1', { ok: true, port: 8003 });

    expect(jobPart(calls)).toContain("status = 'done'");
    expect(jobPart(calls)).toContain('finished_at');
    // Параметры у обеих записей теперь ОДНИ: оператор один. $1 — задание,
    // $2 — порт, и порядок пришпилен, потому что перестановка на живой базе
    // означала бы `id = 8003` (uuid против int) и отчёт в никуда.
    expect(find(calls, 'UPDATE products').params).toEqual(['j-1', 8003]);
  });

  it('отказ пишет причину в продукт и валит задание', async () => {
    const { svc, calls } = makeService();

    await svc.completeJob('j-1', { ok: false, error: 'порт занят' });

    // Куски сверяются РАЗДЕЛЬНО. Обе строки — provision_error и
    // status = 'failed' — стоят в записи по продукту, поэтому проверка по
    // склеенному SQL пропажу закрытия задания переживала: задание осталось бы
    // в 'running' и навсегда заняло бы product_provision_jobs_one_active.
    // После свёртки в один оператор склейка обесценилась окончательно.
    expect(productPart(calls)).toContain('provision_error');
    // 'failed' ставится ТОЛЬКО заведению: со сном и пробуждением статус
    // разный, поэтому он считается по виду задания, а не вписан константой.
    expect(productPart(calls)).toMatch(/WHEN 'provision' THEN 'failed'/);
    expect(jobPart(calls)).toContain("status = 'failed'");
    expect(jobPart(calls)).toContain('finished_at');
    expect(find(calls, 'UPDATE products').params).toEqual(['j-1', 'порт занят']);
  });

  it('статус на отказе считается по виду задания, а не вписан константой', async () => {
    // ДЫРА, КОТОРУЮ ЭТО ЗАКРЫВАЕТ. Безусловный 'failed' был верен, пока вид
    // задания был один. Со сном он ломает три вещи сразу:
    //
    //   - сорвавшийся СОН значит «контейнер НЕ погашен», то есть продукт
    //     работает. 'failed' увёл бы его из 'sleeping' в статус, который не
    //     платит аренду (списание берёт running/degraded) и не усыпляется
    //     повторно (requestSleep берёт их же) — бесплатный хостинг навсегда,
    //     видимый только по недосчитанной выручке. Плюс кнопка «повторить»
    //     на таком продукте ставит ЗАВЕДЕНИЕ поверх живого каталога клиента;
    //   - сорвавшееся ПРОБУЖДЕНИЕ обязано оставить 'sleeping': продукт как
    //     спал, так и спит, и следующее пополнение поставит задание заново;
    //   - признак сна обязан сниматься вместе со статусом, иначе карточка
    //     работающего продукта объясняет, что ему не хватило токенов.
    const { svc, calls } = makeService();

    await svc.completeJob('j-1', { ok: false, error: 'docker stop не отработал' });

    const product = productPart(calls);
    expect(product).toMatch(/WHEN 'provision' THEN 'failed'/);
    expect(product).toMatch(/WHEN 'sleep' THEN 'degraded'/);
    // У пробуждения своей ветки НЕТ — оно попадает в ELSE и сохраняет
    // собственный статус. Явная ветка 'wake' здесь была бы лишним местом,
    // которое обязано совпадать со словарём видов.
    expect(product).toMatch(/ELSE products\.status/);
    expect(product).toMatch(/sleep_reason = CASE closed\.kind\s+WHEN 'sleep' THEN NULL/);
    // Вид берётся из ЗАКРЫТОГО задания, а не отдельным подзапросом: иначе
    // повторный отчёт снова правил бы живой продукт.
    expect(jobPart(calls)).toMatch(/RETURNING\s+product_id,\s*kind/);
  });

  it('причина отказа ложится в jobs.error, а не в соседнюю колонку', async () => {
    // params у `SET phase = $2` и `SET error = $2` одинаковы, поэтому
    // проверка выше подмену колонки переживает. phase — это «на каком шаге»,
    // а не «почему сорвалось»: разбор сорванного заведения вести было бы не
    // по чему, jobs.error оставался бы пуст.
    const { svc, calls } = makeService();

    await svc.completeJob('j-1', { ok: false, error: 'порт занят' });

    expect(jobPart(calls)).toMatch(/\berror\s*=\s*\$2/);
  });

  it('отказ без причины всё равно оставляет след, а не NULL', async () => {
    // Агент может отчитаться об отказе, не назвав причину. NOT NULL на
    // provision_error нет, поэтому запись прошла бы, и в карточке продукта
    // была бы пустота.
    const { svc, calls } = makeService();

    await svc.completeJob('j-1', { ok: false });

    // Оператор один, и $2 в нём тоже один: причина ложится сразу в обе
    // колонки — jobs.error и products.provision_error. Разъехаться им теперь
    // нечем, но пришпилен именно факт «не NULL».
    expect(find(calls, 'UPDATE products').params[1]).toBe('без причины');
    expect(jobPart(calls)).toMatch(/\berror\s*=\s*\$2/);
    expect(productPart(calls)).toMatch(/provision_error\s*=\s*\$2/);
  });

  it('отказ не трогает порт', async () => {
    // Затирание порта на неудачной ПОВТОРНОЙ попытке снесло бы порт уже
    // работавшего продукта: он есть только в базе, переиспользовать его при
    // следующем развёртывании было бы нечем.
    const { svc, calls } = makeService();

    await svc.completeJob('j-1', { ok: false, error: 'порт занят' });

    expect(productPart(calls)).not.toContain('port');
  });

  it('продукт находится ИЗ закрытого задания, а не отдельным подзапросом', async () => {
    // products.id и product_provision_jobs.id — оба uuid: WHERE id = $1 по
    // jobId типами сойдётся, обновит ноль строк и не пожалуется. Отчёт агента
    // пропал бы бесследно — ни порта, ни причины отказа.
    //
    // Соединение именно с CTE, а не самостоятельный
    // `(SELECT product_id FROM product_provision_jobs WHERE id = $1)`: этот
    // подзапрос находит продукт независимо от того, закрылось ли задание в
    // этом же операторе, и повторный отчёт снова правил бы ЖИВОЙ продукт.
    // Замок `rowCount` больше не стоит между записями — его роль исполняет
    // пустой CTE.
    const { svc, calls } = makeService();

    await svc.completeJob('j-1', { ok: false, error: 'порт занят' });

    expect(productPart(calls)).toMatch(
      /FROM\s+closed\s+WHERE\s+products\.id\s*=\s*closed\.product_id/,
    );
    expect(productPart(calls)).not.toMatch(/SELECT\s+product_id\s+FROM\s+product_provision_jobs/);
  });

  it('успех и отказ трогают одну и ту же строку продукта одинаковым способом', async () => {
    // Симметрия: проверка выше сторожит только отказной путь, и подмена
    // соединения на `WHERE id = $1` в успешном осталась бы незамеченной —
    // порт не сохранился бы, а продукт так и не вышел бы из provisioning.
    const { svc, calls } = makeService();

    await svc.completeJob('j-1', { ok: true, port: 8003 });

    expect(productPart(calls)).toMatch(
      /FROM\s+closed\s+WHERE\s+products\.id\s*=\s*closed\.product_id/,
    );
    expect(productPart(calls)).not.toMatch(/SELECT\s+product_id\s+FROM\s+product_provision_jobs/);
  });

  it('оба пути возвращают product_id из закрытия задания', async () => {
    // Без RETURNING соединять продукт не с чем: оператор просто не соберётся
    // на живой базе, а здесь, где SQL не исполняется, пропажа была бы не
    // видна ничем.
    for (const result of [{ ok: true, port: 1 }, { ok: false, error: 'x' }]) {
      const { svc, calls } = makeService();

      await svc.completeJob('j-1', result);

      expect(jobPart(calls)).toMatch(/RETURNING\s+product_id/);
    }
  });
});

describe('completeJob: повторный отчёт по уже закрытому заданию', () => {
  // ИЗМЕРЕНО НА ЖИВОЙ БАЗЕ. Продукт p-one: running, port 8003, ошибок нет —
  // то есть уже прошедший promoteReady и работающий. Повторный
  // completeJob(тот же jobId, {ok:false}) хоронил его в failed с чужой
  // причиной, а повторный {ok:true} без порта сносил порт в NULL.
  //
  // Задачей 7 это не закрывается: HostGuard подтверждает «это наш агент», а
  // наш агент имеет полное право звать completeJob. Повтор POST-а при обрыве
  // сети воспроизводит сценарий без всякого злоумышленника — ретрай HTTP
  // штатен.
  //
  // Замок — `AND status = 'running'`: закрытое задание обновит ноль строк.
  // Раньше по этому нулю метод возвращался, не дойдя до ВТОРОГО запроса;
  // теперь запись одна, и ноль строк означает пустой CTE, а пустой CTE не даёт
  // соединению с продуктом ни одной строки. Замок стал встроенным — и заодно
  // перестал зависеть от того, доживёт ли процесс до второго запроса.

  it('отказ по закрытому заданию не трогает продукт', async () => {
    const { svc, calls } = makeService({ rowCount: 0 });
    const warn = jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);

    await svc.completeJob('j-1', { ok: false, error: 'таймаут' });

    // Проверка «второго запроса нет» обесценилась: запрос и был один. Теперь
    // сторожится ФОРМА, которая делает продукт недостижимым при закрытом
    // задании: замок в CTE плюс соединение продукта с этим CTE.
    expect(calls).toHaveLength(1);
    const { job, product } = partsOf(calls[0].sql);
    expect(job).toMatch(/AND\s+status\s*=\s*'running'/);
    expect(product).toMatch(/FROM\s+closed\s+WHERE\s+products\.id\s*=\s*closed\.product_id/);
    // След в логе. Без него единственный признак того, что отчёт агента ушёл
    // в никуда, — тишина: метод ничего не возвращает и не бросает.
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0][0])).toContain('j-1');
  });

  it('успех по закрытому заданию не трогает продукт', async () => {
    const { svc, calls } = makeService({ rowCount: 0 });
    const warn = jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);

    await svc.completeJob('j-1', { ok: true, port: 8003 });

    expect(calls).toHaveLength(1);
    const { job, product } = partsOf(calls[0].sql);
    expect(job).toMatch(/AND\s+status\s*=\s*'running'/);
    expect(product).toMatch(/FROM\s+closed\s+WHERE\s+products\.id\s*=\s*closed\.product_id/);
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0][0])).toContain('j-1');
  });

  it('удавшийся отчёт в лог не пишет', async () => {
    // Обратная сторона предыдущих двух: предупреждение, выписываемое всегда,
    // ничего не значит. Заведений много, тик частый, лог общий.
    for (const result of [{ ok: true, port: 1 }, { ok: false, error: 'x' }]) {
      const { svc } = makeService();
      const warn = jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);

      await svc.completeJob('j-1', result);

      expect(warn).not.toHaveBeenCalled();
    }
  });

  it('оба пути закрывают задание только из состояния running', async () => {
    for (const result of [{ ok: true, port: 1 }, { ok: false, error: 'x' }]) {
      const { svc, calls } = makeService();

      await svc.completeJob('j-1', result);

      expect(jobPart(calls)).toMatch(/AND\s+status\s*=\s*'running'/);
    }
  });
});

/**
 * ПОВТОР ЗАВЕДЕНИЯ — третий и последний писатель очереди заданий.
 *
 * Свой набор моков, а не общий makeService: там ответ выбирается по подстроке
 * "SET status = 'running'", которой у повтора нет, и общий мок отдавал бы
 * пустой результат на любой запрос — то есть все успешные сценарии ниже
 * молча превращались бы в «продукт не найден».
 */
function makeRetry(over: { rows?: any[]; fail?: any } = {}) {
  const calls: { sql: string; params: any[] }[] = [];
  const pg = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      if (over.fail) throw over.fail;
      const rows = over.rows ?? [{ product_id: 'p-1' }];
      return { rows, rowCount: rows.length };
    }),
  };
  return { svc: new ProvisioningService(pg as any, { decrypt: jest.fn() } as any, noHosts(), noLimits()), calls };
}

const pgError = (code: string, constraint?: string) =>
  Object.assign(new Error('duplicate key value violates unique constraint'), { code, constraint });

describe('ProvisioningService.retry', () => {
  it('переводит продукт обратно в заведение и ставит задание ОДНИМ оператором', async () => {
    const { svc, calls } = makeRetry();

    await svc.retry('p-1', 'u-1');

    // Счёт запросов — главное утверждение этого файла про повтор. Двумя
    // операторами на пуле (транзакции нет: BEGIN через пул в этом
    // репозитории уже рапортовал об откате, которого не было) смерть
    // процесса между ними оставляет продукт в provisioning БЕЗ задания: он
    // ждёт десять минут второй ветки таймаута и получает формулировку
    // «задание закрыто, продукт не ожил» — неверную, раннер тут ни при чём.
    expect(calls).toHaveLength(1);
    const { sql, params } = calls[0];
    // Порядок частей: сначала правка продукта в CTE, потом вставка задания
    // ИЗ НЕЁ. Обратный порядок означал бы задание, поставленное продукту,
    // которого правка не коснулась.
    const u = sql.indexOf('UPDATE products');
    const i = sql.indexOf('INSERT INTO product_provision_jobs');
    expect(u).toBeGreaterThanOrEqual(0);
    expect(i).toBeGreaterThan(u);
    // Вставка кормится из CTE, а не из параметра: `VALUES ($1, 'queued')`
    // рядом с UPDATE в CTE поставил бы задание даже тогда, когда правка
    // продукта не нашла строки (чужой продукт, не в отказе, архивный) — и
    // единственной защитой остался бы разбор пустого RETURNING уже после
    // записи.
    expect(sql.slice(i)).toMatch(/SELECT[\s\S]*FROM\s+resumed/);
    expect(sql.slice(i)).not.toMatch(/VALUES\s*\(\s*\$/);
    expect(sql).toMatch(/SET\s+status\s*=\s*'provisioning'/);
    expect(params).toEqual(['p-1', 'u-1']);
  });

  it('чужой продукт не перезаводится', async () => {
    const { svc, calls } = makeRetry();

    await svc.retry('p-1', 'u-1');

    // Владелец в WHERE, а не в проверке после выборки: разница между «нет
    // такого» и «есть, но не твой» — это утечка существования чужих
    // продуктов. Мок игнорирует sql и всегда отдаёт заданный rows, поэтому
    // утверждение о параметрах фиксирует форму вызова, а не участие
    // параметра в фильтрации: убери `AND user_id = $2`, оставив параметр, —
    // и проверка params останется зелёной.
    expect(calls[0].sql).toMatch(/user_id\s*=\s*\$2/);
    expect(calls[0].params[1]).toBe('u-1');
  });

  it('повтор доступен только после отказа и только неархивному продукту', async () => {
    const { svc, calls } = makeRetry();

    await svc.retry('p-1', 'u-1');

    // Без сверки состояния кнопка отправляла бы на повтор РАБОТАЮЩИЙ продукт:
    // status уезжает в provisioning, ходы перестают выдаваться (claimNext
    // отбирает только по running), а сайт при этом жив и отвечает.
    expect(calls[0].sql).toMatch(/status\s*=\s*'failed'/);
    expect(calls[0].sql).toMatch(/archived_at\s+IS\s+NULL/);
  });

  it('причина прошлого отказа переживает повтор', async () => {
    const { svc, calls } = makeRetry();

    await svc.retry('p-1', 'u-1');

    // provision_error по замыслу не очищается автоматически (см.
    // 002_provisioning.sql): пока новая попытка не закончилась, единственное,
    // что известно о продукте, — почему сорвалась прошлая. Чистит его
    // promoteReady при удачном переводе, перезаписывают completeJob и таймаут.
    expect(calls[0].sql).not.toMatch(/provision_error\s*=\s*NULL/);
  });

  it('продукта нет, он чужой или не в отказе — 404, а не тихий успех', async () => {
    const { svc } = makeRetry({ rows: [] });

    await expect(svc.retry('p-1', 'u-1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('двойное нажатие даёт 409, а не 500', async () => {
    const { svc } = makeRetry({ fail: pgError('23505', 'product_provision_jobs_one_active') });

    // Частичный уникальный индекс one_active — это «заведение уже идёт», а не
    // поломка. Наружу 500 означал бы страницу ошибки на втором клике.
    const e = await svc
      .retry('p-1', 'u-1')
      .then(() => null)
      .catch((err: any) => err);
    expect(e).toBeInstanceOf(ConflictException);
    expect(e.getStatus()).toBe(409);
  });

  it('чужое нарушение UNIQUE за «уже идёт» не выдаётся', async () => {
    // Условие узкое, как в create: безусловный ConflictException превратил бы
    // нарушение любого другого ограничения в спокойное «заведение уже идёт»
    // без следа в логах. Имена ограничений сняты с живой базы.
    const { svc } = makeRetry({ fail: pgError('23505', 'products_slug_key') });

    const e = await svc
      .retry('p-1', 'u-1')
      .then(() => null)
      .catch((err: any) => err);
    expect(e).not.toBeInstanceOf(ConflictException);
    expect(e.constraint).toBe('products_slug_key');
  });

  it('падение базы наружу не маскируется', async () => {
    const { svc } = makeRetry({ fail: pgError('42P01') });

    const e = await svc
      .retry('p-1', 'u-1')
      .then(() => null)
      .catch((err: any) => err);
    expect(e).not.toBeInstanceOf(ConflictException);
    expect(e).not.toBeInstanceOf(NotFoundException);
    expect(e.code).toBe('42P01');
  });
});

/**
 * Отметка о жизни агента хоста. ГРАНИЦА ТА ЖЕ: pg подменён, SQL не
 * исполняется, здесь сторожится форма и поведение вокруг запроса. Что эти
 * запросы делают на самом деле — в provisioning.integration.spec.ts.
 */
describe('ProvisioningService.touchHostAgent', () => {
  function makeTouch(fail?: Error) {
    const calls: { sql: string; params?: any[] }[] = [];
    const pg = {
      query: jest.fn(async (sql: string, params?: any[]) => {
        calls.push({ sql, params });
        if (fail) throw fail;
        return { rows: [], rowCount: 1 };
      }),
    };
    const svc = new ProvisioningService(pg as any, {} as any, noHosts(), noLimits());
    const error = jest.spyOn((svc as any).logger, 'error').mockImplementation(() => undefined);
    return { svc, calls, error };
  }

  it('ставит отметку одной записью, без предварительного чтения', async () => {
    const { svc, calls } = makeTouch();

    await svc.touchHostAgent('own');

    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain('INSERT INTO product_host_agent');
    // Ключ конфликта — МАШИНА. `ON CONFLICT (id)` после 006 не существует
    // вовсе (колонки нет), но его переживший вариант «конфликт по любой
    // строке» означал бы одну отметку на всё — то есть ровно то, что 006
    // разбирает.
    expect(calls[0].sql).toContain('ON CONFLICT (host_id) DO UPDATE');
  });

  it('отметка пишется ТОЙ машине, что спросила', async () => {
    // Метка приезжает параметром, а не подставляется в текст: подставленная,
    // она уехала бы в pg_stat_statements отдельной строкой на каждую машину, а
    // главное — открыла бы путь метке, собранной конкатенацией.
    const { svc, calls } = makeTouch();

    await svc.touchHostAgent('clients');

    expect(calls[0].params).toEqual(['clients']);
    expect(calls[0].sql).not.toContain('clients');
  });

  it('время берётся у базы, а не у процесса', async () => {
    // Часы бэкенда и часы базы — разные часы, а свежесть считается вычитанием
    // ИЗ now() базы (см. hostAgentLive). Отметка, записанная временем
    // процесса, на разошедшихся часах даёт либо вечную тревогу, либо вечное
    // спокойствие — и то и другое молча.
    const { svc, calls } = makeTouch();

    await svc.touchHostAgent('own');

    expect(calls[0].sql).toContain('now()');
    // Параметр у запроса ровно один — метка машины; отметка времени в него не
    // попадает. Прежняя форма проверки («параметров нет вовсе») с приездом
    // метки перестала бы значить что-либо.
    expect(calls[0].params).toHaveLength(1);
    expect(calls[0].sql).not.toMatch(/\$2/);
  });

  it('запись загрублена: отметка не переписывается на каждом опросе', async () => {
    // Агент опрашивает раз в три секунды. Без условия это 28 800 записей в
    // сутки в одну строку при разрешении, которое читателю не нужно.
    const { svc, calls } = makeTouch();

    await svc.touchHostAgent('own');

    expect(calls[0].sql).toMatch(
      /WHERE product_host_agent\.seen_at < now\(\) - interval '30 seconds'/,
    );
  });

  it('загрубление считается по строке СВОЕЙ машины', async () => {
    // Условие сверяется с отметкой строки, в которую попал ON CONFLICT, то
    // есть со своей. Общее на всех загрубление означало бы, что опрос одной
    // машины глушит запись соседней на полминуты: при двух машинах это не
    // редкость, а постоянное состояние.
    const { svc, calls } = makeTouch();

    await svc.touchHostAgent('own');

    const sql = calls[0].sql;
    expect(sql.indexOf('ON CONFLICT (host_id)')).toBeLessThan(
      sql.indexOf('product_host_agent.seen_at <'),
    );
    // Подзапроса по всей таблице в условии нет: он и был бы «общим
    // загрублением», сколько бы строк в таблице ни лежало.
    expect(sql).not.toMatch(/SELECT[\s\S]*FROM product_host_agent[\s\S]*WHERE/);
  });

  it('загрубление заметно меньше порога протухания', async () => {
    // Свойство, а не число: загрубление, доросшее до порога, означает живого
    // агента, протухающего между двумя своими же записями. Оба значения
    // читаются из готовых строк SQL, поэтому тест краснеет и на правку порога.
    const { svc, calls } = makeTouch();
    const probe = new ProvisioningService({ query: jest.fn(async () => ({ rows: [{ live: true }] })) } as any, {} as any, noHosts(), noLimits());

    await svc.touchHostAgent('own');
    await probe.hostAgentLive('own');

    const gap = Number(calls[0].sql.match(/seen_at < now\(\) - interval '(\d+) seconds'/)![1]);
    const fresh = Number(
      (probe as any).pg.query.mock.calls[0][0].match(
        /seen_at > now\(\) - interval '(\d+) seconds'/,
      )![1],
    );
    expect(gap).toBeLessThan(fresh / 2);
  });

  it('несостоявшаяся запись не роняет опрос, но попадает в лог', async () => {
    // Маршрут, который зовёт отметку, — тот самый, которым агент забирает
    // работу. Отказ записи обязан оставаться отказом записи: 500 в ответ на
    // опрос уводит агента в тройную паузу и оставляет продукты незаведёнными,
    // то есть отметка о жизни убивала бы ровно то, за чем следит.
    const { svc, error } = makeTouch(new Error('нет такой таблицы'));

    await expect(svc.touchHostAgent('own')).resolves.toBeUndefined();
    // Молча проглоченный отказ означал бы вечную тревогу в кабинете без единой
    // строки о причине.
    expect(error).toHaveBeenCalledWith(expect.stringContaining('нет такой таблицы'));
  });

  it('пустая метка отказывает в базе и оставляет строку в логе', async () => {
    // Своего сторожа на пустую метку здесь нет — в отличие от claimJob, и
    // разница в том, как выглядит промах. Пустая метка в выдаче даёт «очередь
    // пуста» на непустой очереди, то есть штатный ответ; здесь она не проходит
    // NOT NULL и внешний ключ, то есть отказывает громко сама.
    const { svc, calls, error } = makeTouch(new Error('null value in column "host_id"'));

    await expect(svc.touchHostAgent(undefined as any)).resolves.toBeUndefined();

    expect(calls[0].params).toEqual([undefined]);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('host_id'));
  });
});

describe('ProvisioningService.hostAgentLive', () => {
  function makeLive(live: any) {
    const calls: { sql: string; params?: any[] }[] = [];
    const pg = {
      query: jest.fn(async (sql: string, params?: any[]) => {
        calls.push({ sql, params });
        return { rows: [{ live }], rowCount: 1 };
      }),
    };
    return { svc: new ProvisioningService(pg as any, {} as any, noHosts(), noLimits()), calls };
  }

  it('спрашивает базу один раз', async () => {
    // Двумя запросами агент успевает забрать задание МЕЖДУ ними: молчащая
    // отметка сложилась бы с ещё не начатым заданием в «никто не забирает» при
    // работающем агенте.
    const { svc, calls } = makeLive(true);

    await svc.hostAgentLive('own');

    expect(calls).toHaveLength(1);
  });

  it('считает живым и по свежей отметке, и по взятому заданию', async () => {
    const { svc, calls } = makeLive(true);

    await svc.hostAgentLive('own');

    // Второй этаж обязателен: пока агент разворачивает продукт, он не
    // опрашивает — он работает, и отметка стоит до восьми минут.
    expect(calls[0].sql).toContain('product_host_agent');
    expect(calls[0].sql).toContain('product_provision_jobs');
    expect(calls[0].sql).toContain("status = 'running'");
    expect(calls[0].sql).toMatch(/EXISTS[\s\S]*\bOR\b[\s\S]*EXISTS/);
  });

  it('ОБА этажа спрашиваются про одну и ту же машину', async () => {
    // Главная правка задачи 3б. Отметка ищется по метке машины, а задание
    // находит машину через свой продукт — у задания своей колонки нет и не
    // появилось. Второй этаж, оставшийся «по всем машинам», вернул бы общую
    // отметку с другой стороны: одна занятая машина покрывала бы своим
    // свидетельством все остальные.
    const { svc, calls } = makeLive(true);

    await svc.hostAgentLive('own');

    const sql = calls[0].sql;
    expect(sql).toMatch(/a\.host_id = \$1/);
    expect(sql).toMatch(/p\.host_id = \$1/);
    expect(sql).toMatch(/FROM products p\s+WHERE p\.id = product_provision_jobs\.product_id/);
    expect(calls[0].params).toEqual(['own']);
  });

  it('метка уезжает параметром, а не подставляется в текст', async () => {
    const { svc, calls } = makeLive(true);

    await svc.hostAgentLive('clients');

    expect(calls[0].params).toEqual(['clients']);
    expect(calls[0].sql).not.toContain('clients');
  });

  it('взятое задание считается свидетельством не дольше срока заведения', async () => {
    // Агент, умерший посреди развёртывания, оставляет задание в 'running'.
    // Без условия по сроку он числился бы живым вечно — и предупреждение не
    // появилось бы никогда именно в том случае, ради которого написано.
    const { svc, calls } = makeLive(true);

    await svc.hostAgentLive('own');

    expect(calls[0].sql).toMatch(
      /COALESCE\(started_at, created_at\) > now\(\) - interval '10 minutes'/,
    );
  });

  it('порог свежести — тот же, которым файл меряет раннера', async () => {
    const { svc, calls } = makeLive(true);

    await svc.hostAgentLive('own');

    // Второе число означало бы два разных ответа на один вопрос в одном файле.
    expect(calls[0].sql).toContain("seen_at > now() - interval '120 seconds'");
  });

  it('вердикт берётся у базы, а не вычисляется из строки времени', async () => {
    const { svc } = makeLive(false);

    // База отдала false — значит false, без «ну строка же есть».
    await expect(svc.hostAgentLive('own')).resolves.toBe(false);
  });

  it('невнятный ответ базы читается как молчание агента, а не как жизнь', async () => {
    // `r.rows[0].live` без сверки с true вернул бы истину на любой непустой
    // строке, в том числе на 'f' — так приезжает boolean, если кто-нибудь
    // подставит текстовый каст. Тревога при этом исчезла бы навсегда.
    const { svc } = makeLive('f');

    await expect(svc.hostAgentLive('own')).resolves.toBe(false);
  });
});

describe('ProvisioningService.hostAgentsLiveForUser', () => {
  function makeLive(live: any) {
    const calls: { sql: string; params?: any[] }[] = [];
    const pg = {
      query: jest.fn(async (sql: string, params?: any[]) => {
        calls.push({ sql, params });
        return { rows: [{ live }], rowCount: 1 };
      }),
    };
    return { svc: new ProvisioningService(pg as any, {} as any, noHosts(), noLimits()), calls };
  }

  it('спрашивает базу один раз', async () => {
    // Три условия в одной выборке видят состояние на один и тот же now().
    const { svc, calls } = makeLive(true);

    await svc.hostAgentsLiveForUser('u-1');

    expect(calls).toHaveLength(1);
    expect(calls[0].params).toEqual(['u-1']);
  });

  it('вердикт собран ПО МАШИНАМ ВЛАДЕЛЬЦА, а не по агенту вообще', async () => {
    const { svc, calls } = makeLive(true);

    await svc.hostAgentsLiveForUser('u-1');

    const sql = calls[0].sql;
    // Машины отбираются через продукты владельца, а не просто перечисляются.
    expect(sql).toMatch(/p\.user_id = \$1/);
    expect(sql).toMatch(/p\.archived_at IS NULL/);
    expect(sql).toMatch(/p\.host_id = h\.id/);
  });

  it('продукт без метки машины считается молчанием, а не порядком', async () => {
    // Задания такого продукта не достанутся никому: `p.host_id = NULL` не
    // равно ничему. Без этого условия кабинет отвечал бы «всё в порядке»
    // ровно тому, чья работа не уедет никуда.
    const { svc, calls } = makeLive(true);

    await svc.hostAgentsLiveForUser('u-1');

    expect(calls[0].sql).toMatch(/p\.host_id IS NULL/);
  });

  it('полностью лежащий хостинг виден и владельцу без продуктов', async () => {
    // Первое условие: хоть одна машина реестра забирает задания. Без него
    // владелец, у которого продуктов ещё нет, получал бы «всё в порядке» при
    // мёртвом хостинге — то есть ровно перед первым нажатием «Новый продукт».
    const { svc, calls } = makeLive(true);

    await svc.hostAgentsLiveForUser('u-1');

    expect(calls[0].sql).toMatch(/EXISTS \(SELECT 1 FROM product_hosts h WHERE \(/);
  });

  it('определение жизни — то же, которым меряется отдельная машина', async () => {
    // Два списанных друг с друга куска SQL разошлись бы молча и в сторону
    // зелёного. Сверяются готовые строки, а не намерение.
    const { svc, calls } = makeLive(true);
    const one = makeLive(true);

    await svc.hostAgentsLiveForUser('u-1');
    await one.svc.hostAgentLive('own');

    const perHost = one.calls[0].sql
      .replace(/^SELECT /, '')
      .replace(/ AS live$/, '')
      .replace(/\$1/g, 'h.id');
    expect(calls[0].sql).toContain(perHost);
  });

  it('невнятный ответ базы читается как молчание, а не как жизнь', async () => {
    const { svc } = makeLive('f');

    await expect(svc.hostAgentsLiveForUser('u-1')).resolves.toBe(false);
  });
});
