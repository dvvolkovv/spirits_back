import * as crypto from 'crypto';
import { ProvisioningService } from './provisioning.service';
import { SecretsService } from './secrets.service';

// Строка, какой её отдаёт RETURNING: id задания и id продукта РАЗНЫЕ, слаг и
// форма тоже — иначе перепутанные местами поля проходили бы зелёными.
const ROW = {
  id: 'j-1',
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

describe('ProvisioningService.claimJob', () => {
  it('берёт задание атомарно и не отдаёт его второму агенту', async () => {
    const { svc, calls } = makeService();

    await svc.claimJob();

    const sql = sqlOf(calls);
    expect(sql).toContain('FOR UPDATE');
    expect(sql).toContain('SKIP LOCKED');
    expect(sql).toContain("status = 'queued'");
    // Сверх плана: toContain — принадлежность, а не соседство. `FOR UPDATE` в
    // одном месте и `SKIP LOCKED` в комментарии рядом дали бы обычную
    // блокирующую выборку, при которой второй агент ЖДЁТ то же задание и
    // получает его следом. Пара обязана стоять вместе.
    expect(calls[0].sql).toMatch(/FOR UPDATE\s+SKIP LOCKED/);
    // Без LIMIT 1 подзапрос вернул бы несколько id и UPDATE упал бы на живой
    // базе; на моке это молчит.
    expect(calls[0].sql).toMatch(/LIMIT 1/);
    // FIFO: без ORDER BY порядок выдачи не определён, и продукт, заведённый
    // первым, может ждать за всеми последующими.
    expect(calls[0].sql).toMatch(/ORDER BY\s+created_at/);
  });

  it('выданное задание помечается начатым, а не только «running»', async () => {
    // НАЙДЕНО ИЗМЕРЕНИЕМ: снятие `started_at = now()` переживали все
    // двадцать две проверки этого файла. Колонка есть в схеме и нужна ровно
    // для одного — понять, сколько задание висит. Без неё задание,
    // застрявшее в 'running' (агент умер посреди развёртывания), неотличимо
    // от только что выданного: сборщик зависших не может назвать ни одно
    // просроченным, а частичный индекс one_active держит продукт запертым
    // навсегда. Отказ полностью молчаливый — статус-то правильный.
    const { svc, calls } = makeService();

    await svc.claimJob();

    expect(calls[0].sql).toMatch(/started_at\s*=\s*now\(\)/);
  });

  it('выпускает НОВЫЙ runner-токен при выдаче задания', async () => {
    // Старый восстановить нельзя: в базе только sha256. Переиспользование
    // означало бы, что раннер в новом контейнере не аутентифицируется, —
    // и отказ был бы молчаливым.
    const { svc, calls } = makeService();

    const job = await svc.claimJob();

    expect(job!.runnerToken).toMatch(/^[0-9a-f]{64}$/);
    expect(sqlOf(calls)).toContain('runner_token_hash');
    // Сверх плана: обе проверки выше ЛОЖНО ЗЕЛЁНЫЕ на самой правдоподобной
    // мутации — дописать runner_token_hash в RETURNING и отдать раннеру то,
    // что лежит в базе. Хеш — тоже 64 hex, и слово runner_token_hash в SQL
    // тоже появляется. Раннер предъявил бы хеш, RunnerGuard посчитал бы от
    // него sha256 ещё раз и не нашёл продукт: молчаливый отказ ровно того
    // вида, который эта проверка обязана предотвращать.
    const upd = find(calls, 'runner_token_hash');
    expect(upd.sql).toContain('UPDATE products');
    expect(upd.params).toEqual([
      'p-1',
      crypto.createHash('sha256').update(job!.runnerToken).digest('hex'),
    ]);
    // Открытый токен в базу не ложится ни при каком раскладе.
    expect(upd.params).not.toContain(job!.runnerToken);
  });

  it('токен берётся из 32 случайных байт, а не выводится из данных задания', async () => {
    // Привязка к самому источнику случайности. Проверки «64 hex» и «sha256 от
    // токена лёг в базу» вместе переживают уменьшение энтропии до одного
    // байта: randomBytes(1).toString('hex').repeat(32) — тоже 64 hex, и хеш
    // сойдётся. Перебор 256 вариантов даёт доступ к раннеру любого продукта.
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
    // Сверх плана: toHaveBeenCalled ничего не говорит об аргументах, а их тут
    // ровно два и оба содержательные. Вызов одним аргументом (как в первой
    // редакции плана) и вызов с чужим id обе эту проверку переживают.
    expect(secrets.decrypt).toHaveBeenCalledWith(ROW.box, 'p-1');
  });

  it('пустая очередь — не ошибка', async () => {
    const { svc } = makeService({ claim: [] });

    expect(await svc.claimJob()).toBeNull();
  });

  // --- проверки сверх плана ----------------------------------------------

  it('на пустой очереди токен не выпускается и база больше не трогается', async () => {
    // Иначе холостой опрос очереди раз в несколько секунд перевыпускал бы
    // runner_token_hash — кому именно, неизвестно: задания нет. Продукт
    // потерял бы доступ раннера без единой записи в логе.
    const { svc, calls, secrets } = makeService({ claim: [] });

    await svc.claimJob();

    expect(calls).toHaveLength(1);
    expect(sqlOf(calls)).not.toContain('runner_token_hash');
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

  it('слаг, форма и коробка читаются из products, а не из задания', async () => {
    // В product_provision_jobs таких колонок нет вовсе: RETURNING j.slug упал
    // бы на живой базе колонкой, которой не существует, — а мок отдаёт свою
    // строку независимо от того, что перечислено в RETURNING, и молчит.
    const { svc, calls } = makeService();

    await svc.claimJob();

    expect(calls[0].sql).toMatch(/slug\s+FROM\s+products/);
    expect(calls[0].sql).toMatch(/kind\s+FROM\s+products/);
    expect(calls[0].sql).toMatch(/secrets_encrypted\s+FROM\s+products/);
  });

  it('токен перевыпускается тому продукту, чьё задание выдано', async () => {
    // WHERE id = $1 по jobId вместо productId: uuid на uuid, типы сойдутся,
    // UPDATE обновит ноль строк и не пожалуется. Раннер получил бы токен,
    // которого нет в базе ни у кого.
    const { svc, calls } = makeService({
      claim: [{ ...ROW, id: 'ДРУГОЙ-id-задания', product_id: 'p-77' }],
    });

    await svc.claimJob();

    expect(find(calls, 'runner_token_hash').params[0]).toBe('p-77');
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
  // секретами провижининг срывается у агента на хосте.

  it('коробка, зашифрованная при заведении, читается при выдаче задания', async () => {
    const secrets = realSecrets();
    // Ровно то, что легло бы в bytea на INSERT из задачи 3.
    const box = secrets.encrypt({ BOT_TOKEN: '123:abc' }, 'p-1');
    const { svc } = makeService({
      secrets,
      claim: [{ id: 'j-1', product_id: 'p-1', slug: 's', kind: 'bot', box }],
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
    // не отдать чужой токен бота в контейнер.
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
    const { svc, calls } = makeService();

    await svc.completeJob('j-1', { ok: true, port: 8003 });

    expect(sqlOf(calls)).not.toContain("SET status = 'running'");
    expect(sqlOf(calls)).toContain('port');
    // Сверх плана: первая проверка ловит только дословную мутацию. Форма
    // `SET port = $2, status = 'running'` подстроки "SET status = 'running'"
    // не содержит и проходит зелёной — а это ровно тот перевод в running,
    // которого здесь быть не должно. Слово целиком, в любом месте.
    expect(sqlOf(calls)).not.toContain('running');
    // Вторая ЛОЖНО ЗЕЛЁНАЯ: 'port' — подстрока, она есть и в 'report', и в
    // 'transport'. Значение порта обязано доехать параметром.
    const prod = find(calls, 'UPDATE products');
    expect(prod.sql).toContain('SET port = $2');
    expect(prod.params).toEqual(['j-1', 8003]);
    // Статус продукта здесь не трогается вовсе — ни в running, ни куда-либо
    // ещё; и старая причина отказа не подчищается (перезапишет следующая
    // попытка).
    expect(prod.sql).not.toContain('status');
    expect(prod.sql).not.toContain('provision_error');
  });

  it('успех закрывает задание — иначе повтор заведения заблокирован навсегда', async () => {
    // Частичный уникальный индекс product_provision_jobs_one_active запрещает
    // второе активное задание на продукт. Задание, оставшееся в 'running',
    // держит этот индекс: ни повтор, ни новое развёртывание уже не пройдут.
    // Проверки плана этого не видели ни в одном сценарии — там сверялся
    // только склеенный SQL, а нужные слова есть в UPDATE products.
    const { svc, calls } = makeService();

    await svc.completeJob('j-1', { ok: true, port: 8003 });

    const job = find(calls, 'UPDATE product_provision_jobs');
    expect(job.sql).toContain("status = 'done'");
    expect(job.sql).toContain('finished_at');
    expect(job.params).toEqual(['j-1']);
  });

  it('продукт без порта (бот) закрывается штатно', async () => {
    // У бота порт не публикуется. `result.port ?? null` без этой проверки не
    // сторожится ничем: undefined уехал бы в node-pg и лёг бы в колонку тем же
    // NULL — но на `result.port!` или на пропуске поля вовсе форма запроса
    // разъезжается молча.
    const { svc, calls } = makeService();

    await svc.completeJob('j-1', { ok: true });

    expect(find(calls, 'UPDATE products').params).toEqual(['j-1', null]);
  });

  it('отказ пишет причину в продукт и валит задание', async () => {
    const { svc, calls } = makeService();

    await svc.completeJob('j-1', { ok: false, error: 'порт занят' });

    const sql = sqlOf(calls);
    expect(sql).toContain('provision_error');
    expect(sql).toContain("status = 'failed'");
    // Сверх плана: обе строки выше есть в ОДНОМ запросе — UPDATE products SET
    // status = 'failed', provision_error = $2. Пропажа UPDATE по заданиям
    // проходила зелёной, а задание осталось бы в 'running' и навсегда заняло
    // бы product_provision_jobs_one_active. Две записи сверяются раздельно.
    const job = find(calls, 'UPDATE product_provision_jobs');
    expect(job.sql).toContain("status = 'failed'");
    expect(job.sql).toContain('finished_at');
    expect(job.params).toEqual(['j-1', 'порт занят']);
    // Причина обязана доехать ТЕКСТОМ, а не остаться в SQL словом
    // provision_error: пустая колонка означает карточку продукта с «не
    // получилось» без единого слова о том, почему.
    const prod = find(calls, 'UPDATE products');
    expect(prod.params).toEqual(['j-1', 'порт занят']);
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
