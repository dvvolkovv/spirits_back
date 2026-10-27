import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Pool } from 'pg';
import { MIGRATIONS } from './products.service';
import { ProductPurgeService } from './product-purge.service';
import { ProductLifecycleService } from './product-lifecycle.service';
import { PURGED_TEXT } from './provisioning.service';

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;

maybe('обход стирания и резервные копии против живого Postgres', () => {
  // Миграции в beforeAll — как в соседних pg-спеках: под нагрузкой ноды
  // пяти секунд по умолчанию на них не хватает.
  jest.setTimeout(30_000);

  let pool: Pool;
  let svc: ProductPurgeService;
  let tmp: string;
  let errors: string[];
  let warns: string[];
  // Настоящий путь временного каталога: на macOS os.tmpdir() — /var/…, а на
  // деле /private/var/…, и сверка корня копий (realpath знак в знак)
  // отказала бы на ровном месте.
  const TMP_ROOT = fs.realpathSync(os.tmpdir());
  const HOST = 'purge-host';
  const OUTDATED = 'неизвестный вид задания: "purge". Агент умеет provision, sleep, wake, domain — эта работа сделана НЕ БЫЛА, на хосте ничего не тронуто. Похоже, сервер новее агента на машине продуктов.';

  /** По умолчанию — удалённый 31 день назад, на машине HOST. */
  async function deleted(o: {
    purgeAfterMs: number | null; purged?: boolean; repoUrl?: string | null; slug?: string;
    archived?: boolean; status?: string; host?: string | null;
  }) {
    const id = crypto.randomUUID();
    const slug = o.slug ?? `d-${id.slice(0, 8)}`;
    const archived = o.archived ?? true;
    await pool.query(
      `INSERT INTO products (id, user_id, name, slug, kind, status, checkout_path, runner_token_hash, host_id,
                             archived_at, purge_after, purged_at, repo_url)
       VALUES ($1, 'u1', 'П', $2, 'site', $7, '/product', $3, $8,
               CASE WHEN $9 THEN now() - interval '31 days' END,
               CASE WHEN $4::double precision IS NULL THEN NULL
                    ELSE now() + make_interval(secs => $4::double precision / 1000) END,
               CASE WHEN $5 THEN now() END, $6)`,
      [id, slug, `h-${id}`, o.purgeAfterMs, !!o.purged, o.repoUrl ?? null,
       o.status ?? (archived ? 'archived' : 'running'), o.host === undefined ? HOST : o.host, archived],
    );
    return { id, slug };
  }
  const jobsOf = async (id: string) =>
    (await pool.query(`SELECT kind, status FROM product_provision_jobs WHERE product_id = $1 ORDER BY created_at`, [id])).rows;
  const repoUrlOf = async (id: string) =>
    (await pool.query(`SELECT repo_url FROM products WHERE id = $1`, [id])).rows[0].repo_url;
  const failedPurge = (productId: string, o: { started: boolean; error?: string }) =>
    pool.query(
      `INSERT INTO product_provision_jobs (product_id, kind, status, started_at, error)
       VALUES ($1, 'purge', 'failed', CASE WHEN $2 THEN now() END, $3)`,
      [productId, o.started, o.error ?? null],
    );

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG, max: 4 });
    for (const f of MIGRATIONS) await pool.query(fs.readFileSync(path.join(__dirname, 'migrations', f), 'utf8'));
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE products, product_provision_jobs, product_actions, product_hosts RESTART IDENTITY CASCADE');
    await pool.query(
      `INSERT INTO product_hosts (id, ssh_target, public_ip, domain_suffix, agent_token_hash, capacity, audience)
       VALUES ($1, 'root@10.77.0.1', '10.77.0.1', 'p.example', 'purge-spec-hash', 20, 'clients')`,
      [HOST],
    );
    // Свежий сервис на тест: разовые предупреждения живут в нём (на процесс).
    errors = [];
    warns = [];
    svc = new ProductPurgeService({ query: (s: string, p?: any[]) => pool.query(s, p) } as any);
    (svc as any).logger = { error: (m: string) => errors.push(m), warn: (m: string) => warns.push(m), log: () => undefined };
    tmp = fs.mkdtempSync(path.join(TMP_ROOT, 'pl2-purge-'));
    process.env.PRODUCT_REPOS_DIR = path.join(tmp, 'product-repos');
    fs.mkdirSync(process.env.PRODUCT_REPOS_DIR);
  });
  afterEach(() => {
    delete process.env.PRODUCT_REPOS_DIR;
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  afterAll(async () => {
    await pool.query('TRUNCATE products, product_provision_jobs, product_actions, product_hosts RESTART IDENTITY CASCADE');
    await pool.end();
  });

  it('стирание ставится только удалённому после срока, не стёртому и без активного задания', async () => {
    const due = await deleted({ purgeAfterMs: -60_000 });
    const early = await deleted({ purgeAfterMs: 86_400_000 });
    const gone = await deleted({ purgeAfterMs: -60_000, purged: true });
    const busy = await deleted({ purgeAfterMs: -60_000 });
    await pool.query(`INSERT INTO product_provision_jobs (product_id, kind, status) VALUES ($1, 'sleep', 'queued')`, [busy.id]);

    expect(await svc.queuePurges()).toBe(1);
    expect(await jobsOf(due.id)).toEqual([{ kind: 'purge', status: 'queued' }]);
    expect(await jobsOf(early.id)).toEqual([]);
    expect(await jobsOf(gone.id)).toEqual([]);
    expect(await svc.queuePurges()).toBe(0);
  });

  it('после трёх провалов подряд стирание не ставится; снятые до выдачи провалом не считаются', async () => {
    const p = await deleted({ purgeAfterMs: -60_000 });
    for (let i = 0; i < 3; i++) {
      await pool.query(`INSERT INTO product_provision_jobs (product_id, kind, status) VALUES ($1, 'purge', 'failed')`, [p.id]);
    }
    expect(await svc.queuePurges()).toBe(1);
    await pool.query(`UPDATE product_provision_jobs SET status = 'failed', started_at = now() WHERE product_id = $1`, [p.id]);
    expect(await svc.queuePurges()).toBe(0);
  });

  it('провалы стирания из прошлого цикла удаления в потолок не идут — как у сна удалённого', async () => {
    const p = await deleted({ purgeAfterMs: -60_000 });
    for (let i = 0; i < 3; i++) {
      await pool.query(
        `INSERT INTO product_provision_jobs (product_id, kind, status, created_at, started_at)
         VALUES ($1, 'purge', 'failed', now() - interval '40 days', now() - interval '40 days')`,
        [p.id],
      );
    }
    expect(await svc.queuePurges()).toBe(1);
  });

  it('отказы старого агента «неизвестный вид задания» в потолок не идут: на машине ничего не тронуто', async () => {
    const p = await deleted({ purgeAfterMs: -60_000 });
    for (let i = 0; i < 3; i++) await failedPurge(p.id, { started: true, error: OUTDATED });
    expect(await svc.queuePurges()).toBe(1);
    expect(errors.filter((m) => m.includes(p.slug))).toEqual([]);
    // Но и не молча: агента машины пора обновить.
    expect(warns.filter((m) => m.includes(p.slug) && m.includes('обновить'))).toHaveLength(1);

    // Свой отказ в середине текста (цитата чужого ответа) — обычный провал.
    await pool.query(`DELETE FROM product_provision_jobs WHERE product_id = $1`, [p.id]);
    for (let i = 0; i < 3; i++) await failedPurge(p.id, { started: true, error: `rm отказал: ${OUTDATED}` });
    expect(await svc.queuePurges()).toBe(0);
  });

  it('продукт без машины — стирание не ставится (его некому забрать), строка error в лог раз на процесс', async () => {
    const p = await deleted({ purgeAfterMs: -60_000, host: null });
    expect(await svc.queuePurges()).toBe(0);
    expect(await svc.queuePurges()).toBe(0);
    expect(await jobsOf(p.id)).toEqual([]);
    const lines = errors.filter((m) => m.includes(p.slug));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/без машины.*стирание только на сервере/);
  });

  it('стирание снова и снова снято невыданным — предупреждение раз на процесс, постановка не прекращается', async () => {
    const p = await deleted({ purgeAfterMs: -60_000 });
    for (let i = 0; i < 3; i++) await failedPurge(p.id, { started: false, error: 'срок стирания истёк (10 мин)' });
    expect(await svc.queuePurges()).toBe(1);
    await pool.query(`UPDATE product_provision_jobs SET status = 'failed', finished_at = now() WHERE product_id = $1 AND status = 'queued'`, [p.id]);
    expect(await svc.queuePurges()).toBe(1);
    expect(warns.filter((m) => m.includes(p.slug) && m.includes('невыданным'))).toHaveLength(1);
    expect(errors.filter((m) => m.includes(p.slug))).toEqual([]);
  });

  it('живой и вернувшийся продукты обход не трогает вовсе: ни ключей, ни текстов, ни заданий', async () => {
    const live = await deleted({ archived: false, status: 'running', purgeAfterMs: null });
    // Вернувшийся: restore() снимает и archived_at, и purge_after; здесь
    // худший случай — срок остался в прошлом, а архива уже нет.
    const restored = await deleted({ archived: false, status: 'sleeping', purgeAfterMs: -86_400_000 });
    for (const p of [live, restored]) {
      await pool.query(
        `UPDATE products SET secrets_encrypted = decode('01', 'hex'), first_prompt = 'п', first_prompt_channel = 'web' WHERE id = $1`,
        [p.id],
      );
      await pool.query(
        `INSERT INTO product_turns (product_id, user_id, channel, prompt, result, status) VALUES ($1, 'u1', 'web', 'правка', 'итог', 'done')`,
        [p.id],
      );
      await pool.query(
        `INSERT INTO product_actions (user_id, product_id, kind, status, channel, payload, secrets_box)
         VALUES ('u1', $1, 'create_site', 'done', 'web', '{"name":"П","prompt":"магазин"}'::jsonb, NULL),
                ('u1', $1, 'keys', 'working', 'web', '{"keyNames":["A"]}'::jsonb, decode('02', 'hex'))`,
        [p.id],
      );
    }

    expect(await svc.wipeExpired()).toBe(0);
    expect(await svc.queuePurges()).toBe(0);

    for (const p of [live, restored]) {
      const row = (await pool.query(`SELECT secrets_encrypted IS NOT NULL AS keys, first_prompt FROM products WHERE id = $1`, [p.id])).rows[0];
      expect(row).toEqual({ keys: true, first_prompt: 'п' });
      expect((await pool.query(`SELECT prompt, result FROM product_turns WHERE product_id = $1`, [p.id])).rows).toEqual([{ prompt: 'правка', result: 'итог' }]);
      const cards = await pool.query(`SELECT kind, payload, secrets_box IS NOT NULL AS boxed FROM product_actions WHERE product_id = $1 ORDER BY kind`, [p.id]);
      expect(cards.rows).toEqual([
        { kind: 'create_site', payload: { name: 'П', prompt: 'магазин' }, boxed: false },
        { kind: 'keys', payload: { keyNames: ['A'] }, boxed: true },
      ]);
      expect(await jobsOf(p.id)).toEqual([]);
    }
  });

  it('после срока возврата ключи и первая правка стираются на сервере сразу — до машины', async () => {
    const due = await deleted({ purgeAfterMs: -60_000 });
    const early = await deleted({ purgeAfterMs: 86_400_000 });
    await pool.query(
      `UPDATE products SET secrets_encrypted = decode('01', 'hex'), first_prompt = 'п', first_prompt_channel = 'web' WHERE id = ANY($1::uuid[])`,
      [[due.id, early.id]],
    );
    expect(await svc.wipeExpired()).toBe(1);
    const rows = await pool.query(`SELECT id, secrets_encrypted, first_prompt, purged_at FROM products WHERE id = ANY($1::uuid[])`, [[due.id, early.id]]);
    const byId = Object.fromEntries(rows.rows.map((r: any) => [r.id, r]));
    expect(byId[due.id]).toMatchObject({ secrets_encrypted: null, first_prompt: null, purged_at: null });
    expect(byId[early.id].secrets_encrypted).not.toBeNull();
    expect(byId[early.id].first_prompt).toBe('п');
  });

  it('после срока стираются и тексты правок, первая правка в карточках и коробки ключей; повтор — ноль', async () => {
    const due = await deleted({ purgeAfterMs: -60_000 });
    const early = await deleted({ purgeAfterMs: 86_400_000 });
    const turn = async (productId: string) =>
      (await pool.query(
        `INSERT INTO product_turns (product_id, user_id, channel, prompt, result, error, status, tokens_spent, sha_before, sha_after)
         VALUES ($1, 'u1', 'web', 'вот токен 123456:TEST-not-a-token, поставь его', 'готово', NULL, 'done', 42, 'aaa111', 'bbb222')
         RETURNING id`,
        [productId],
      )).rows[0].id as string;
    const card = async (productId: string, kind: string, status: string, payload: object, box: boolean) =>
      (await pool.query(
        `INSERT INTO product_actions (user_id, product_id, kind, status, channel, payload, secrets_box)
         VALUES ('u1', $1, $2, $3, 'web', $4::jsonb, CASE WHEN $5 THEN decode('02', 'hex') END) RETURNING id`,
        [productId, kind, status, JSON.stringify(payload), box],
      )).rows[0].id as string;
    const tDue = await turn(due.id);
    const tEarly = await turn(early.id);
    const createDue = await card(due.id, 'create_site', 'done', { name: 'П', prompt: 'магазин чая' }, false);
    const keysDue = await card(due.id, 'keys', 'working', { keyNames: ['A'] }, true);
    const createEarly = await card(early.id, 'create_site', 'done', { name: 'П', prompt: 'магазин чая' }, false);
    const keysEarly = await card(early.id, 'keys', 'working', { keyNames: ['A'] }, true);

    expect(await svc.wipeExpired()).toBe(1);

    const turnRow = async (id: string) =>
      (await pool.query(`SELECT prompt, result, error, status, tokens_spent::int AS tokens, sha_before, sha_after FROM product_turns WHERE id = $1`, [id])).rows[0];
    const cardRow = async (id: string) =>
      (await pool.query(`SELECT status, payload, secrets_box IS NOT NULL AS boxed FROM product_actions WHERE id = $1`, [id])).rows[0];
    expect(await turnRow(tDue)).toEqual({ prompt: PURGED_TEXT, result: PURGED_TEXT, error: null, status: 'done', tokens: 42, sha_before: 'aaa111', sha_after: 'bbb222' });
    expect(await cardRow(createDue)).toEqual({ status: 'done', payload: { name: 'П' }, boxed: false });
    expect(await cardRow(keysDue)).toEqual({ status: 'working', payload: { keyNames: ['A'] }, boxed: false });

    expect((await turnRow(tEarly)).prompt).toMatch(/123456:TEST/);
    expect(await cardRow(createEarly)).toMatchObject({ payload: { name: 'П', prompt: 'магазин чая' } });
    expect(await cardRow(keysEarly)).toMatchObject({ boxed: true });

    // Стёртое не трогается каждый час заново: строка продукта не попадает
    // в обход, пока стирать у неё нечего.
    expect(await svc.wipeExpired()).toBe(0);
  });

  it('сон удалённых не снимает стоящее в очереди стирание', async () => {
    const p = await deleted({ purgeAfterMs: -60_000 });
    await svc.queuePurges();
    const pg = { query: (s: string, q?: any[]) => pool.query(s, q) };
    const lifecycle = new ProductLifecycleService(pg as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    await lifecycle.sleepDeletedTick();
    expect(await jobsOf(p.id)).toEqual([{ kind: 'purge', status: 'queued' }]);
  });

  it('копия стёртого продукта удаляется, repo_url обнуляется; чужие и неподходящие — не трогаются', async () => {
    const root = process.env.PRODUCT_REPOS_DIR!;
    const mine = await deleted({ purgeAfterMs: -60_000, purged: true, slug: 'gone-shop', repoUrl: `backup@10.0.0.1:${root}/gone-shop.git` });
    fs.mkdirSync(path.join(root, 'gone-shop.git'));
    fs.writeFileSync(path.join(root, 'gone-shop.git', 'HEAD'), 'ref: refs/heads/master\n');
    const neighbour = path.join(root, 'live-shop.git');
    fs.mkdirSync(neighbour);
    const foreign = await deleted({ purgeAfterMs: -60_000, purged: true, slug: 'far-shop', repoUrl: 'backup@10.0.0.1:/somewhere/else/far-shop.git' });
    const alive = await deleted({ purgeAfterMs: 86_400_000, slug: 'kept-shop', repoUrl: `backup@10.0.0.1:${root}/kept-shop.git` });
    fs.mkdirSync(path.join(root, 'kept-shop.git'));

    expect(await svc.removeBackups()).toBe(1);

    expect(fs.existsSync(path.join(root, 'gone-shop.git'))).toBe(false);
    expect(fs.existsSync(neighbour)).toBe(true);
    expect(fs.existsSync(path.join(root, 'kept-shop.git'))).toBe(true);
    const urls = await pool.query(`SELECT id, repo_url FROM products WHERE id = ANY($1::uuid[])`, [[mine.id, foreign.id, alive.id]]);
    const byId = Object.fromEntries(urls.rows.map((r: any) => [r.id, r.repo_url]));
    expect(byId[mine.id]).toBeNull();
    expect(byId[foreign.id]).toBe('backup@10.0.0.1:/somewhere/else/far-shop.git');
    expect(byId[alive.id]).not.toBeNull();
  });

  it('символическая ссылка на месте копии не разыменовывается и не удаляется', async () => {
    const root = process.env.PRODUCT_REPOS_DIR!;
    const target = path.join(tmp, 'precious');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'keep'), '1');
    fs.symlinkSync(target, path.join(root, 'link-shop.git'));
    await deleted({ purgeAfterMs: -60_000, purged: true, slug: 'link-shop', repoUrl: `backup@10.0.0.1:${root}/link-shop.git` });

    expect(await svc.removeBackups()).toBe(0);
    expect(fs.existsSync(path.join(target, 'keep'))).toBe(true);
  });

  it('копии уже нет — repo_url всё равно обнуляется', async () => {
    const root = process.env.PRODUCT_REPOS_DIR!;
    const p = await deleted({ purgeAfterMs: -60_000, purged: true, slug: 'no-copy', repoUrl: `backup@10.0.0.1:${root}/no-copy.git` });
    expect(await svc.removeBackups()).toBe(1);
    expect((await pool.query(`SELECT repo_url FROM products WHERE id = $1`, [p.id])).rows[0].repo_url).toBeNull();
  });

  it('каталог копий за символической ссылкой — ничего не стирается, repo_url на месте', async () => {
    // Тот же приём, что у агента машины (purge.ts, checkedOnDisk): ссылка
    // по дороге к каталогу — не повод стирать то, куда она смотрит.
    const real = process.env.PRODUCT_REPOS_DIR!;
    const link = path.join(tmp, 'repos-link');
    fs.symlinkSync(real, link);
    process.env.PRODUCT_REPOS_DIR = link;
    fs.mkdirSync(path.join(real, 'via-link.git'));
    const p = await deleted({ purgeAfterMs: -60_000, purged: true, slug: 'via-link', repoUrl: `backup@10.0.0.1:${link}/via-link.git` });
    // Копии нет — но и корень не тот, что в настройке: «стирать нечего» тут
    // не вывод, repo_url остаётся (сверка корня, а не только самой копии).
    const empty = await deleted({ purgeAfterMs: -60_000, purged: true, slug: 'via-link-none', repoUrl: `backup@10.0.0.1:${link}/via-link-none.git` });

    expect(await svc.removeBackups()).toBe(0);
    expect(fs.existsSync(path.join(real, 'via-link.git'))).toBe(true);
    expect(await repoUrlOf(p.id)).toBe(`backup@10.0.0.1:${link}/via-link.git`);
    expect(await repoUrlOf(empty.id)).toBe(`backup@10.0.0.1:${link}/via-link-none.git`);
  });

  it('каталога копий нет на машине — repo_url не обнуляется: «не знаю, что там» не равно «пусто»', async () => {
    const absent = path.join(tmp, 'no-such-repos');
    process.env.PRODUCT_REPOS_DIR = absent;
    const p = await deleted({ purgeAfterMs: -60_000, purged: true, slug: 'nowhere', repoUrl: `backup@10.0.0.1:${absent}/nowhere.git` });

    expect(await svc.removeBackups()).toBe(0);
    expect(await repoUrlOf(p.id)).toBe(`backup@10.0.0.1:${absent}/nowhere.git`);
  });

  it('неподходящие копии не загораживают обход: два десятка чужих не мешают стереть свою', async () => {
    const root = process.env.PRODUCT_REPOS_DIR!;
    for (let i = 0; i < 21; i++) {
      await deleted({ purgeAfterMs: -60_000, purged: true, repoUrl: `backup@10.0.0.1:/somewhere/else/f${i}.git` });
    }
    const mine = await deleted({ purgeAfterMs: -60_000, purged: true, slug: 'late-shop', repoUrl: `${root}/late-shop.git` });
    fs.mkdirSync(path.join(root, 'late-shop.git'));

    expect(await svc.removeBackups()).toBe(1);
    expect(fs.existsSync(path.join(root, 'late-shop.git'))).toBe(false);
    expect(await repoUrlOf(mine.id)).toBeNull();
  });

  it('ссылка ВНУТРИ копии наружу удаляется как ссылка — то, куда она смотрит, цело', async () => {
    const root = process.env.PRODUCT_REPOS_DIR!;
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'keep'), '1');
    const copy = path.join(root, 'inner-link.git');
    fs.mkdirSync(path.join(copy, 'hooks'), { recursive: true });
    fs.symlinkSync(outside, path.join(copy, 'hooks', 'evil'));
    fs.symlinkSync(path.join(outside, 'keep'), path.join(copy, 'HEAD'));
    const p = await deleted({ purgeAfterMs: -60_000, purged: true, slug: 'inner-link', repoUrl: `${root}/inner-link.git` });

    expect(await svc.removeBackups()).toBe(1);
    expect(fs.existsSync(copy)).toBe(false);
    expect(fs.readFileSync(path.join(outside, 'keep'), 'utf8')).toBe('1');
    expect(await repoUrlOf(p.id)).toBeNull();
  });

  it('repo_url переписали, пока стирали, — новое значение остаётся, стирание не засчитано', async () => {
    const root = process.env.PRODUCT_REPOS_DIR!;
    const p = await deleted({ purgeAfterMs: -60_000, purged: true, slug: 'moved', repoUrl: `${root}/moved.git` });
    fs.mkdirSync(path.join(root, 'moved.git'));
    const racing = new ProductPurgeService({
      query: async (s: string, q?: any[]) => {
        if (/^\s*UPDATE products SET repo_url = NULL/.test(s)) {
          await pool.query(`UPDATE products SET repo_url = 'backup@10.0.0.1:/elsewhere/moved.git' WHERE id = $1`, [q![0]]);
        }
        return pool.query(s, q);
      },
    } as any);
    (racing as any).logger = (svc as any).logger;

    expect(await racing.removeBackups()).toBe(0);
    expect(await repoUrlOf(p.id)).toBe('backup@10.0.0.1:/elsewhere/moved.git');
  });

  it('копия не удаляется (нет прав) — строка error раз на процесс, а не каждый час; repo_url на месте', async () => {
    const root = process.env.PRODUCT_REPOS_DIR!;
    const copy = path.join(root, 'locked.git');
    fs.mkdirSync(copy);
    fs.writeFileSync(path.join(copy, 'HEAD'), 'ref: refs/heads/master\n');
    const p = await deleted({ purgeAfterMs: -60_000, purged: true, slug: 'locked', repoUrl: `${root}/locked.git` });
    fs.chmodSync(copy, 0o500);
    try {
      expect(await svc.removeBackups()).toBe(0);
      expect(await svc.removeBackups()).toBe(0);
    } finally {
      fs.chmodSync(copy, 0o700);
    }
    expect(fs.existsSync(path.join(copy, 'HEAD'))).toBe(true);
    expect(await repoUrlOf(p.id)).toBe(`${root}/locked.git`);
    const lines = errors.filter((m) => m.includes('locked'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/EACCES/);
  });
});
