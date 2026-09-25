import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import { MIGRATIONS } from './products.service';
import { ProvisioningService } from './provisioning.service';
import { SecretsService } from './secrets.service';
import { HostsService } from './hosts.service';
import { LimitsService } from './limits.service';
import { DomainsService } from './domains.service';

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;
const KEY = '00112233445566778899aabbccddeeff0f1e2d3c4b5a69788796a5b4c3d2e1f0';
const WIPE = 'TRUNCATE products, product_provision_jobs, product_turns, product_host_agent, product_hosts RESTART IDENTITY CASCADE';
const OWNER = '79030169187';

maybe('задание domain: выдача агенту и приём отчёта', () => {
  jest.setTimeout(60_000);
  let pool: Pool;
  let pg: { query: (sql: string, params?: any[]) => Promise<any> };
  let prov: ProvisioningService;
  // Настоящий сервис доменов на том же пуле: повтор после отказа (tryIssue),
  // отвязка и сверка сирот — это его операторы, а не их копии в тесте.
  let domains: DomainsService;

  const mkProduct = async (slug: string, status = 'running') => {
    const r = await pool.query(
      `INSERT INTO products (user_id, name, slug, kind, status, checkout_path, runner_token_hash, host_id, port, domain)
       VALUES ($1, $2, $2, 'site', $3, $4, $5, 'own', 8001, $6) RETURNING id`,
      [OWNER, slug, status, `/srv/${slug}`, `hash-${slug}`, `${slug}.p.linkeon.io`],
    );
    return r.rows[0].id as string;
  };
  const domain = (id: string, status: string) =>
    pool.query(
      `INSERT INTO product_domains (product_id, domain, names, token, status) VALUES ($1, 'a.ru', '{a.ru,www.a.ru}', 'lk', $2)`,
      [id, status],
    );
  const job = (id: string, kind: string, status = 'queued', ago = '0 seconds') =>
    pool
      .query(
        `INSERT INTO product_provision_jobs (product_id, kind, status, created_at)
         VALUES ($1, $2, $3, now() - $4::interval) RETURNING id`,
        [id, kind, status, ago],
      )
      .then((r) => r.rows[0].id as string);
  const productRow = async () => (await pool.query(`SELECT status, provision_error FROM products`)).rows[0];
  const domainRow = async () => (await pool.query(`SELECT status, error, error_reason FROM product_domains`)).rows[0];
  const domainCount = async () => (await pool.query(`SELECT count(*) FROM product_domains`)).rows[0].count;
  const jobRow = async (jobId: string) =>
    (await pool.query(`SELECT status, error FROM product_provision_jobs WHERE id = $1`, [jobId])).rows[0];
  const watchWarn = () => jest.spyOn((prov as any).logger, 'warn').mockImplementation(() => undefined);
  /**
   * Отчёт агента обязан ПРИНИМАТЬСЯ — это утверждение, а не надежда. Отказ
   * оператора (например, 23514 по product_domains_error_pair) — это 500
   * агенту, откат закрытия задания вместе со строкой домена и задание в
   * running до сборщика зависших. Здесь такой отказ краснит утверждение с
   * текстом ошибки базы, а не роняет тест посторонним исключением.
   */
  const report = (jobId: string, result: { ok: boolean; error?: string }) =>
    expect(prov.completeJob(jobId, result)).resolves.toBeUndefined();

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG, max: 8 });
    pg = { query: (sql: string, params?: any[]) => pool.query(sql, params) };
    for (const f of MIGRATIONS) await pool.query(fs.readFileSync(path.join(__dirname, 'migrations', f), 'utf8'));
    const n = await pool.query('SELECT count(*) FROM products');
    if (Number(n.rows[0].count) > 0) throw new Error('PROVISIONING_PG_URL указывает на НЕпустую базу');
    const secrets = new SecretsService({ get: (k: string) => (k === 'PRODUCT_SECRETS_KEY' ? KEY : undefined) } as any);
    prov = new ProvisioningService(pg as any, secrets, new HostsService(pg as any), new LimitsService(pg as any));
    (prov as any).fetchFn = async () => ({ status: 200 });
    domains = new DomainsService(pg as any);
  });
  afterAll(async () => {
    await pool?.query(WIPE);
    await pool?.end();
  });
  beforeEach(async () => {
    await pool.query(WIPE);
    await pool.query(
      `INSERT INTO product_hosts (id, ssh_target, public_ip, domain_suffix, agent_token_hash, capacity, audience)
       VALUES ('own', 'root@139.59.210.42', '139.59.210.42', 'p.linkeon.io', 'probe-hash', 20, 'own')`,
    );
  });
  afterEach(() => jest.restoreAllMocks());

  // Главный сторож задачи: без своей ветки в CASE задание domain выдавалось
  // бы только у спящих, а у работающего висело бы вечно.
  it('задание domain выдаётся у работающего продукта', async () => {
    const id = await mkProduct('shop', 'running');
    await domain(id, 'issuing');
    await job(id, 'domain');
    expect(await prov.claimJob('own')).toMatchObject({
      jobKind: 'domain', slug: 'shop', port: 8001, customNames: ['a.ru', 'www.a.ru'], vhostMode: 'proxy',
    });
  });

  it('у спящего и погашенного — тоже, в режиме заглушки', async () => {
    for (const status of ['sleeping', 'blocked']) {
      await pool.query('TRUNCATE products, product_provision_jobs RESTART IDENTITY CASCADE');
      const id = await mkProduct(`shop-${status}`, status);
      await domain(id, 'issuing');
      await job(id, 'domain');
      expect(await prov.claimJob('own')).toMatchObject({ jobKind: 'domain', vhostMode: 'asleep' });
    }
  });

  // Проснулся, но promoteReady ещё не перевёл в running: контейнер уже жив,
  // конфиг уже прокси. Режим по статусу 'sleeping' вернул бы на адрес 503.
  it('проснувшийся, но ещё не переведённый — режим прокси, а не заглушка', async () => {
    const id = await mkProduct('shop', 'sleeping');
    await job(id, 'wake', 'done', '1 minute');
    await domain(id, 'issuing');
    await job(id, 'domain');
    expect(await prov.claimJob('own')).toMatchObject({ jobKind: 'domain', vhostMode: 'proxy' });
  });

  it('у заводящегося — не выдаётся', async () => {
    const id = await mkProduct('shop', 'provisioning');
    await job(id, 'domain');
    expect(await prov.claimJob('own')).toBeNull();
  });

  it('отвязка (removing) приезжает с пустым списком имён', async () => {
    const id = await mkProduct('shop');
    await domain(id, 'removing');
    await job(id, 'domain');
    expect(await prov.claimJob('own')).toMatchObject({ jobKind: 'domain', customNames: [] });
  });

  // Имена в КАЖДОМ задании: иначе первый же сон переписал бы конфиг без них.
  it('сон и пробуждение несут работающий домен', async () => {
    const id = await mkProduct('shop', 'sleeping');
    await domain(id, 'active');
    await job(id, 'wake');
    expect(await prov.claimJob('own')).toMatchObject({ jobKind: 'wake', customNames: ['a.ru', 'www.a.ru'] });
  });

  it('отказавший домен в задания не попадает', async () => {
    const id = await mkProduct('shop', 'sleeping');
    await domain(id, 'failed');
    await job(id, 'wake');
    expect(await prov.claimJob('own')).toMatchObject({ customNames: [] });
  });

  it('успех привязки: issuing → active без ошибки, продукт не тронут', async () => {
    const id = await mkProduct('shop');
    await domain(id, 'issuing');
    const jobId = await job(id, 'domain');
    await prov.claimJob('own');
    await report(jobId, { ok: true });
    expect((await pool.query(`SELECT status, error, error_reason, activated_at FROM product_domains`)).rows[0]).toEqual({
      status: 'active', error: null, error_reason: null, activated_at: expect.any(Date),
    });
    expect(await jobRow(jobId)).toEqual({ status: 'done', error: null });
    expect(await productRow()).toEqual({ status: 'running', provision_error: null });
  });

  it('успех отвязки: строка удалена', async () => {
    const id = await mkProduct('shop');
    await domain(id, 'removing');
    const jobId = await job(id, 'domain');
    await prov.claimJob('own');
    await report(jobId, { ok: true });
    expect(await domainCount()).toBe('0');
  });

  // Отказ выпуска — это состояние домена, а не «ошибка заведения» продукта.
  // Код причины — парой с текстом (product_domains_error_pair): текст без кода
  // ограничение не пустит, и весь отчёт агента откатился бы вместе с ним —
  // задание висело бы в running до сборщика, а строка Let's Encrypt пропала бы.
  it('отказ: домен в failed с текстом и кодом, продукт не тронут', async () => {
    const id = await mkProduct('shop');
    await domain(id, 'issuing');
    const jobId = await job(id, 'domain');
    await prov.claimJob('own');
    await report(jobId, { ok: false, error: 'Challenge failed for domain a.ru' });
    expect(await domainRow()).toEqual({
      status: 'failed', error: 'Challenge failed for domain a.ru', error_reason: 'issue_failed',
    });
    expect(await jobRow(jobId)).toEqual({ status: 'failed', error: 'Challenge failed for domain a.ru' });
    expect(await productRow()).toEqual({ status: 'running', provision_error: null });
  });

  it('отказ отвязки: failed с пометкой и своим кодом, домен можно отвязать снова', async () => {
    const id = await mkProduct('shop');
    await domain(id, 'removing');
    const jobId = await job(id, 'domain');
    await prov.claimJob('own');
    await report(jobId, { ok: false, error: 'nginx -t failed' });
    expect(await domainRow()).toEqual({
      status: 'failed', error: 'отвязка не удалась: nginx -t failed', error_reason: 'remove_failed',
    });
    await expect(domains.detach(OWNER, id)).resolves.toEqual({ removed: 'queued' });
  });

  // Полный круг через настоящие операторы: отказ агента, повтор кнопкой
  // (tryIssue из failed снимает пару), успех. В работающем домене не
  // остаётся ни текста прошлого отказа, ни его кода.
  it('отказ, повтор, успех: домен работает без следов прошлой ошибки', async () => {
    const id = await mkProduct('shop');
    await domain(id, 'issuing');
    const first = await job(id, 'domain');
    await prov.claimJob('own');
    await report(first, { ok: false, error: 'Challenge failed for domain a.ru' });
    await expect(domains.tryIssue(id, 'lk', 'failed')).resolves.toBe('queued');
    const second = await prov.claimJob('own');
    expect(second).toMatchObject({ jobKind: 'domain', customNames: ['a.ru', 'www.a.ru'] });
    await report(second!.jobId, { ok: true });
    expect(await domainRow()).toEqual({ status: 'active', error: null, error_reason: null });
  });

  // Задание-уборку ставит отвязка отказавшей заявки при занятом домене
  // (DomainsService.dropOccupiedFailed): строку удаляют, задание ставят тем
  // же оператором. Агент получает пустой список имён и снимает свои хвосты.
  describe('задание-уборка: строки домена у продукта нет', () => {
    it('выдаётся с пустым списком имён, режим — по статусу продукта', async () => {
      for (const [status, mode] of [['running', 'proxy'], ['sleeping', 'asleep'], ['blocked', 'asleep']]) {
        await pool.query('TRUNCATE products, product_provision_jobs RESTART IDENTITY CASCADE');
        const id = await mkProduct(`shop-${status}`, status);
        await job(id, 'domain');
        expect(await prov.claimJob('own')).toMatchObject({ jobKind: 'domain', customNames: [], vhostMode: mode });
      }
    });

    it('успех: задание закрыто, строк домена нет, продукт не тронут', async () => {
      const id = await mkProduct('shop');
      const jobId = await job(id, 'domain');
      await prov.claimJob('own');
      await report(jobId, { ok: true });
      expect(await jobRow(jobId)).toEqual({ status: 'done', error: null });
      expect(await domainCount()).toBe('0');
      expect(await productRow()).toEqual({ status: 'running', provision_error: null });
    });

    it('отказ: задание в failed с причиной, больше ничего не тронуто и в лог не пишется', async () => {
      const id = await mkProduct('shop');
      const jobId = await job(id, 'domain');
      await prov.claimJob('own');
      const warn = watchWarn();
      await report(jobId, { ok: false, error: 'nginx -t failed' });
      expect(await jobRow(jobId)).toEqual({ status: 'failed', error: 'nginx -t failed' });
      expect(await domainCount()).toBe('0');
      expect(await productRow()).toEqual({ status: 'running', provision_error: null });
      // Задание было в running, закрылось — отчёт доехал, жаловаться не на что.
      expect(warn).not.toHaveBeenCalled();
    });
  });

  // Уборка стоит в очереди, а человек тем временем привязал НОВЫЙ домен:
  // строка в awaiting_dns появилась у продукта уже после удаления старой.
  // Отчёт уборки обязан закрыть только задание — ни успех, ни отказ не
  // вправе ни активировать новую заявку (её TXT никто не проверял), ни
  // пометить её отказом, ни удалить.
  describe('уборка после отвязки при занятом домене и новая заявка', () => {
    const arrange = async () => {
      const mine = await mkProduct('shop');
      const other = await mkProduct('rival');
      await pool.query(
        `INSERT INTO product_domains (product_id, domain, names, token, status, error, error_reason)
         VALUES ($1, 'a.ru', '{a.ru}', 'lk-old', 'failed', 'занят', 'taken'),
                ($2, 'a.ru', '{a.ru}', 'lk-rival', 'active', NULL, NULL)`,
        [mine, other],
      );
      // Настоящая отвязка: перевод в removing упирается в индекс занятых,
      // строка удаляется и ставится задание-уборка (dropOccupiedFailed).
      await expect(domains.detach(OWNER, mine)).resolves.toEqual({ removed: 'now' });
      await pool.query(
        `INSERT INTO product_domains (product_id, domain, names, token) VALUES ($1, 'b.ru', '{b.ru,www.b.ru}', 'lk-new')`,
        [mine],
      );
      const claimed = await prov.claimJob('own');
      expect(claimed).toMatchObject({ jobKind: 'domain', customNames: [] });
      return { mine, jobId: claimed!.jobId };
    };
    const fresh = async (productId: string) =>
      (await pool.query(
        `SELECT domain, token, status, error, error_reason, activated_at FROM product_domains WHERE product_id = $1`,
        [productId],
      )).rows;
    const untouched = [{ domain: 'b.ru', token: 'lk-new', status: 'awaiting_dns', error: null, error_reason: null, activated_at: null }];

    it('успех уборки новую заявку не трогает', async () => {
      const { mine, jobId } = await arrange();
      await report(jobId, { ok: true });
      expect(await jobRow(jobId)).toEqual({ status: 'done', error: null });
      expect(await fresh(mine)).toEqual(untouched);
    });

    it('отказ уборки новую заявку не трогает', async () => {
      const { mine, jobId } = await arrange();
      await report(jobId, { ok: false, error: 'nginx -t failed' });
      expect(await jobRow(jobId)).toEqual({ status: 'failed', error: 'nginx -t failed' });
      expect(await fresh(mine)).toEqual(untouched);
    });
  });

  // Сверка сирот (DomainsService.reconcileOrphans) считает сиротой строку в
  // issuing или removing, у продукта которой нет активного задания domain.
  // Закрытие задания и перевод строки — один оператор, поэтому после отчёта
  // сироте взяться неоткуда: строка уже ушла из issuing/removing. Разорви их —
  // и сверка затёрла бы отказ агента своим «выпуск прерван».
  it('после отчёта сверка сирот строку не трогает — при любом исходе', async () => {
    const cases: [string, boolean, any][] = [
      ['issuing', true, { status: 'active', error: null, error_reason: null }],
      ['issuing', false, { status: 'failed', error: 'сбой', error_reason: 'issue_failed' }],
      ['removing', true, undefined],
      ['removing', false, { status: 'failed', error: 'отвязка не удалась: сбой', error_reason: 'remove_failed' }],
    ];
    for (const [from, ok, after] of cases) {
      await pool.query('TRUNCATE products, product_provision_jobs RESTART IDENTITY CASCADE');
      const id = await mkProduct('shop');
      await domain(id, from);
      const jobId = await job(id, 'domain');
      await prov.claimJob('own');
      await report(jobId, ok ? { ok } : { ok, error: 'сбой' });
      await expect(domains.reconcileOrphans()).resolves.toBe(0);
      expect(await domainRow()).toEqual(after);
    }
  });

  // Замок тот же, что у completeJob: `status = 'running'`. Задание, снятое
  // снаружи (гашение, сборщик зависших), отчётом не закрывается и строку
  // домена не двигает: запоздалый «успех» не должен выдать за работающий
  // домен, чьё задание сняли, — его судьбу решает сверка сирот.
  it('отчёт по снятому заданию: домен не тронут, след в логе', async () => {
    const id = await mkProduct('shop');
    await domain(id, 'issuing');
    const jobId = await job(id, 'domain');
    await prov.claimJob('own');
    await pool.query(
      `UPDATE product_provision_jobs SET status = 'failed', error = 'снято гашением', finished_at = now() WHERE id = $1`,
      [jobId],
    );
    const warn = watchWarn();
    await report(jobId, { ok: true });
    expect(await domainRow()).toEqual({ status: 'issuing', error: null, error_reason: null });
    expect(await jobRow(jobId)).toEqual({ status: 'failed', error: 'снято гашением' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(jobId);
  });

  // Сервер выкачен раньше агента (или PHASE 4 молча не доехала): выпущенный
  // агент задания domain не знает и отказывает дословной строкой workFor.
  // Отказ Let's Encrypt здесь ни при чём — и пределы пользователя (повторы в
  // час, задания domain в час) такой отказ расходовать не должен: иначе
  // каждая готовая заявка сгорала бы как «сертификат не выпущен» и запирала
  // кнопку на час.
  describe('агент старее сервера: неизвестный вид задания', () => {
    // Дословно так отвечает выпущенный агент (product-runner/src/host/index.ts, workFor).
    const OUTDATED =
      'неизвестный вид задания: "domain". Агент умеет provision, sleep, wake — эта работа сделана НЕ БЫЛА, '
      + 'на хосте ничего не тронуто. Похоже, сервер новее агента на машине продуктов.';

    it('отказ выпуска — failed с кодом agent_outdated, а не issue_failed', async () => {
      const id = await mkProduct('shop');
      await domain(id, 'issuing');
      const jobId = await job(id, 'domain');
      await prov.claimJob('own');
      await report(jobId, { ok: false, error: OUTDATED });
      expect(await domainRow()).toEqual({ status: 'failed', error: OUTDATED, error_reason: 'agent_outdated' });
      expect(await jobRow(jobId)).toEqual({ status: 'failed', error: OUTDATED });
      expect(await productRow()).toEqual({ status: 'running', provision_error: null });
    });

    // Отвязку устаревший агент тоже не сделал — и «Проверить снова» после неё
    // обязан отбиваться как после любой незавершённой отвязки (detach_pending):
    // иначе кнопка выпустила бы домен, который человек отвязывал.
    it('отказ отвязки — по-прежнему remove_failed: «Проверить снова» не выпускает отвязываемый домен', async () => {
      const id = await mkProduct('shop');
      await domain(id, 'removing');
      const jobId = await job(id, 'domain');
      await prov.claimJob('own');
      await report(jobId, { ok: false, error: OUTDATED });
      expect(await domainRow()).toMatchObject({ status: 'failed', error_reason: 'remove_failed' });
    });

    // Маркер — только в НАЧАЛЕ текста. В середину он попадает из чужих рук:
    // Let's Encrypt цитирует в отказе ответ сервера пользователя, и страница
    // с этой фразой иначе выводила бы его отказы из-под пределов.
    it('маркер не в начале текста — обычный отказ issue_failed', async () => {
      const id = await mkProduct('shop');
      await domain(id, 'issuing');
      const jobId = await job(id, 'domain');
      await prov.claimJob('own');
      const quoted = `Invalid response from http://a.ru/.well-known/acme-challenge/x: "${OUTDATED}"`;
      await report(jobId, { ok: false, error: quoted });
      expect(await domainRow()).toMatchObject({ status: 'failed', error_reason: 'issue_failed' });
    });

    it('такие отказы не расходуют ни окно повторов, ни задания domain в час', async () => {
      const id = await mkProduct('shop');
      await domain(id, 'issuing');
      await job(id, 'domain');
      // Больше и RETRIES_PER_HOUR (3), и DOMAIN_JOBS_PER_HOUR (6).
      for (let i = 0; i < 8; i++) {
        const claimed = await prov.claimJob('own');
        expect(claimed).toMatchObject({ jobKind: 'domain' });
        await report(claimed!.jobId, { ok: false, error: OUTDATED });
        await expect(domains.tryIssue(id, 'lk', 'failed')).resolves.toBe('queued');
      }
      expect((await pool.query(`SELECT attempts FROM product_domains`)).rows[0].attempts).toBe(0);
    });

    // Обратная сторона: обычный отказ окно повторов расходует, как и раньше.
    it('обычный отказ — счётчик повторов растёт, после трёх повторов limited', async () => {
      const id = await mkProduct('shop');
      await domain(id, 'issuing');
      await job(id, 'domain');
      const outcomes: string[] = [];
      for (let i = 0; i < 4; i++) {
        const claimed = await prov.claimJob('own');
        await report(claimed!.jobId, { ok: false, error: 'Challenge failed for domain a.ru' });
        outcomes.push(await domains.tryIssue(id, 'lk', 'failed'));
      }
      expect(outcomes).toEqual(['queued', 'queued', 'queued', 'limited']);
    });
  });

  // Отказ агента — вывод certbot целиком, и длина его ничем не ограничена,
  // кроме общего потолка приёма отчёта (ERROR_MAX в host.controller.ts, 2000).
  // Строка домена уезжает в кабинет и ассистенту — ей свой потолок.
  it('длинный отказ подрезается до 1000 знаков с многоточием — и в задании, и в строке домена', async () => {
    const id = await mkProduct('shop');
    await domain(id, 'issuing');
    const jobId = await job(id, 'domain');
    await prov.claimJob('own');
    await report(jobId, { ok: false, error: 'certbot: ' + 'ш'.repeat(5000) });
    const j = await jobRow(jobId);
    expect(j.error).toHaveLength(1000);
    expect(j.error.endsWith('…')).toBe(true);
    expect(j.error.startsWith('certbot: ')).toBe(true);
    expect((await domainRow()).error).toBe(j.error);
  });

  it('отказ ровно в 1000 знаков не подрезается', async () => {
    const id = await mkProduct('shop');
    await domain(id, 'issuing');
    const jobId = await job(id, 'domain');
    await prov.claimJob('own');
    const exact = 'э'.repeat(1000);
    await report(jobId, { ok: false, error: exact });
    expect((await jobRow(jobId)).error).toBe(exact);
  });

  // Сборщик зависших снимает задание ЛЮБОГО вида и пишет в него причину.
  // «Срок заведения» у задания своего домена — неправда: заведения не было.
  it('сборщик зависших пишет заданию domain свою причину, а не «срок заведения»', async () => {
    const id = await mkProduct('shop');
    await domain(id, 'issuing');
    const jobId = await job(id, 'domain', 'running', '11 minutes');
    await pool.query(`UPDATE product_provision_jobs SET started_at = created_at WHERE id = $1`, [jobId]);
    await prov.failStaleProvisioning();
    const j = await jobRow(jobId);
    expect(j.status).toBe('failed');
    expect(j.error).toBe('срок задания своего домена истёк (10 мин)');
    // Продукт работает — сборщик его не трогает.
    expect(await productRow()).toEqual({ status: 'running', provision_error: null });
  });

  // Живой дефект, который сторожит этот тест: «последнее задание» видело бы
  // domain вместо пробуждения, и проснувшийся продукт навсегда оставался бы
  // «спящим» с работающим контейнером.
  it('задание domain после пробуждения не мешает переводу в running', async () => {
    const id = await mkProduct('shop', 'sleeping');
    await pool.query(`UPDATE products SET runner_seen_at = now() WHERE id = $1`, [id]);
    await job(id, 'wake', 'done', '2 minutes');
    await job(id, 'domain', 'done', '1 minute');
    await prov.promoteReady();
    expect((await productRow()).status).toBe('running');
  });
});
