import * as crypto from 'crypto';
import { ProvisioningService } from './provisioning.service';
import { SecretsService } from './secrets.service';

// Строка, какой её отдаёт финальный SELECT: id задания и id продукта РАЗНЫЕ,
// слаг и форма тоже — иначе перепутанные местами поля проходили бы зелёными.
// Имена ключей — те, что заданы алиасами в запросе: потеря алиаса ломает
// чтение (проверяется отдельно).
const ROW = {
  job_id: 'j-1',
  product_id: 'p-1',
  slug: 's',
  kind: 'site',
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
  return { svc: new ProvisioningService(pg as any, secrets as any), calls, secrets };
}

const sqlOf = (c: { sql: string }[]) => c.map((x) => x.sql).join('\n');
const find = (c: { sql: string; params: any[] }[], needle: string) =>
  c.find((x) => x.sql.includes(needle))!;

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

    await svc.claimJob();

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

    await svc.claimJob();

    expect(calls[0].sql).not.toMatch(/\bOR\b/);
  });

  it('очередь разбирается с головы: старшее задание первым', async () => {
    // `ORDER BY created_at DESC` — это LIFO: продукт, заведённый первым, ждёт
    // за всеми, кто пришёл после, и при непрерывном потоке не дожидается
    // никогда. Проверка на присутствие `ORDER BY created_at` совпадает и с
    // DESC, поэтому направление сторожится отдельно.
    const { svc, calls } = makeService();

    await svc.claimJob();

    expect(calls[0].sql).toMatch(/ORDER BY\s+j\.created_at\s+ASC/);
    expect(calls[0].sql).not.toMatch(/DESC/i);
  });

  it('задание похороненного или архивного продукта не выдаётся', async () => {
    // Без EXISTS агент разворачивает то, что система считает мёртвым:
    // задание переживает и перевод продукта в failed, и архивацию. Измерено
    // на живой базе — задания продуктов dead и arch оставались queued только
    // благодаря этому условию.
    const { svc, calls } = makeService();

    await svc.claimJob();

    expect(calls[0].sql).toMatch(/EXISTS\s*\(\s*SELECT 1 FROM products p/);
    expect(calls[0].sql).toMatch(/p\.status = 'provisioning'/);
    expect(calls[0].sql).toMatch(/p\.archived_at IS NULL/);
  });

  it('выданное задание помечается начатым, а не только «running»', async () => {
    // НАЙДЕНО ИЗМЕРЕНИЕМ: снятие `started_at = now()` переживали все проверки
    // файла. Колонка нужна ровно для одного — понять, сколько задание висит.
    // Без неё задание, застрявшее в 'running' (агент умер посреди
    // развёртывания), неотличимо от только что выданного: сборщик зависших не
    // назовёт ни одно просроченным, а частичный индекс one_active держит
    // продукт запертым. Отказ молчаливый — статус-то правильный.
    const { svc, calls } = makeService();

    await svc.claimJob();

    expect(calls[0].sql).toMatch(/started_at\s*=\s*now\(\)/);
  });

  it('выдача задания и выпуск токена — ОДИН оператор', async () => {
    // Двумя запросами на пуле (без транзакции — BEGIN через пул в этом
    // репозитории уже рапортовал об откате, которого не было) падение второго
    // оставляло бы задание в 'running' с токеном, не доехавшим до агента, а
    // частичный индекс one_active запирал бы продукт до сборщика зависших.
    // Тот же класс, что resolveOrCreate в identity.
    const { svc, calls } = makeService();

    await svc.claimJob();

    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toMatch(/^\s*WITH\b/);
  });

  it('выпускает НОВЫЙ runner-токен при выдаче задания', async () => {
    // Старый восстановить нельзя: в базе только sha256. Переиспользование
    // означало бы, что раннер в новом контейнере не аутентифицируется, —
    // и отказ был бы молчаливым.
    const { svc, calls } = makeService();

    const job = await svc.claimJob();

    expect(job!.runnerToken).toMatch(/^[0-9a-f]{64}$/);
    expect(sqlOf(calls)).toContain('runner_token_hash');
    // Обе проверки выше ЛОЖНО ЗЕЛЁНЫЕ на самой правдоподобной мутации —
    // отдать раннеру то, что лежит в базе. Хеш — тоже 64 hex, и слово
    // runner_token_hash в SQL тоже появляется. Раннер предъявил бы хеш,
    // RunnerGuard посчитал бы от него sha256 ещё раз и не нашёл продукт:
    // молчаливый отказ ровно того вида, который эта проверка обязана
    // предотвращать.
    expect(calls[0].params).toEqual([
      crypto.createHash('sha256').update(job!.runnerToken).digest('hex'),
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

    await svc.claimJob();

    expect(calls[0].sql).toMatch(
      /UPDATE products\s+SET runner_token_hash = \$1\s+WHERE id IN \(SELECT product_id FROM claimed\)/,
    );
  });

  it('каждое читаемое поле названо в запросе своим алиасом', async () => {
    // САМАЯ ДОРОГАЯ ИЗ ПРОПУЩЕННЫХ: мок отдаёт свою строку независимо от того,
    // что перечислено в RETURNING, поэтому потеря алиаса невидима всему файлу.
    // Подтверждено на PostgreSQL: без `AS box` колонка приезжает как
    // secrets_encrypted, row.box становится undefined — и бот уезжает в
    // контейнер БЕЗ ТОКЕНА, молча, с успешным заведением.
    //
    // `i.slug AS slug` избыточен синтаксически и намеренно оставлен: алиас
    // выписан у всех пяти полей, чтобы сторож был однородным.
    const { svc, calls } = makeService();

    await svc.claimJob();

    const sql = calls[0].sql;
    expect(sql).toMatch(/secrets_encrypted AS box/);
    expect(sql).toMatch(/c\.id AS job_id/);
    expect(sql).toMatch(/i\.id AS product_id/);
    expect(sql).toMatch(/i\.slug AS slug/);
    expect(sql).toMatch(/i\.kind AS kind/);
    expect(sql).toMatch(/i\.box AS box/);
  });

  it('токен берётся из 32 случайных байт, а не выводится из данных задания', async () => {
    // Привязка к самому источнику случайности. Проверки «64 hex» и «sha256 от
    // токена уехал параметром» вместе переживают уменьшение энтропии до
    // одного байта: randomBytes(1).toString('hex').repeat(32) — тоже 64 hex, и
    // хеш сойдётся. Перебор 256 вариантов даёт доступ к раннеру.
    const spy = jest.spyOn(crypto, 'randomBytes');
    try {
      const { svc } = makeService();

      const job = await svc.claimJob();

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
    const a = await makeService().svc.claimJob();
    const b = await makeService().svc.claimJob();

    expect(a!.runnerToken).not.toBe(b!.runnerToken);
  });

  it('секреты отдаются расшифрованными', async () => {
    const { svc, secrets } = makeService();

    const job = await svc.claimJob();

    expect(secrets.decrypt).toHaveBeenCalled();
    expect(job!.secrets).toEqual({ BOT_TOKEN: 'т' });
    // toHaveBeenCalled ничего не говорит об аргументах, а их тут ровно два и
    // оба содержательные. Вызов одним аргументом (как в первой редакции
    // плана) и вызов с чужим id обе эту проверку переживают.
    expect(secrets.decrypt).toHaveBeenCalledWith(ROW.box, 'p-1');
  });

  it('пустая очередь — не ошибка', async () => {
    const { svc } = makeService({ claim: [] });

    expect(await svc.claimJob()).toBeNull();
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

    await svc.claimJob();

    expect(calls).toHaveLength(1);
    expect(secrets.decrypt).not.toHaveBeenCalled();
  });

  it('поля задания не перепутаны местами', async () => {
    // id задания и id продукта — оба uuid, слаг и форма — обе строки.
    // Перестановка любой пары не меняет ни одного утверждения выше: агент
    // развернул бы продукт в каталог с чужим именем и отчитался бы по чужому
    // заданию.
    const { svc } = makeService();

    const job = await svc.claimJob();

    expect(job).toEqual({
      jobId: 'j-1',
      productId: 'p-1',
      slug: 's',
      kind: 'site',
      runnerToken: expect.stringMatching(/^[0-9a-f]{64}$/),
      secrets: { BOT_TOKEN: 'т' },
    });
  });

  it('продукт без секретов не роняет выдачу задания', async () => {
    // secrets_encrypted у продукта без секретов — NULL (задача 3 кладёт именно
    // NULL, а не коробку от {}). decrypt(null) — сырой TypeError, поэтому
    // признак «секретов нет» обязан читаться ДО вызова.
    const { svc, secrets } = makeService({ claim: [{ ...ROW, box: null }] });

    const job = await svc.claimJob();

    expect(job!.secrets).toEqual({});
    expect(secrets.decrypt).not.toHaveBeenCalled();
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
      claim: [{ job_id: 'j-1', product_id: 'p-1', slug: 's', kind: 'bot', box }],
    });

    const job = await svc.claimJob();

    expect(job!.secrets).toEqual({ BOT_TOKEN: '123:abc' });
  });

  it('живой роундтрип переживает продукт без секретов', async () => {
    // Настоящий сервис на NULL падает TypeError, мок — нет.
    const { svc } = makeService({ secrets: realSecrets(), claim: [{ ...ROW, box: null }] });

    const job = await svc.claimJob();

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

    await expect(svc.claimJob()).rejects.toThrow();
  });
});

