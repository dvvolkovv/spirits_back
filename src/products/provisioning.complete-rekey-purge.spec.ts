import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { MIGRATIONS } from './products.service';
import { ProvisioningService } from './provisioning.service';
import { HostsService } from './hosts.service';
import { LimitsService } from './limits.service';
import { RentService } from './rent.service';
import { SecretsService } from './secrets.service';
import { REKEY_FAILED_SAY, REKEY_UNKNOWN_SAY } from './product-actions.service';

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;
const KEY = '00112233445566778899aabbccddeeff0f1e2d3c4b5a69788796a5b4c3d2e1f0';
const BOX_UNREADABLE = 'коробка ключей не читается — ключи не менялись';

const quietLogger = (errors: string[], warns: string[] = []) => ({
  error: (m: string) => errors.push(m),
  warn: (m: string) => warns.push(m),
  log: () => undefined,
  debug: () => undefined,
});

/**
 * Выдача rekey, когда коробка ключей карточки не расшифровывается (испорченная
 * коробка, сменённый ключ шифрования). Без этой ветки задание уже 'running' с
 * started_at, агент получает 500, через 10 минут сборщик снимает задание, а
 * подметальщик журнала пишет rekey_unknown («продукт может не отвечать») —
 * ложная тревога: машину никто не трогал. Плюс 10 минут правки получают 409.
 */
describe('выдача rekey: коробка не читается', () => {
  it('задание закрыто отказом смены ключей (rekey_failed), агенту — «заданий нет»', async () => {
    const calls: { sql: string; params: any[] }[] = [];
    const pg = {
      query: jest.fn(async (sql: string, params: any[] = []) => {
        calls.push({ sql, params });
        if (sql.includes("SET status = 'running'")) {
          return {
            rows: [{
              job_id: 'j-1', job_kind: 'rekey', product_id: 'p-1', user_id: 'u1', slug: 'shop', name: 'Б',
              kind: 'bot', port: null, box: null, rekey_box: Buffer.from('испорчено-123456:TEST-secret'),
              rekey_payload: { removedNames: [] }, token_issued: false, custom_names: [], vhost_mode: 'proxy',
            }],
          };
        }
        if (/WITH closed AS/.test(sql) && sql.includes("kind = 'rekey'")) {
          return { rows: [{ closed: 1, swapped: 0, product_id: 'p-1', slug: 'shop', tg_bot_id: null }], rowCount: 1 };
        }
        return { rows: [] };
      }),
    };
    const secrets = new SecretsService({ get: (k: string) => (k === 'PRODUCT_SECRETS_KEY' ? KEY : undefined) } as any);
    const svc = new ProvisioningService(pg as any, secrets, {} as any, {} as any, {} as any);
    const errors: string[] = [];
    (svc as any).logger = quietLogger(errors);

    await expect(svc.claimJob('clients')).resolves.toBeNull();

    const done = calls.filter((c) => /WITH closed AS/.test(c.sql) && c.sql.includes("kind = 'rekey'"));
    expect(done).toHaveLength(1);
    expect(done[0].params).toEqual(['j-1', false, BOX_UNREADABLE, REKEY_FAILED_SAY, 'rekey_failed']);
    // Привязку Telegram спрашивать незачем — задание не выдаётся.
    expect(calls.some((c) => c.sql.includes('tg_user_identities'))).toBe(false);
    // Громко и со слагом, но без содержимого коробки.
    expect(errors.some((m) => m.includes('shop'))).toBe(true);
    expect(JSON.stringify({ calls: calls.map((c) => c.params), errors })).not.toContain('TEST-secret');
  });
});

