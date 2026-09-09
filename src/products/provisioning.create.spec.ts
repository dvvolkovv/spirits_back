import 'reflect-metadata';
import * as crypto from 'crypto';
import { ProvisioningService } from './provisioning.service';
import { SecretsService } from './secrets.service';
import { ProductsModule } from './products.module';

function makeService(over: any = {}) {
  const calls: { sql: string; params: any[] }[] = [];
  const pg = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      if (sql.includes('SELECT count(*)')) return { rows: [{ count: over.slugTaken ? '1' : '0' }] };
      if (sql.includes('INSERT INTO product_provision_jobs') && over.jobInsertFails) {
        throw Object.assign(new Error('деталь для лога'), { code: '23505' });
      }
      if (sql.includes('INSERT INTO products')) return { rows: [{ id: 'p-1' }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    }),
  };
  const secrets = { encrypt: jest.fn(() => Buffer.from('шифр')) };
  return { svc: new ProvisioningService(pg as any, secrets as any), calls, secrets };
}

const sqlOf = (c: { sql: string }[]) => c.map((x) => x.sql).join('\n');

describe('ProvisioningService.create', () => {
  it('заводит продукт в статусе provisioning и ставит задание', async () => {
    const { svc, calls } = makeService();

    await svc.create({ userId: 'u-1', name: 'Сайт', slug: 'site1', kind: 'site', secrets: {} });

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
      svc.create({ userId: 'u-1', name: 'X', slug: 'site1', kind: 'site', secrets: {} }),
    ).rejects.toThrow(/слаг/i);

    expect(sqlOf(calls)).not.toContain('INSERT INTO products');
  });

  it('в базу уходит хеш токена, а открытый возвращается вызывающему', async () => {
    const { svc, calls } = makeService();

    const res = await svc.create({ userId: 'u-1', name: 'X', slug: 's', kind: 'site', secrets: {} });

    const insert = calls.find((c) => c.sql.includes('INSERT INTO products'))!;
    expect(insert.params).not.toContain(res.runnerToken);
    expect(insert.params.some((p) => typeof p === 'string' && p.length === 64)).toBe(true);
  });

  it('секреты шифруются, а не кладутся как есть', async () => {
    const { svc, calls, secrets } = makeService();

    await svc.create({ userId: 'u-1', name: 'Бот', slug: 'b', kind: 'bot', secrets: { BOT_TOKEN: 'т' } });

    expect(secrets.encrypt).toHaveBeenCalledWith({ BOT_TOKEN: 'т' }, expect.any(String));
    const insert = calls.find((c) => c.sql.includes('INSERT INTO products'))!;
    expect(insert.params).not.toContain('т');
  });

  it('форма продукта проверяется', async () => {
    const { svc } = makeService();

    await expect(
      svc.create({ userId: 'u-1', name: 'X', slug: 's', kind: 'вирус' as any, secrets: {} }),
    ).rejects.toThrow(/форма/i);
  });

  it('секреты шифруются ПОД ТЕМ ЖЕ id, что уходит в INSERT', async () => {
    // Иначе коробка не расшифруется никогда: AAD не совпадёт. Отказ был бы
    // отложенным — заведение прошло бы, а упало бы позже, при сборке задания.
    const { svc, calls, secrets } = makeService();

    await svc.create({ userId: 'u-1', name: 'Бот', slug: 'b', kind: 'bot', secrets: { BOT_TOKEN: 'т' } });

    const usedId = (secrets.encrypt as jest.Mock).mock.calls[0][1];
    const insert = calls.find((c) => c.sql.includes('INSERT INTO products'))!;
    expect(insert.params).toContain(usedId);
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

    await svc.create({ userId: 'u-1', name: 'Бот', slug: 'bot1', kind: 'bot', secrets: { BOT_TOKEN: 'т' } });

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

    await svc.create({ userId: 'u-1', name: 'Сайт', slug: 'site2', kind: 'site', secrets: {} });

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
      name: 'Сайт',
      slug: 'site1',
      kind: 'site',
      secrets: {},
    });

    const insert = calls.find((c) => c.sql.includes('INSERT INTO products'))!;
    expect(insert.sql).toContain(
      '(id, user_id, name, slug, kind, status, checkout_path, runner_token_hash, secrets_encrypted)',
    );
    expect(insert.sql).toContain('VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)');
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
      crypto.createHash('sha256').update(res.runnerToken).digest('hex'),
      null,
    ]);
  });

  it('в базу уходит sha256 ИМЕННО выданного токена', async () => {
    // «Строка длиной 64» проходит и для самого токена (32 байта в hex — те же
    // 64 символа), и для хеша чего угодно постороннего. Тогда RunnerGuard,
    // сверяющий sha256 предъявленного токена, не нашёл бы продукт никогда, а
    // раннер получал бы 401 без объяснения.
    const { svc, calls } = makeService();

    const res = await svc.create({ userId: 'u-1', name: 'X', slug: 'site1', kind: 'site', secrets: {} });

    const insert = calls.find((c) => c.sql.includes('INSERT INTO products'))!;
    expect(insert.params).toContain(crypto.createHash('sha256').update(res.runnerToken).digest('hex'));
  });

  it('токен у каждого продукта свой', async () => {
    // Константа вместо randomBytes проходит и «не равен хешу», и проверку
    // длины: один токен открывал бы доступ ко всем продуктам сразу.
    const a = makeService();
    const b = makeService();

    const one = await a.svc.create({ userId: 'u-1', name: 'X', slug: 'site1', kind: 'site', secrets: {} });
    const two = await b.svc.create({ userId: 'u-1', name: 'X', slug: 'site2', kind: 'site', secrets: {} });

    expect(one.runnerToken).toMatch(/^[0-9a-f]{64}$/);
    expect(two.runnerToken).not.toBe(one.runnerToken);
    expect(two.productId).not.toBe(one.productId);
  });

  it('возвращается id, который реально записан, а не то, что ответила база', async () => {
    // Мок отдаёт на INSERT строку {id:'p-1'}. Реализация, читающая id из
    // ответа, вернула бы вызывающему один id, а секреты зашифровала бы под
    // другим — и коробка не расшифровалась бы никогда.
    const { svc, calls } = makeService();

    const res = await svc.create({ userId: 'u-1', name: 'X', slug: 'site1', kind: 'site', secrets: {} });

    const insert = calls.find((c) => c.sql.includes('INSERT INTO products'))!;
    expect(insert.params).toContain(res.productId);
    expect(res.productId).not.toBe('p-1');
  });

  it('задание ставится ПОСЛЕ продукта и ровно на него', async () => {
    // product_id в заданиях — внешний ключ на products. Задание, поставленное
    // раньше продукта или на другой id, упало бы на FK уже на проде, а на
    // моке проходит молча.
    const { svc, calls } = makeService();

    const res = await svc.create({ userId: 'u-1', name: 'X', slug: 'site1', kind: 'site', secrets: {} });

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

    await svc.create({ userId: 'u-1', name: 'X', slug: 'site1', kind: 'site', secrets: {} });

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
      svc.create({ userId: 'u-1', name: 'X', slug: 'Мой Сайт!', kind: 'site', secrets: {} }),
    ).rejects.toThrow(/дефис/i);

    expect(calls).toEqual([]);
  });

  it('слаг с дефисом по краям отвергается', async () => {
    // `-rf` первым аргументом docker/nginx разбирается как флаг, а метка
    // домена с дефисом по краям невалидна. Регексп из плана
    // /^[a-z0-9-]{2,40}$/ такое пропускает.
    const { svc } = makeService();

    for (const slug of ['-site', 'site-', '--']) {
      await expect(
        svc.create({ userId: 'u-1', name: 'X', slug, kind: 'site', secrets: {} }),
      ).rejects.toThrow(/дефис/i);
    }
  });

  it('слаг длиннее сорока символов отвергается', async () => {
    const { svc } = makeService();

    await expect(
      svc.create({ userId: 'u-1', name: 'X', slug: 'a'.repeat(41), kind: 'site', secrets: {} }),
    ).rejects.toThrow(/дефис/i);
  });

  it('обе законные формы продукта проходят', async () => {
    // Проверка kind, сделанная «наоборот» (пропускать только 'site'), красит
    // лишь этот тест: остальные о bot не спрашивают.
    for (const kind of ['site', 'bot'] as const) {
      const { svc, calls } = makeService();

      await svc.create({ userId: 'u-1', name: 'X', slug: 'site1', kind, secrets: {} });

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
        svc.create({ userId: 'u-1', name: 'X', slug: 'site1', kind: 'site', secrets: bad as any }),
      ).rejects.toThrow(/секрет/i);

      expect(sqlOf(calls)).not.toContain('INSERT INTO products');
    }
  });

  it('имя секрета вне формы переменной окружения отвергается', async () => {
    // Имена уезжают в окружение контейнера. 'A B' и 'A=1' там либо теряются,
    // либо подменяют соседнюю переменную — в зависимости от того, как агент
    // соберёт env-файл.
    for (const bad of [{ 'A B': 'x' }, { 'A=1': 'x' }, { '': 'x' }, { 'A\nB': 'x' }]) {
      const { svc, calls } = makeService();

      await expect(
        svc.create({ userId: 'u-1', name: 'X', slug: 'site1', kind: 'site', secrets: bad }),
      ).rejects.toThrow(/секрет/i);

      expect(sqlOf(calls)).not.toContain('INSERT INTO products');
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
      svc.create({ userId: 'u-1', name: 'X', slug: 'site1', kind: 'site', secrets: {} }),
    ).rejects.toThrow();

    const fix = calls.find((c) => c.sql.includes('UPDATE products'))!;
    expect(fix).toBeDefined();
    expect(fix.sql).toContain("status = 'failed'");
    expect(fix.sql).toContain('provision_error');
    expect(fix.params[0]).toBe(
      calls.find((c) => c.sql.includes('INSERT INTO products'))!.params[0],
    );
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
});
