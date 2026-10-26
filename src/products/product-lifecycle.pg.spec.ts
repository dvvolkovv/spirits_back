import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { HostsService } from './hosts.service';
import { LimitsService } from './limits.service';
import { ProductActionsService } from './product-actions.service';
import { ProductLifecycleService } from './product-lifecycle.service';
import { MIGRATIONS } from './products.service';
import { ProvisioningService } from './provisioning.service';
import { SLEEP_REASON_NO_TOKENS } from './rent.service';
import { SecretsService } from './secrets.service';
import { TurnsService } from './turns.service';

/**
 * Жизненный цикл продукта против живого Postgres — тем же приёмом, что
 * provisioning.integration.spec.ts и product-actions.pg.spec.ts: юнит-тесты
 * подменяют pg целиком и сторожат ФОРМУ запроса, а здесь SQL исполняется, и
 * сторожится ПОВЕДЕНИЕ — предикаты UPDATE, частичные UNIQUE-индексы,
 * `product_turns_one_active`/`product_provision_jobs_one_active`, которые
 * мок не исполняет вовсе.
 *
 * КАК ГОНЯТЬ. База — ОДНОРАЗОВАЯ, beforeEach делает TRUNCATE (см. гард на
 * непустую базу в beforeAll):
 *
 *   sudo -u postgres psql -c "CREATE ROLE pl_test LOGIN PASSWORD 'pl_test';" \
 *                        -c "CREATE DATABASE pl_test OWNER pl_test;"
 *   PROVISIONING_PG_URL='postgres:///pl_test?host=/var/run/postgresql' \
 *     npx jest --testPathPattern='src/products/product-lifecycle.pg'
 */
const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;

// Ключ из secrets.spec.ts/provisioning.integration.spec.ts — неоднородный
// намеренно (измерено там же: мутация «повторить первую половину hex» живёт
// на однородном ключе).
const KEY = '00112233445566778899aabbccddeeff0f1e2d3c4b5a69788796a5b4c3d2e1f0';

const sha = (t: string) => crypto.createHash('sha256').update(t).digest('hex');