describe('ProvisioningService.completeJob', () => {
  it('успех НЕ переводит продукт в running сам по себе', async () => {
    // Выход из provisioning — по измеримому факту (heartbeat плюс публичный
    // 200), а не по отчёту агента. Иначе продукт объявляется рабочим, не
    // отвечая.
    //
    // Слово 'running' запрещено ИМЕННО в запросе по продукту, а не во всём
    // склеенном SQL: сторож `not.toContain('running')` по всему тексту
    // краснел на верной правке `... WHERE id = $1 AND status = 'running'` в
    // запросе по ЗАДАНИЮ — запрещал слово там, где имелся в виду перевод
    // продукта, и блокировал починку.
    const { svc, calls } = makeService();

    await svc.completeJob('j-1', { ok: true, port: 8003 });

    const prod = find(calls, 'UPDATE products');
    expect(prod.sql).not.toContain('running');
    expect(prod.sql).not.toContain('status');
    // Старая причина отказа не подчищается: перезапишет следующая попытка.
    expect(prod.sql).not.toContain('provision_error');
  });

  it('успех сохраняет порт, выбранный агентом', async () => {
    const { svc, calls } = makeService();

    await svc.completeJob('j-1', { ok: true, port: 8003 });

    const prod = find(calls, 'UPDATE products');
    expect(prod.sql).toContain('port');
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
    expect(prod.sql).toMatch(/port\s*=\s*COALESCE\(\s*\$2\s*,\s*port\s*\)/);
    expect(prod.params).toEqual(['j-1', null]);
  });

  it('успех закрывает задание — иначе повтор заведения заблокирован навсегда', async () => {
    // Частичный уникальный индекс product_provision_jobs_one_active запрещает
    // второе активное задание на продукт. Задание, оставшееся в 'running',
    // держит этот индекс: ни повтор, ни новое развёртывание уже не пройдут.
    const { svc, calls } = makeService();

    await svc.completeJob('j-1', { ok: true, port: 8003 });

    const job = find(calls, 'UPDATE product_provision_jobs');
    expect(job.sql).toContain("status = 'done'");
    expect(job.sql).toContain('finished_at');
    expect(job.params).toEqual(['j-1']);
  });

  it('отказ пишет причину в продукт и валит задание', async () => {
    const { svc, calls } = makeService();

    await svc.completeJob('j-1', { ok: false, error: 'порт занят' });

    const sql = sqlOf(calls);
    expect(sql).toContain('provision_error');
    expect(sql).toContain("status = 'failed'");
    // Обе строки выше есть в ОДНОМ запросе — UPDATE products SET status =
    // 'failed', provision_error = $2. Пропажа UPDATE по заданиям проходила
    // зелёной, а задание осталось бы в 'running' и навсегда заняло бы
    // product_provision_jobs_one_active. Две записи сверяются раздельно.
    const job = find(calls, 'UPDATE product_provision_jobs');
    expect(job.sql).toContain("status = 'failed'");
    expect(job.sql).toContain('finished_at');
    expect(job.params).toEqual(['j-1', 'порт занят']);
    const prod = find(calls, 'UPDATE products');
    expect(prod.params).toEqual(['j-1', 'порт занят']);
  });

  it('причина отказа ложится в jobs.error, а не в соседнюю колонку', async () => {
    // params у `SET phase = $2` и `SET error = $2` одинаковы, поэтому
    // проверка выше подмену колонки переживает. phase — это «на каком шаге»,
    // а не «почему сорвалось»: разбор сорванного заведения вести было бы не
    // по чему, jobs.error оставался бы пуст.
    const { svc, calls } = makeService();

    await svc.completeJob('j-1', { ok: false, error: 'порт занят' });

    expect(find(calls, 'UPDATE product_provision_jobs').sql).toMatch(/\berror\s*=\s*\$2/);
  });

  it('отказ без причины всё равно оставляет след, а не NULL', async () => {
    // Агент может отчитаться об отказе, не назвав причину. NOT NULL на
    // provision_error нет, поэтому запись прошла бы, и в карточке продукта
    // была бы пустота.
    const { svc, calls } = makeService();

    await svc.completeJob('j-1', { ok: false });

    expect(find(calls, 'UPDATE products').params[1]).toBe('без причины');
    expect(find(calls, 'UPDATE product_provision_jobs').params[1]).toBe('без причины');
  });

  it('отказ не трогает порт', async () => {
    // Затирание порта на неудачной ПОВТОРНОЙ попытке снесло бы порт уже
    // работавшего продукта: он есть только в базе, переиспользовать его при
    // следующем развёртывании было бы нечем.
    const { svc, calls } = makeService();

    await svc.completeJob('j-1', { ok: false, error: 'порт занят' });

    expect(find(calls, 'UPDATE products').sql).not.toContain('port');
  });

  it('продукт находится по заданию, а не по jobId в колонке id', async () => {
    // products.id и product_provision_jobs.id — оба uuid: WHERE id = $1 по
    // jobId типами сойдётся, обновит ноль строк и не пожалуется. Отчёт агента
    // пропал бы бесследно — ни порта, ни причины отказа.
    const { svc, calls } = makeService();

    await svc.completeJob('j-1', { ok: false, error: 'порт занят' });

    expect(find(calls, 'UPDATE products').sql).toMatch(
      /WHERE\s+id\s+=\s+\(\s*SELECT\s+product_id\s+FROM\s+product_provision_jobs/,
    );
  });

  it('успех и отказ трогают одну и ту же строку продукта одинаковым способом', async () => {
    // Симметрия: проверка выше сторожит только отказной путь, и подмена
    // подзапроса на `WHERE id = $1` в успешном осталась бы незамеченной —
    // порт не сохранился бы, а продукт так и не вышел бы из provisioning.
    const { svc, calls } = makeService();

    await svc.completeJob('j-1', { ok: true, port: 8003 });

    expect(find(calls, 'UPDATE products').sql).toMatch(
      /WHERE\s+id\s+=\s+\(\s*SELECT\s+product_id\s+FROM\s+product_provision_jobs/,
    );
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
  // Замок — `AND status = 'running'`: закрытое задание обновит ноль строк, и
  // по этому нулю запрос к продукту не выполняется вовсе.

  it('отказ по закрытому заданию не трогает продукт', async () => {
    const { svc, calls } = makeService({ rowCount: 0 });

    await svc.completeJob('j-1', { ok: false, error: 'таймаут' });

    expect(sqlOf(calls)).not.toContain('UPDATE products');
  });

  it('успех по закрытому заданию не трогает продукт', async () => {
    const { svc, calls } = makeService({ rowCount: 0 });

    await svc.completeJob('j-1', { ok: true, port: 8003 });

    expect(sqlOf(calls)).not.toContain('UPDATE products');
  });

  it('оба пути закрывают задание только из состояния running', async () => {
    for (const result of [{ ok: true, port: 1 }, { ok: false, error: 'x' }]) {
      const { svc, calls } = makeService();

      await svc.completeJob('j-1', result);

      expect(find(calls, 'UPDATE product_provision_jobs').sql).toMatch(
        /AND\s+status\s*=\s*'running'/,
      );
    }
  });
});