maybe('отчёт агента по rekey и purge против живого Postgres', () => {
  let pool: Pool;
  let svc: ProvisioningService;
  const secrets = new SecretsService({ get: (k: string) => (k === 'PRODUCT_SECRETS_KEY' ? KEY : undefined) } as any);

  async function product(o: { status: string; kind?: 'site' | 'bot'; archived?: boolean; tgBotId?: number | null; secrets?: Record<string, string> } ) {
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO products (id, user_id, name, slug, kind, status, checkout_path, runner_token_hash, host_id,
                             archived_at, purge_after, tg_bot_id, secrets_encrypted, first_prompt)
       VALUES ($1, 'u1', 'П', $2, $3, $4, '/product', $5, 'clients',
               CASE WHEN $6 THEN now() - interval '31 days' END, CASE WHEN $6 THEN now() - interval '1 day' END, $7, $8, 'первая')`,
      [id, `s-${id.slice(0, 8)}`, o.kind ?? 'bot', o.status, `h-${id}`, !!o.archived, o.tgBotId ?? null,
       o.secrets ? secrets.encrypt(o.secrets, id) : null],
    );
    return id;
  }

  /** Задание уже у агента (running), как после claimJob. */
  async function runningRekey(productId: string, set: Record<string, string>, payload: any) {
    const a = await pool.query(
      `INSERT INTO product_actions (user_id, product_id, kind, status, channel, payload, secrets_box)
       VALUES ('u1', $1, 'keys', 'working', 'web', $2::jsonb, $3) RETURNING id`,
      [productId, JSON.stringify(payload), secrets.encrypt(set, productId)],
    );
    const j = await pool.query(
      `INSERT INTO product_provision_jobs (product_id, kind, status, action_id, started_at) VALUES ($1, 'rekey', 'running', $2, now()) RETURNING id`,
      [productId, a.rows[0].id],
    );
    return { actionId: a.rows[0].id as string, jobId: j.rows[0].id as string };
  }

  const productRow = async (id: string) => (await pool.query(`SELECT * FROM products WHERE id = $1`, [id])).rows[0];
  const actionRow = async (id: string) => (await pool.query(`SELECT * FROM product_actions WHERE id = $1`, [id])).rows[0];

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG, max: 8 });
    for (const f of MIGRATIONS) await pool.query(fs.readFileSync(path.join(__dirname, 'migrations', f), 'utf8'));
    const pg = { query: (s: string, p?: any[]) => pool.query(s, p) };
    svc = new ProvisioningService(pg as any, secrets, new HostsService(pg as any), new LimitsService(pg as any), new RentService(pg as any));
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE products, product_provision_jobs, product_turns, product_actions, product_domains, product_host_agent, product_hosts RESTART IDENTITY CASCADE');
    await pool.query(
      `INSERT INTO product_hosts (id, ssh_target, public_ip, domain_suffix, agent_token_hash, capacity, audience)
       VALUES ('clients', 'root@10.9.9.9', '10.9.9.9', 'c.example', 'x', 20, 'clients')`,
    );
  });
  afterAll(async () => {
    await pool.query('TRUNCATE products, product_provision_jobs, product_turns, product_actions, product_domains, product_host_agent, product_hosts RESTART IDENTITY CASCADE');
    await pool.end();
  });

  it('успех rekey: ключи из коробки в продукте, коробка стёрта, карточка done с новыми именами', async () => {
    const p = await product({ status: 'running', secrets: { BOT_TOKEN: '123456:TEST-old', OLD_KEY: 'o' } });
    const { actionId, jobId } = await runningRekey(p, { BOT_TOKEN: '123456:TEST-old', NEW_KEY: 'n' }, { newKeyNames: ['BOT_TOKEN', 'NEW_KEY'], removedNames: ['OLD_KEY'] });

    await svc.completeJob(jobId, { ok: true });

    expect(secrets.decrypt((await productRow(p)).secrets_encrypted, p)).toEqual({ BOT_TOKEN: '123456:TEST-old', NEW_KEY: 'n' });
    const a = await actionRow(actionId);
    expect(a.status).toBe('done');
    expect(a.secrets_box).toBeNull();
    expect(a.result).toEqual({ keyNames: ['BOT_TOKEN', 'NEW_KEY'] });
    expect(JSON.stringify(a)).not.toContain('TEST-old');
  });

  it('пустой новый набор — secrets_encrypted NULL, как у заведения без ключей', async () => {
    const p = await product({ status: 'running', kind: 'site', secrets: { A: '1' } });
    const { jobId } = await runningRekey(p, {}, { newKeyNames: [], removedNames: ['A'] });
    await svc.completeJob(jobId, { ok: true });
    expect((await productRow(p)).secrets_encrypted).toBeNull();
  });

  it('отказ rekey: ключи прежние, коробка стёрта, карточка failed с человеческим текстом, продукт не тронут', async () => {
    const p = await product({ status: 'running', secrets: { BOT_TOKEN: '123456:TEST-old' } });
    const before = await productRow(p);
    const { actionId, jobId } = await runningRekey(p, { BOT_TOKEN: '123456:TEST-bad' }, { newKeyNames: ['BOT_TOKEN'], removedNames: [] });

    await svc.completeJob(jobId, { ok: false, error: 'ключи не применены: продукт не ответил на /health' });

    const after = await productRow(p);
    expect(after.secrets_encrypted.equals(before.secrets_encrypted)).toBe(true);
    expect(after.status).toBe('running');
    expect(after.provision_error).toBeNull();
    const a = await actionRow(actionId);
    expect(a.status).toBe('failed');
    expect(a.secrets_box).toBeNull();
    expect(a.result).toEqual({ error: REKEY_FAILED_SAY, reason: 'rekey_failed' });
    const j = (await pool.query(`SELECT status, error FROM product_provision_jobs WHERE id = $1`, [jobId])).rows[0];
    expect(j).toEqual({ status: 'failed', error: 'ключи не применены: продукт не ответил на /health' });
  });

  it('повторный отчёт — ничего не меняет', async () => {
    const p = await product({ status: 'running', secrets: { BOT_TOKEN: '123456:TEST-old' } });
    const { actionId, jobId } = await runningRekey(p, { BOT_TOKEN: '123456:TEST-new' }, { newKeyNames: ['BOT_TOKEN'], removedNames: [] });
    await svc.completeJob(jobId, { ok: true });
    await svc.completeJob(jobId, { ok: false, error: 'поздний отказ' });
    expect((await actionRow(actionId)).status).toBe('done');
    expect(secrets.decrypt((await productRow(p)).secrets_encrypted, p)).toEqual({ BOT_TOKEN: '123456:TEST-new' });
  });

  it('смена BOT_TOKEN: tg_bot_id новый; занят другим живым — отчёт проходит, метка прежняя', async () => {
    const p = await product({ status: 'running', tgBotId: 111, secrets: { BOT_TOKEN: '123456:TEST-old' } });
    const a1 = await runningRekey(p, { BOT_TOKEN: '222222:TEST-new' }, { newKeyNames: ['BOT_TOKEN'], removedNames: [], tgBotId: 222 });
    await svc.completeJob(a1.jobId, { ok: true });
    expect(Number((await productRow(p)).tg_bot_id)).toBe(222);

    await product({ status: 'running', tgBotId: 333 });
    const a2 = await runningRekey(p, { BOT_TOKEN: '333333:TEST-x' }, { newKeyNames: ['BOT_TOKEN'], removedNames: [], tgBotId: 333 });
    await expect(svc.completeJob(a2.jobId, { ok: true })).resolves.toBeUndefined();
    expect(Number((await productRow(p)).tg_bot_id)).toBe(222);
    expect((await actionRow(a2.actionId)).status).toBe('done');
  });

  it('успех purge: purged_at, секреты и первая правка стёрты, домен снят, журнал system; строка и задания на месте', async () => {
    const p = await product({ status: 'archived', archived: true, kind: 'site', secrets: { A: '1' } });
    await pool.query(
      `INSERT INTO product_domains (product_id, domain, names, token, status) VALUES ($1, 'shop.example.ru', '{shop.example.ru}', 't', 'active')`,
      [p],
    );
    await pool.query(`INSERT INTO product_provision_jobs (product_id, kind, status) VALUES ($1, 'provision', 'done')`, [p]);
    const j = await pool.query(`INSERT INTO product_provision_jobs (product_id, kind, status, started_at) VALUES ($1, 'purge', 'running', now()) RETURNING id`, [p]);

    await svc.completeJob(j.rows[0].id, { ok: true });

    const row = await productRow(p);
    expect(row.purged_at).not.toBeNull();
    expect(row.secrets_encrypted).toBeNull();
    expect(row.first_prompt).toBeNull();
    expect((await pool.query(`SELECT 1 FROM product_domains WHERE product_id = $1`, [p])).rows).toHaveLength(0);
    expect((await pool.query(`SELECT count(*)::int AS n FROM product_provision_jobs WHERE product_id = $1`, [p])).rows[0].n).toBe(2);
    const log = await pool.query(`SELECT kind, status, channel, payload FROM product_actions WHERE product_id = $1`, [p]);
    expect(log.rows).toEqual([{ kind: 'purge', status: 'done', channel: 'system', payload: { name: 'П', slug: row.slug } }]);
  });

  it('отказ purge: продукт не помечен стёртым, журнал failed без сырой причины агента', async () => {
    const p = await product({ status: 'archived', archived: true, kind: 'site' });
    const j = await pool.query(`INSERT INTO product_provision_jobs (product_id, kind, status, started_at) VALUES ($1, 'purge', 'running', now()) RETURNING id`, [p]);
    await svc.completeJob(j.rows[0].id, { ok: false, error: 'certbot не удалил сертификат linkeon-x' });
    expect((await productRow(p)).purged_at).toBeNull();
    const log = await pool.query(`SELECT status, result FROM product_actions WHERE product_id = $1`, [p]);
    expect(log.rows[0].status).toBe('failed');
    expect(JSON.stringify(log.rows[0].result)).not.toContain('certbot');
  });

  it('откат не удался — rekey_unknown: свой текст карточки и logger.error со слагом', async () => {
    const p = await product({ status: 'running', secrets: { BOT_TOKEN: '123456:TEST-old' } });
    const { actionId, jobId } = await runningRekey(p, { BOT_TOKEN: '123456:TEST-bad' }, { newKeyNames: ['BOT_TOKEN'], removedNames: [] });
    const errors: string[] = [];
    (svc as any).logger = { error: (m: string) => errors.push(m), warn: () => undefined, log: () => undefined, debug: () => undefined };
    await svc.completeJob(jobId, { ok: false, error: 'НА ХОСТЕ ОСТАЛОСЬ: старый контейнер не вернул имя\nключи не применены: …; откат не удался' });
    const a = await actionRow(actionId);
    expect(a.result).toEqual({ error: REKEY_UNKNOWN_SAY, reason: 'rekey_unknown' });
    const slug = (await productRow(p)).slug;
    expect(errors.some((m) => m.includes(slug) && /неизвестен/.test(m))).toBe(true);
  });

  // Тексты агента (product-runner/src/host/index.ts и rekey.ts) — какой исход
  // машины за ними стоит. «неизвестный вид задания» — агент старее сервера,
  // хост не тронут; «не началась … НЕИЗВЕСТНО» — эта смена хост не трогала,
  // но прежняя, брошенная по сроку, ещё идёт — продукт может не отвечать.
  it.each([
    ['ключи не применены: docker run с новыми ключами отказал: код 125; продукт возвращён со старыми ключами', 'rekey_failed'],
    ['контейнер s-x не запущен (спит или прервана прошлая смена ключей) — ничего не тронуто', 'rekey_failed'],
    ['неизвестный вид задания: "rekey". Агент умеет provision, sleep, wake, domain — эта работа сделана НЕ БЫЛА, на хосте ничего не тронуто. Похоже, сервер новее агента на машине продуктов.', 'rekey_failed'],
    ['смена ключей не уложилась в 480 с и брошена: состояние хоста НЕИЗВЕСТНО — продукт мог остаться под именем s-x__rekey со старыми ключами, сверить руками', 'rekey_unknown'],
    ['смена ключей над s-x не началась: прежняя работа над этим продуктом, брошенная по сроку, ещё идёт на хосте — это задание ничего не тронуло. Состояние продукта НЕИЗВЕСТНО', 'rekey_unknown'],
    ['ключи не применены: продукт не ответил на /health за 120 с с новыми ключами; откат не удался', 'rekey_unknown'],
  ])('причина агента %j — %s', async (error, reason) => {
    const p = await product({ status: 'running', secrets: { BOT_TOKEN: '123456:TEST-old' } });
    const { actionId, jobId } = await runningRekey(p, { BOT_TOKEN: '123456:TEST-bad' }, { newKeyNames: ['BOT_TOKEN'], removedNames: [] });
    (svc as any).logger = quietLogger([]);
    await svc.completeJob(jobId, { ok: false, error });
    expect((await actionRow(actionId)).result).toEqual({
      error: reason === 'rekey_unknown' ? REKEY_UNKNOWN_SAY : REKEY_FAILED_SAY,
      reason,
    });
  });

  it('поздний успех после снятия задания — база не тронута, logger.error с правдой', async () => {
    const p = await product({ status: 'running', secrets: { BOT_TOKEN: '123456:TEST-old' } });
    const before = await productRow(p);
    const { jobId } = await runningRekey(p, { BOT_TOKEN: '123456:TEST-new' }, { newKeyNames: ['BOT_TOKEN'], removedNames: [] });
    await pool.query(`UPDATE product_provision_jobs SET status = 'failed', error = 'снято блокировкой администратора' WHERE id = $1`, [jobId]);
    const errors: string[] = [];
    (svc as any).logger = { error: (m: string) => errors.push(m), warn: () => undefined, log: () => undefined, debug: () => undefined };
    await svc.completeJob(jobId, { ok: true });
    expect((await productRow(p)).secrets_encrypted.equals(before.secrets_encrypted)).toBe(true);
    expect(errors.some((m) => m.includes(before.slug) && /в контейнере новые ключи, в базе прежние/.test(m))).toBe(true);
  });

  it('повтор отчёта об успехе (обрыв POST) — не тревога: задание уже done, ключи в базе те же, что в контейнере', async () => {
    const p = await product({ status: 'running', secrets: { BOT_TOKEN: '123456:TEST-old' } });
    const { jobId } = await runningRekey(p, { BOT_TOKEN: '123456:TEST-new' }, { newKeyNames: ['BOT_TOKEN'], removedNames: [] });
    await svc.completeJob(jobId, { ok: true });
    const errors: string[] = [];
    const warns: string[] = [];
    (svc as any).logger = quietLogger(errors, warns);
    await svc.completeJob(jobId, { ok: true });
    expect(errors).toEqual([]);
    expect(warns).toHaveLength(1);
    expect(secrets.decrypt((await productRow(p)).secrets_encrypted, p)).toEqual({ BOT_TOKEN: '123456:TEST-new' });
  });

  it('успех, а коробки карточки уже нет — задание закрыто, ключи прежние, logger.error с правдой', async () => {
    const p = await product({ status: 'running', secrets: { BOT_TOKEN: '123456:TEST-old' } });
    const before = await productRow(p);
    const { actionId, jobId } = await runningRekey(p, { BOT_TOKEN: '123456:TEST-new' }, { newKeyNames: ['BOT_TOKEN'], removedNames: [] });
    // Карточку удалили — FK задания SET NULL, коробку взять неоткуда.
    await pool.query(`DELETE FROM product_actions WHERE id = $1`, [actionId]);
    const errors: string[] = [];
    (svc as any).logger = quietLogger(errors);
    await svc.completeJob(jobId, { ok: true });
    expect((await pool.query(`SELECT status FROM product_provision_jobs WHERE id = $1`, [jobId])).rows[0].status).toBe('done');
    expect((await productRow(p)).secrets_encrypted.equals(before.secrets_encrypted)).toBe(true);
    expect(errors.some((m) => m.includes(before.slug) && /в контейнере новые ключи, в базе прежние/.test(m))).toBe(true);
  });

  it('коробка не читается при выдаче — задание закрыто отказом, карточка rekey_failed, коробка стёрта, ключи прежние', async () => {
    const p = await product({ status: 'running', secrets: { BOT_TOKEN: '123456:TEST-old' } });
    const before = await productRow(p);
    // Коробка чужого продукта: AAD не сойдётся — так же, как при порче или
    // сменённом ключе шифрования.
    const a = await pool.query(
      `INSERT INTO product_actions (user_id, product_id, kind, status, channel, payload, secrets_box)
       VALUES ('u1', $1, 'keys', 'working', 'web', $2::jsonb, $3) RETURNING id`,
      [p, JSON.stringify({ newKeyNames: ['BOT_TOKEN'], removedNames: [] }), secrets.encrypt({ BOT_TOKEN: '123456:TEST-new' }, crypto.randomUUID())],
    );
    const j = await pool.query(
      `INSERT INTO product_provision_jobs (product_id, kind, status, action_id) VALUES ($1, 'rekey', 'queued', $2) RETURNING id`,
      [p, a.rows[0].id],
    );
    (svc as any).logger = quietLogger([]);

    await expect(svc.claimJob('clients')).resolves.toBeNull();

    const job = (await pool.query(`SELECT status, error, started_at FROM product_provision_jobs WHERE id = $1`, [j.rows[0].id])).rows[0];
    expect(job.status).toBe('failed');
    expect(job.error).toBe(BOX_UNREADABLE);
    const card = await actionRow(a.rows[0].id);
    expect(card.status).toBe('failed');
    expect(card.secrets_box).toBeNull();
    expect(card.result).toEqual({ error: REKEY_FAILED_SAY, reason: 'rekey_failed' });
    expect((await productRow(p)).secrets_encrypted.equals(before.secrets_encrypted)).toBe(true);
  });

  it('сборщик называет свой срок у смены ключей и стирания', async () => {
    const p = await product({ status: 'running' });
    const { jobId } = await runningRekey(p, { BOT_TOKEN: '123456:TEST-x' }, { newKeyNames: ['BOT_TOKEN'], removedNames: [] });
    await pool.query(`UPDATE product_provision_jobs SET started_at = now() - interval '11 minutes' WHERE id = $1`, [jobId]);
    await svc.failStaleProvisioning();
    const j = (await pool.query(`SELECT status, error FROM product_provision_jobs WHERE id = $1`, [jobId])).rows[0];
    expect(j).toEqual({ status: 'failed', error: 'срок смены ключей истёк (10 мин)' });
    expect((await productRow(p)).status).toBe('running');

    const gone = await product({ status: 'archived', archived: true, kind: 'site' });
    const pj = await pool.query(
      `INSERT INTO product_provision_jobs (product_id, kind, status, started_at) VALUES ($1, 'purge', 'running', now() - interval '11 minutes') RETURNING id`,
      [gone],
    );
    await svc.failStaleProvisioning();
    expect((await pool.query(`SELECT status, error FROM product_provision_jobs WHERE id = $1`, [pj.rows[0].id])).rows[0])
      .toEqual({ status: 'failed', error: 'срок стирания истёк (10 мин)' });
    const g = await productRow(gone);
    expect(g.status).toBe('archived');
    expect(g.purged_at).toBeNull();
  });
});
