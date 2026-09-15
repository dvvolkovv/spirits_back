import { ConflictException, NotFoundException } from '@nestjs/common';
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
    expect(productPart(calls)).toContain("status = 'failed'");
    expect(jobPart(calls)).toContain("status = 'failed'");
    expect(jobPart(calls)).toContain('finished_at');
    expect(find(calls, 'UPDATE products').params).toEqual(['j-1', 'порт занят']);
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
  return { svc: new ProvisioningService(pg as any, { decrypt: jest.fn() } as any), calls };
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