maybe('жизненный цикл продукта против живого Postgres', () => {
  jest.setTimeout(30_000);

  let pool: Pool;
  // getClient — для M2: restore() берёт выделенное соединение под BEGIN/
  // COMMIT (как это делает настоящий PgService.getClient), а не пул, где
  // BEGIN и следующий запрос рискуют уехать на разные соединения.
  let pg: { query: (sql: string, params?: any[]) => Promise<any>; getClient: () => Promise<any> };
  let secrets: SecretsService;
  let svc: ProductLifecycleService;

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG, max: 8 });
    pg = { query: (sql: string, params?: any[]) => pool.query(sql, params), getClient: () => pool.connect() };
    secrets = new SecretsService({ get: (k: string) => (k === 'PRODUCT_SECRETS_KEY' ? KEY : undefined) } as any);

    for (const f of MIGRATIONS) {
      await pool.query(fs.readFileSync(path.join(__dirname, 'migrations', f), 'utf8'));
    }
    // Своя версия ai_profiles_consolidated: isAdmin() в product-lifecycle.service
    // читает ТОЛЬКО isadmin, но таблица — чужого модуля (base/migrations), и
    // список MIGRATIONS здесь только про products. Без неё любой вызов
    // isAdmin() (а он — на каждом createSite/completeCreateBot/restore) падает
    // "relation does not exist" прежде, чем до продуктовой логики дойдёт
    // вообще что-то.
    //
    // CREATE + отдельный ALTER ADD COLUMN IF NOT EXISTS, а не только CREATE:
    // одноразовая база pl_test разделена со всеми остальными pg-спеками этого
    // каталога (provisioning.integration.spec.ts заводит ту же таблицу своим
    // ensureBillingTables() для аренды — БЕЗ isadmin), и CREATE TABLE IF NOT
    // EXISTS на уже существующей таблице не добавляет недостающую колонку.
    // Измерено: прогон этого файла после provisioning.integration.spec.ts в
    // той же базе падал на "column isadmin does not exist".
    await pool.query(`CREATE TABLE IF NOT EXISTS ai_profiles_consolidated (
      id serial PRIMARY KEY,
      user_id text NOT NULL UNIQUE,
      isadmin boolean DEFAULT false,
      tokens bigint DEFAULT 0 NOT NULL)`);
    await pool.query(`ALTER TABLE ai_profiles_consolidated ADD COLUMN IF NOT EXISTS isadmin boolean DEFAULT false`);

    // ГАРД НА ЧУЖУЮ БАЗУ — та же причина, что в provisioning.integration.spec.ts.
    const n = await pool.query('SELECT count(*) FROM products');
    if (Number(n.rows[0].count) > 0) {
      throw new Error('PROVISIONING_PG_URL указывает на НЕпустую базу — нужна одноразовая');
    }
  });

  afterAll(async () => {
    await pool?.query(
      'TRUNCATE products, product_provision_jobs, product_turns, product_actions, product_host_agent, product_hosts, product_user_limits RESTART IDENTITY CASCADE',
    );
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE products, product_provision_jobs, product_turns, product_actions, product_host_agent, product_hosts, product_user_limits RESTART IDENTITY CASCADE',
    );
    await pool.query('TRUNCATE ai_profiles_consolidated RESTART IDENTITY CASCADE');
    // Единственная машина реестра, аудитория 'clients': isAdmin() по умолчанию
    // (без строки в ai_profiles_consolidated) отдаёт false, и пикер машины
    // (HostsService.pickForNewProduct) уходит ровно в эту аудиторию.
    await pool.query(
      `INSERT INTO product_hosts (id, ssh_target, public_ip, domain_suffix, agent_token_hash, capacity, audience)
       VALUES ('clients', 'root@10.50.0.1', '10.50.0.1', 'c.linkeon.io', $1, 20, 'clients')`,
      [sha('токен clients')],
    );

    const provisioning = new ProvisioningService(pg as any, secrets, new HostsService(pg as any), new LimitsService(pg as any));
    (provisioning as any).fetchFn = async () => ({ status: 200 });
    const limits = new LimitsService(pg as any);
    const turns = new TurnsService(pg as any, { checkTokenBalance: async () => ({ ok: true }), deductTokens: async () => 0 } as any);
    const actions = new ProductActionsService(pg as any);
    svc = new ProductLifecycleService(pg as any, provisioning, limits, turns, actions);
    (svc as any).checkBot = async () => ({ ok: true, id: 1234567890, username: 'shop_bot' });
  });

  let seq = 0;

  /**
   * Продукт — прямым INSERT, а не через createSite/provisioning.create:
   * сценарии удаления/возврата/сна/первой правки проверяют
   * product-lifecycle.service, а не заведение (его сторожит сценарий a и
   * provisioning.integration.spec.ts), и им нужен продукт в произвольном
   * статусе ('running', 'archived' и т.д.), которого create() не отдаёт
   * (он всегда 'provisioning').
   */
  async function insertProduct(o: {
    userId: string;
    status: string;
    slug?: string;
    archivedAt?: Date | null;
    purgeAfter?: Date | null;
    paidUntil?: Date;
    blockReason?: string | null;
    sleepReason?: string | null;
    tgBotId?: number | null;
  }) {
    const id = crypto.randomUUID();
    const slug = o.slug ?? `p-${seq++}`;
    await pool.query(
      `INSERT INTO products (id, user_id, name, slug, kind, status, checkout_path, runner_token_hash,
                             archived_at, purge_after, paid_until, block_reason, sleep_reason, tg_bot_id)
       VALUES ($1,$2,$3,$4,'site',$5,'/product',$6,$7,$8,$9,$10,$11,$12)`,
      [
        id, o.userId, `Продукт ${slug}`, slug, o.status, sha(`токен ${id}`),
        o.archivedAt ?? null, o.purgeAfter ?? null,
        o.paidUntil ?? new Date(Date.now() + 30 * 86_400_000),
        o.blockReason ?? null, o.sleepReason ?? null, o.tgBotId ?? null,
      ],
    );
    return id as string;
  }

  describe('создание сайта', () => {
    it('чистый слаг из имени; повтор тем же именем — слаг с хвостом', async () => {
      const r1 = await svc.createSite({ userId: 'u-site', name: 'Магазин', channel: 'web' });
      expect(r1).toMatchObject({ ok: true, slug: 'magazin' });

      const r2 = await svc.createSite({ userId: 'u-site', name: 'Магазин', channel: 'web' });
      expect(r2.ok).toBe(true);
      expect((r2 as any).slug).toMatch(/^magazin-[a-z0-9]{6}$/);
      expect((r2 as any).productId).not.toBe((r1 as any).productId);

      const rows = await pool.query('SELECT slug FROM products WHERE user_id = $1', ['u-site']);
      expect(rows.rows.map((r: any) => r.slug).sort()).toEqual(['magazin', (r2 as any).slug].sort());
    });
  });

  describe('удаление', () => {
    it('по нажатию: архив на 30 дней, чужое задание снято, сон поставлен', async () => {
      const userId = 'u-del';
      const productId = await insertProduct({ userId, status: 'running', slug: 'del-1' });
      // Задание, которое висело в очереди ДО удаления — оно не должно
      // занимать единственное место под сон, которое ставит completeDelete.
      const wake = await pool.query(
        `INSERT INTO product_provision_jobs (product_id, kind, status) VALUES ($1, 'wake', 'queued') RETURNING id`,
        [productId],
      );

      const open = await svc.openDelete({ userId, productId, channel: 'web', turn: null });
      expect(open.ok).toBe(true);
      const complete = await svc.completeDelete({ userId, actionId: (open as any).actionId, via: 'chat' });
      expect(complete.ok).toBe(true);

      const row = (await pool.query('SELECT status, archived_at, purge_after FROM products WHERE id = $1', [productId])).rows[0];
      expect(row.status).toBe('archived');
      expect(row.archived_at).not.toBeNull();
      const days = (new Date(row.purge_after).getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(29.9);
      expect(days).toBeLessThan(30.1);

      const wakeRow = (await pool.query('SELECT status, error FROM product_provision_jobs WHERE id = $1', [wake.rows[0].id])).rows[0];
      expect(wakeRow.status).toBe('failed');
      expect(wakeRow.error).toBe('снято удалением');

      const sleep = await pool.query(`SELECT count(*) FROM product_provision_jobs WHERE product_id = $1 AND kind = 'sleep' AND status = 'queued'`, [productId]);
      expect(Number(sleep.rows[0].count)).toBe(1);
    });

    it('queued и running правки продукта снимаются — не держат product_turns_one_active, сон ставится немедленно', async () => {
      const userId = 'u-del-turns';
      const productId = await insertProduct({ userId, status: 'running', slug: 'del-turns-1' });
      const queuedTurn = await pool.query(
        `INSERT INTO product_turns (product_id, user_id, channel, prompt, status) VALUES ($1, $2, 'web', 'ход в очереди', 'queued') RETURNING id`,
        [productId, userId],
      );

      const open = await svc.openDelete({ userId, productId, channel: 'web', turn: null });
      const complete = await svc.completeDelete({ userId, actionId: (open as any).actionId, via: 'chat' });
      expect(complete.ok).toBe(true);

      const turnRow = (await pool.query('SELECT status, error FROM product_turns WHERE id = $1', [queuedTurn.rows[0].id])).rows[0];
      expect(turnRow.status).toBe('failed');
      expect(turnRow.error).toBeTruthy();

      // Правка снята СРАЗУ: queueSleepForDeleted больше не ждёт её тишины
      // (TURN_SILENCE_SQL) — иначе сон отложился бы на те же 30 минут.
      const sleep = await pool.query(`SELECT count(*) FROM product_provision_jobs WHERE product_id = $1 AND kind = 'sleep' AND status = 'queued'`, [productId]);
      expect(Number(sleep.rows[0].count)).toBe(1);
    });
  });

  describe('сон удалённых', () => {
    it('ждёт тишины идущей правки, ставит сон после неё, не дублирует', async () => {
      const userId = 'u-sleep';
      const productId = await insertProduct({
        userId, status: 'archived', slug: 'sleep-1',
        archivedAt: new Date(), purgeAfter: new Date(Date.now() + 30 * 86_400_000),
      });
      const turn = await pool.query(
        `INSERT INTO product_turns (product_id, user_id, channel, prompt, status, last_progress_at)
         VALUES ($1, $2, 'web', 'ход', 'running', now()) RETURNING id`,
        [productId, userId],
      );

      // Правка идёт прямо сейчас (last_progress_at свежий) — сон не ставится.
      expect(await svc.queueSleepForDeleted(productId)).toBe(0);

      // Та же строка притихла — можно ставить.
      await pool.query(`UPDATE product_turns SET last_progress_at = now() - interval '40 minutes' WHERE id = $1`, [turn.rows[0].id]);
      expect(await svc.queueSleepForDeleted(productId)).toBe(1);

      // Повтор на уже поставленном сне не дублирует задание.
      expect(await svc.queueSleepForDeleted(productId)).toBe(0);
      const jobs = await pool.query(`SELECT count(*) FROM product_provision_jobs WHERE product_id = $1 AND kind = 'sleep'`, [productId]);
      expect(Number(jobs.rows[0].count)).toBe(1);
    });

    it('3 провалившихся сна подряд — тик больше не ставит, предупреждает раз; провалы до архивации не считаются', async () => {
      const userId = 'u-sleep-cap';
      const archivedAt = new Date();
      const productId = await insertProduct({
        userId, status: 'archived', slug: 'sleep-cap-1',
        archivedAt, purgeAfter: new Date(Date.now() + 30 * 86_400_000),
      });
      // Провал ДО архивации — из прошлого цикла архив/возврат, считаться не должен.
      await pool.query(
        `INSERT INTO product_provision_jobs (product_id, kind, status, created_at) VALUES ($1, 'sleep', 'failed', $2)`,
        [productId, new Date(archivedAt.getTime() - 60_000)],
      );
      for (let i = 0; i < 3; i++) {
        await pool.query(
          `INSERT INTO product_provision_jobs (product_id, kind, status, created_at) VALUES ($1, 'sleep', 'failed', now())`,
          [productId],
        );
      }
      const warn = jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);

      expect(await svc.queueSleepForDeleted(productId)).toBe(0);
      expect(warn).toHaveBeenCalledTimes(1);
      // Повторный тик — предупреждение в логе не дублируется (один раз на процесс).
      expect(await svc.queueSleepForDeleted(productId)).toBe(0);
      expect(warn).toHaveBeenCalledTimes(1);

      const sleeps = await pool.query(`SELECT count(*) FROM product_provision_jobs WHERE product_id = $1 AND kind = 'sleep' AND status = 'queued'`, [productId]);
      expect(Number(sleeps.rows[0].count)).toBe(0);
    });

    it('тик доснимает застрявшее в очереди пробуждение архивного и ставит сон; живого не трогает', async () => {
      // Так выглядит удаление, у которого снятие чужих заданий оборвалось:
      // продукт уже в архиве, а его wake всё ещё queued.
      const archived = await insertProduct({
        userId: 'u-orphan', status: 'archived', slug: 'orphan-1',
        archivedAt: new Date(), purgeAfter: new Date(Date.now() + 30 * 86_400_000),
      });
      const live = await insertProduct({ userId: 'u-orphan', status: 'sleeping', slug: 'orphan-2' });
      const stuck = await pool.query(
        `INSERT INTO product_provision_jobs (product_id, kind, status) VALUES ($1, 'wake', 'queued') RETURNING id`,
        [archived],
      );
      const liveWake = await pool.query(
        `INSERT INTO product_provision_jobs (product_id, kind, status) VALUES ($1, 'wake', 'queued') RETURNING id`,
        [live],
      );

      expect(await svc.sleepDeletedTick()).toBe(1);

      const stuckRow = (await pool.query('SELECT status, error FROM product_provision_jobs WHERE id = $1', [stuck.rows[0].id])).rows[0];
      expect(stuckRow).toMatchObject({ status: 'failed', error: 'снято удалением' });
      const sleep = await pool.query(`SELECT count(*) FROM product_provision_jobs WHERE product_id = $1 AND kind = 'sleep' AND status = 'queued'`, [archived]);
      expect(Number(sleep.rows[0].count)).toBe(1);
      const liveRow = (await pool.query('SELECT status FROM product_provision_jobs WHERE id = $1', [liveWake.rows[0].id])).rows[0];
      expect(liveRow.status).toBe('queued');
    });
  });

  describe('возврат', () => {
    it('в пределах срока: снимает архив, чужой сон отменяет, будит при оплаченном периоде', async () => {
      const userId = 'u-restore';
      const productId = await insertProduct({
        userId, status: 'archived', slug: 'restore-1',
        archivedAt: new Date(), purgeAfter: new Date(Date.now() + 10 * 86_400_000),
        paidUntil: new Date(Date.now() + 5 * 86_400_000),
      });
      const sleep = await pool.query(
        `INSERT INTO product_provision_jobs (product_id, kind, status) VALUES ($1, 'sleep', 'queued') RETURNING id`,
        [productId],
      );

      const r = await svc.restore({ userId, productId, channel: 'web' });
      expect(r).toMatchObject({ ok: true, status: 'sleeping', waking: true });

      const row = (await pool.query('SELECT status, archived_at FROM products WHERE id = $1', [productId])).rows[0];
      expect(row.status).toBe('sleeping');
      expect(row.archived_at).toBeNull();

      const cancelled = (await pool.query('SELECT status FROM product_provision_jobs WHERE id = $1', [sleep.rows[0].id])).rows[0];
      expect(cancelled.status).toBe('failed');

      const wake = await pool.query(`SELECT count(*) FROM product_provision_jobs WHERE product_id = $1 AND kind = 'wake' AND status = 'queued'`, [productId]);
      expect(Number(wake.rows[0].count)).toBe(1);
    });

    it('оплаченный период истёк: без wake, причина сна — нет токенов', async () => {
      const userId = 'u-restore2';
      const productId = await insertProduct({
        userId, status: 'archived', slug: 'restore-2',
        archivedAt: new Date(), purgeAfter: new Date(Date.now() + 10 * 86_400_000),
        paidUntil: new Date(Date.now() - 86_400_000),
      });

      const r = await svc.restore({ userId, productId, channel: 'web' });
      expect(r).toMatchObject({ ok: true, status: 'sleeping', waking: false });

      const row = (await pool.query('SELECT sleep_reason FROM products WHERE id = $1', [productId])).rows[0];
      expect(row.sleep_reason).toBe(SLEEP_REASON_NO_TOKENS);
      const wake = await pool.query(`SELECT count(*) FROM product_provision_jobs WHERE product_id = $1 AND kind = 'wake'`, [productId]);
      expect(Number(wake.rows[0].count)).toBe(0);
    });

    it('гонка с минутным тиком: queueSleepForDeleted не ставит сон продукту, который в тот же момент возвращают (M2)', async () => {
      for (let attempt = 0; attempt < 6; attempt++) {
        const userId = `u-restore-race-${attempt}`;
        const productId = await insertProduct({
          userId, status: 'archived', slug: `restore-race-${attempt}`,
          archivedAt: new Date(), purgeAfter: new Date(Date.now() + 10 * 86_400_000),
          paidUntil: new Date(Date.now() + 5 * 86_400_000),
        });

        const [restored] = await Promise.all([
          svc.restore({ userId, productId, channel: 'web' }),
          svc.queueSleepForDeleted(productId),
        ]);
        expect(restored.ok).toBe(true);

        const row = (await pool.query('SELECT status, archived_at FROM products WHERE id = $1', [productId])).rows[0];
        expect(row.archived_at).toBeNull();
        // Либо тик успел ДО возврата (его сон снят возвратом и запись
        // осталась failed/отменённым), либо ПОСЛЕ (архив уже снят, и тик
        // его просто не находит) — в любом случае queued-сна для живого
        // продукта не остаётся.
        const sleepQueued = await pool.query(
          `SELECT count(*) FROM product_provision_jobs WHERE product_id = $1 AND kind = 'sleep' AND status = 'queued'`,
          [productId],
        );
        expect(Number(sleepQueued.rows[0].count)).toBe(0);
        // waking правдив: если продукт sleeping (оплачен), задание wake стоит.
        if ((restored as any).status === 'sleeping' && (restored as any).waking) {
          const wake = await pool.query(
            `SELECT count(*) FROM product_provision_jobs WHERE product_id = $1 AND kind = 'wake' AND status IN ('queued','running')`,
            [productId],
          );
          expect(Number(wake.rows[0].count)).toBeGreaterThan(0);
        }
      }
    });

    it('продукт был сломан (failed) до удаления — возврат отдаёт его обратно failed, без сна и аренды', async () => {
      const userId = 'u-restore-failed';
      const productId = await insertProduct({ userId, status: 'failed', slug: 'restore-failed-1' });

      const open = await svc.openDelete({ userId, productId, channel: 'web', turn: null });
      expect(open.ok).toBe(true);
      const complete = await svc.completeDelete({ userId, actionId: (open as any).actionId, via: 'chat' });
      expect(complete.ok).toBe(true);

      const r = await svc.restore({ userId, productId, channel: 'web' });
      expect(r).toMatchObject({ ok: true, status: 'failed', waking: false });

      const row = (await pool.query('SELECT status, archived_at FROM products WHERE id = $1', [productId])).rows[0];
      expect(row.status).toBe('failed');
      expect(row.archived_at).toBeNull();
      const wake = await pool.query(`SELECT count(*) FROM product_provision_jobs WHERE product_id = $1 AND kind = 'wake'`, [productId]);
      expect(Number(wake.rows[0].count)).toBe(0);
    });

    it('токен бота архивного продукта тем временем занял другой живой продукт — bot_in_use, архив не снят', async () => {
      const botId = 777777;
      const userId = 'u-restore3';
      // Удалённый бот — completeDelete tg_bot_id не трогает (009), поэтому
      // строка архивного продукта держит его до сих пор. Частичный индекс
      // products_tg_bot_live смотрит только на archived_at IS NULL, так что
      // ВТОРОЙ, живой продукт с тем же tg_bot_id — это разрешённое состояние
      // базы, а не испорченная фикстура.
      const archived = await insertProduct({
        userId, status: 'archived', slug: 'restore-bot-1',
        archivedAt: new Date(), purgeAfter: new Date(Date.now() + 10 * 86_400_000),
        tgBotId: botId,
      });
      await insertProduct({ userId, status: 'running', slug: 'restore-bot-2', tgBotId: botId });

      const r = await svc.restore({ userId, productId: archived, channel: 'web' });
      expect(r).toEqual({
        ok: false, reason: 'bot_in_use',
        message: 'Этот бот уже работает в другом продукте — удалённого не вернуть, пока его токен занят',
      });

      const row = (await pool.query('SELECT status, archived_at FROM products WHERE id = $1', [archived])).rows[0];
      expect(row.status).toBe('archived');
      expect(row.archived_at).not.toBeNull();
    });
  });

  describe('первая правка', () => {
    it('поднявшемуся продукту ставит ход и обнуляет поле; заводящемуся — нет', async () => {
      const userId = 'u-fp';
      const running = await insertProduct({ userId, status: 'running', slug: 'fp-run' });
      await pool.query(`UPDATE products SET first_prompt = 'Сделай лендинг', first_prompt_channel = 'web' WHERE id = $1`, [running]);
      const provisioning = await insertProduct({ userId, status: 'provisioning', slug: 'fp-prov' });
      await pool.query(`UPDATE products SET first_prompt = 'Ещё не готов', first_prompt_channel = 'web' WHERE id = $1`, [provisioning]);

      expect(await svc.firstPromptTick()).toBe(1);

      const runningRow = (await pool.query('SELECT first_prompt FROM products WHERE id = $1', [running])).rows[0];
      expect(runningRow.first_prompt).toBeNull();
      const turn = (await pool.query(`SELECT prompt, channel, status FROM product_turns WHERE product_id = $1`, [running])).rows[0];
      expect(turn).toMatchObject({ prompt: 'Сделай лендинг', channel: 'web', status: 'queued' });

      const provRow = (await pool.query('SELECT first_prompt FROM products WHERE id = $1', [provisioning])).rows[0];
      expect(provRow.first_prompt).toBe('Ещё не готов');
    });
  });

  describe('создание бота', () => {
    it('два ожидающих с одним токеном: второй — bot_in_use, живой продукт с этим id — ровно один', async () => {
      const userId = 'u-bot';
      const botId = 777001;
      (svc as any).checkBot = async () => ({ ok: true, id: botId, username: 'shop_bot' });

      const open1 = await svc.openCreateBot({ userId, name: 'Бот 1', channel: 'web', turn: null });
      const open2 = await svc.openCreateBot({ userId, name: 'Бот 2', channel: 'web', turn: null });
      expect(open1.ok).toBe(true);
      expect(open2.ok).toBe(true);

      const r1 = await svc.completeCreateBot({ userId, actionId: (open1 as any).actionId, set: { BOT_TOKEN: '1234567890:AAH9sdfjKJHkjh34kjh5kjh6KJHkjhKJHkj' }, via: 'chat' });
      expect(r1.ok).toBe(true);

      const r2 = await svc.completeCreateBot({ userId, actionId: (open2 as any).actionId, set: { BOT_TOKEN: '1234567890:AAH9sdfjKJHkjh34kjh5kjh6KJHkjhKJHkj' }, via: 'chat' });
      expect(r2).toMatchObject({ ok: false, reason: 'bot_in_use' });

      const live = await pool.query(`SELECT count(*) FROM products WHERE tg_bot_id = $1 AND archived_at IS NULL`, [botId]);
      expect(Number(live.rows[0].count)).toBe(1);
    });

    it('канарейка: токен бота и ключ сервиса не всплывают в журнале и в логе (M11)', async () => {
      const BOT_TOKEN_CANARY = '123456:FAKE_CANARY_VALUE_xxxxxxxxxxxxxxxxxxx';
      const KEY_CANARY = 'CANARY_KEY_VALUE';
      const warnSpy = jest.spyOn((svc as any).logger, 'warn');
      const errorSpy = jest.spyOn((svc as any).logger, 'error');

      // Раунд 1 — Telegram отклоняет токен (bad_token, карточка в release()).
      const userId1 = 'u-canary-1';
      (svc as any).checkBot = async () => ({ ok: false, reason: 'rejected' });
      const open1 = await svc.openCreateBot({ userId: userId1, name: 'Канарейка 1', channel: 'web', turn: null });
      const r1 = await svc.completeCreateBot({ userId: userId1, actionId: (open1 as any).actionId, set: { BOT_TOKEN: BOT_TOKEN_CANARY, OZON_KEY: KEY_CANARY }, via: 'chat' });
      expect(r1.ok).toBe(false);

      // Раунд 2 — Telegram принимает токен, продукт заводится (finish(done)).
      const userId2 = 'u-canary-2';
      (svc as any).checkBot = async () => ({ ok: true, id: 991199, username: 'canary_bot' });
      const open2 = await svc.openCreateBot({ userId: userId2, name: 'Канарейка 2', channel: 'web', turn: null });
      const r2 = await svc.completeCreateBot({ userId: userId2, actionId: (open2 as any).actionId, set: { BOT_TOKEN: BOT_TOKEN_CANARY, OZON_KEY: KEY_CANARY }, via: 'chat' });
      expect(r2.ok).toBe(true);

      // products.secrets_encrypted — шифротекст, на него намеренно не
      // смотрим; журнал (product_actions) — открытый текст, должен быть пуст
      // от канареек в обоих полях.
      const leaked = await pool.query(
        `SELECT id FROM product_actions
          WHERE payload::text LIKE '%' || $1 || '%' OR payload::text LIKE '%' || $2 || '%'
             OR result::text LIKE '%' || $1 || '%' OR result::text LIKE '%' || $2 || '%'`,
        [BOT_TOKEN_CANARY, KEY_CANARY],
      );
      expect(leaked.rows).toEqual([]);

      const allLogs = [...warnSpy.mock.calls, ...errorSpy.mock.calls].map((c) => String(c[0]));
      expect(allLogs.some((s) => s.includes(BOT_TOKEN_CANARY) || s.includes(KEY_CANARY))).toBe(false);
    });
  });

  describe('подметальщик зависших карточек (ревью задачи 10, пункт E)', () => {
    it('working, просроченный больше 10 минут — failed; working с будущим сроком и pending не трогает', async () => {
      const actions = new ProductActionsService(pg as any);
      const userId = 'u-stuck';

      const stale = await actions.open({ userId, productId: null, kind: 'delete', channel: 'web', turn: null, payload: {} });
      await pool.query(
        `UPDATE product_actions SET status = 'working', expires_at = now() - interval '11 minutes' WHERE id = $1`,
        [stale.id],
      );

      const fresh = await actions.open({ userId, productId: null, kind: 'delete', channel: 'web', turn: null, payload: {} });
      await pool.query(
        `UPDATE product_actions SET status = 'working', expires_at = now() + interval '5 minutes' WHERE id = $1`,
        [fresh.id],
      );

      const pending = await actions.open({ userId, productId: null, kind: 'delete', channel: 'web', turn: null, payload: {} });

      expect(await actions.sweepStuck()).toBe(1);

      const staleRow = (await pool.query('SELECT status, result FROM product_actions WHERE id = $1', [stale.id])).rows[0];
      expect(staleRow.status).toBe('failed');
      expect(staleRow.result).toMatchObject({ error: 'Действие прервалось — попросите ассистента повторить' });

      const freshRow = (await pool.query('SELECT status FROM product_actions WHERE id = $1', [fresh.id])).rows[0];
      expect(freshRow.status).toBe('working');

      const pendingRow = (await pool.query('SELECT status FROM product_actions WHERE id = $1', [pending.id])).rows[0];
      expect(pendingRow.status).toBe('pending');
    });
  });
});
