import { HttpException } from '@nestjs/common';
import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import { MIGRATIONS } from './products.service';
import { DomainsService } from './domains.service';
import { DnsResolver, TXT_LABEL } from './domain-dns';

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;

const WIPE = 'TRUNCATE products, product_provision_jobs, product_turns, product_host_agent, product_hosts RESTART IDENTITY CASCADE';

/** Подменный DNS: изменяемая таблица записей. Пусто — «записи нет». */
class FakeDns implements DnsResolver {
  zone: Record<string, { A?: string[]; AAAA?: string[]; TXT?: string[][] }> = {};
  private get(name: string, key: 'A' | 'AAAA' | 'TXT') {
    const v = this.zone[name]?.[key];
    return v ? Promise.resolve(v as any) : Promise.reject(Object.assign(new Error('ENODATA'), { code: 'ENODATA' }));
  }
  resolve4 = (n: string) => this.get(n, 'A');
  resolve6 = (n: string) => this.get(n, 'AAAA');
  resolveTxt = (n: string) => this.get(n, 'TXT');
  /** Всё, что нужно для выпуска, — как сделал бы владелец домена. */
  ready(domain: string, names: string[], token: string, ip = '139.59.210.42') {
    this.zone[`${TXT_LABEL}.${domain}`] = { TXT: [[token]] };
    for (const n of names) this.zone[n] = { A: [ip] };
  }
}

maybe('свой домен: сервис против живого Postgres', () => {
  jest.setTimeout(60_000);
  let pool: Pool;
  let pg: { query: (sql: string, params?: any[]) => Promise<any> };
  let dns: FakeDns;

  const OWNER = '79030169187';
  const ALIEN = '70000000000';

  const svc = (db: { query: (sql: string, params?: any[]) => Promise<any> } = pg) => {
    const s = new DomainsService(db as any);
    (s as any).resolver = dns;
    return s;
  };

  const mkProduct = async (o: { slug: string; user?: string; kind?: string; status?: string }) => {
    const r = await pool.query(
      `INSERT INTO products (user_id, name, slug, kind, status, checkout_path, runner_token_hash, host_id, port, domain)
       VALUES ($1, $2, $2, $3, $4, $5, $6, 'own', 8001, $7) RETURNING id`,
      [o.user ?? OWNER, o.slug, o.kind ?? 'site', o.status ?? 'running', `/srv/${o.slug}`, `hash-${o.slug}`,
       (o.kind ?? 'site') === 'site' ? `${o.slug}.p.linkeon.io` : null],
    );
    return r.rows[0].id as string;
  };
  const row = async (productId: string) =>
    (await pool.query(`SELECT * FROM product_domains WHERE product_id = $1`, [productId])).rows[0];
  const jobs = async (productId: string) =>
    (await pool.query(`SELECT kind, status FROM product_provision_jobs WHERE product_id = $1 ORDER BY created_at`, [productId])).rows;
  const putDomain = (productId: string, status: string, extra: { domain?: string; token?: string; error?: string } = {}) =>
    pool.query(
      `INSERT INTO product_domains (product_id, domain, names, token, status, error) VALUES ($1, $2, $3, $4, $5, $6)`,
      [productId, extra.domain ?? 'a.ru', [extra.domain ?? 'a.ru', `www.${extra.domain ?? 'a.ru'}`],
       extra.token ?? 'lk-x', status, extra.error ?? null],
    );

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG, max: 8 });
    pg = { query: (sql: string, params?: any[]) => pool.query(sql, params) };
    for (const f of MIGRATIONS) await pool.query(fs.readFileSync(path.join(__dirname, 'migrations', f), 'utf8'));
    const n = await pool.query('SELECT count(*) FROM products');
    if (Number(n.rows[0].count) > 0) throw new Error('PROVISIONING_PG_URL указывает на НЕпустую базу');
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
    dns = new FakeDns();
  });

  describe('привязка', () => {
    it('заводит заявку с кодом и отдаёт записи для регистратора', async () => {
      const id = await mkProduct({ slug: 'dmitryvolkov' });
      const v = await svc().attach(OWNER, id, 'dmitryvolkov.ru');
      expect(v.status).toBe('awaiting_dns');
      expect(v.domainUnicode).toBe('dmitryvolkov.ru');
      expect(v.names).toEqual(['dmitryvolkov.ru', 'www.dmitryvolkov.ru']);
      const r = await row(id);
      expect(r.token).toMatch(/^lk-[0-9a-f]{32}$/);
      expect(v.records).toEqual([
        { type: 'TXT', name: '_linkeon', fqdn: '_linkeon.dmitryvolkov.ru', value: r.token },
        { type: 'A', name: '@', fqdn: 'dmitryvolkov.ru', value: '139.59.210.42' },
        { type: 'CNAME', name: 'www', fqdn: 'www.dmitryvolkov.ru', value: 'dmitryvolkov.p.linkeon.io' },
      ]);
    });

    it('сразу проверяет DNS и показывает, что там сейчас', async () => {
      const id = await mkProduct({ slug: 'dmitryvolkov' });
      dns.zone['dmitryvolkov.ru'] = { A: ['90.156.201.49'] };
      const v = await svc().attach(OWNER, id, 'dmitryvolkov.ru');
      expect(v.checkedAt).not.toBeNull();
      expect(v.check?.find((c) => c.type === 'A' && c.name === 'dmitryvolkov.ru')).toMatchObject({
        ok: false, current: ['90.156.201.49'],
      });
    });

    it('поддомен — CNAME на адрес продукта, без www', async () => {
      const id = await mkProduct({ slug: 'shop' });
      const v = await svc().attach(OWNER, id, 'shop.dmitryvolkov.ru');
      expect(v.records.map((r) => `${r.type} ${r.name}`)).toEqual(['TXT _linkeon.shop', 'CNAME shop']);
      expect(v.records[1].value).toBe('shop.p.linkeon.io');
    });

    // Кабинет показывает человеку пример.рф, а не xn--…; DNS, сертификат и
    // записи для регистратора — только punycode.
    it('кириллический домен — punycode в записях, читаемая форма рядом', async () => {
      const id = await mkProduct({ slug: 'shop' });
      const v = await svc().attach(OWNER, id, 'пример.рф');
      expect(v).toMatchObject({ domain: 'xn--e1afmkfd.xn--p1ai', domainUnicode: 'пример.рф' });
      expect(v.records.map((r) => [r.type, r.name, r.fqdn])).toEqual([
        ['TXT', '_linkeon', '_linkeon.xn--e1afmkfd.xn--p1ai'],
        ['A', '@', 'xn--e1afmkfd.xn--p1ai'],
        ['CNAME', 'www', 'www.xn--e1afmkfd.xn--p1ai'],
      ]);
    });

    // spb.ru — регистрационная зона FAITID из PRIVATE-раздела списка
    // суффиксов: firm.spb.ru — корень СВОЕЙ зоны, а не поддомен чужой spb.ru.
    // Иначе инструкция велела бы CNAME на корне зоны пользователя, где у
    // регистратора SOA/NS, и не дала бы www.
    it('корень частной зоны (firm.spb.ru) — A на @ и CNAME www', async () => {
      const id = await mkProduct({ slug: 'firm' });
      const v = await svc().attach(OWNER, id, 'firm.spb.ru');
      expect(v.records.map((r) => `${r.type} ${r.name}`)).toEqual(['TXT _linkeon', 'A @', 'CNAME www']);
    });

    it('кривой ввод — 422 с человеческим текстом', async () => {
      const id = await mkProduct({ slug: 'shop' });
      await expect(svc().attach(OWNER, id, '1.2.3.4')).rejects.toMatchObject({
        status: 422, response: { reason: 'ip', message: expect.stringMatching(/IP-адрес/) },
      });
    });

    it('чужой продукт — не найден, строка не заводится', async () => {
      const alien = await mkProduct({ slug: 'alien', user: ALIEN });
      await expect(svc().attach(OWNER, alien, 'a.ru')).rejects.toMatchObject({ status: 404, response: { reason: 'not_found' } });
      expect(await row(alien)).toBeUndefined();
    });

    // Тело отказа — контракт сразу с двумя читателями: кабинет переводит
    // ошибку на язык пользователя по reason, ассистент и запасной показ берут
    // русский message. Nest отдаёт объект из HttpException клиенту как есть.
    it('у бота своего домена нет — тело отказа ровно { statusCode, message, reason }', async () => {
      const id = await mkProduct({ slug: 'bot', kind: 'bot' });
      const e = await svc().attach(OWNER, id, 'a.ru').then(() => null, (x) => x);
      expect(e).toBeInstanceOf(HttpException);
      expect(e.getStatus()).toBe(409);
      expect(e.getResponse()).toEqual({ statusCode: 409, reason: 'bot', message: expect.stringMatching(/только у сайта/) });
      expect(e.message).toBe(e.getResponse().message);
    });

    it('погашенному администратором — отказ', async () => {
      const id = await mkProduct({ slug: 'shop', status: 'blocked' });
      await expect(svc().attach(OWNER, id, 'a.ru')).rejects.toMatchObject({ status: 409, response: { reason: 'blocked' } });
    });

    it('незаведённому — отказ', async () => {
      const id = await mkProduct({ slug: 'shop', status: 'provisioning' });
      await expect(svc().attach(OWNER, id, 'a.ru')).rejects.toMatchObject({ status: 409, response: { reason: 'not_ready' } });
    });

    it('спящему — можно: заглушка ляжет и на свой домен', async () => {
      const id = await mkProduct({ slug: 'shop', status: 'sleeping' });
      await expect(svc().attach(OWNER, id, 'a.ru')).resolves.toMatchObject({ status: 'awaiting_dns' });
    });

    it('повторная привязка того же домена — тот же ответ, код не меняется', async () => {
      const id = await mkProduct({ slug: 'shop' });
      await svc().attach(OWNER, id, 'a.ru');
      const token = (await row(id)).token;
      await svc().attach(OWNER, id, 'https://A.RU/');
      expect((await row(id)).token).toBe(token);
    });

    it('второй домен на продукт — отказ', async () => {
      const id = await mkProduct({ slug: 'shop' });
      await svc().attach(OWNER, id, 'a.ru');
      await expect(svc().attach(OWNER, id, 'b.ru')).rejects.toMatchObject({ status: 409, response: { reason: 'has_domain' } });
    });

    it('домен, работающий у другого продукта, — отказ', async () => {
      const mine = await mkProduct({ slug: 'mine' });
      const theirs = await mkProduct({ slug: 'theirs', user: ALIEN });
      await putDomain(theirs, 'active');
      await expect(svc().attach(OWNER, mine, 'a.ru')).rejects.toMatchObject({ status: 409, response: { reason: 'taken' } });
      expect(await row(mine)).toBeUndefined();
    });
  });

  describe('состояние', () => {
    it('нет домена — null', async () => {
      const id = await mkProduct({ slug: 'shop' });
      expect(await svc().get(OWNER, id)).toBeNull();
    });
    it('чужой продукт — не найден', async () => {
      const alien = await mkProduct({ slug: 'alien', user: ALIEN });
      await expect(svc().get(OWNER, alien)).rejects.toMatchObject({ status: 404, response: { reason: 'not_found' } });
    });
  });

  describe('отвязка', () => {
    it('из awaiting_dns — строка удаляется сразу, задания нет', async () => {
      const id = await mkProduct({ slug: 'shop' });
      await svc().attach(OWNER, id, 'a.ru');
      await expect(svc().detach(OWNER, id)).resolves.toEqual({ removed: 'now' });
      expect(await row(id)).toBeUndefined();
      expect(await jobs(id)).toEqual([]);
    });

    // Между чтением строки и удалением фоновая проверка может перевести
    // заявку в выпуск. «Удалено» в ответ было бы неправдой: сертификат
    // выпустится, и домен всплывёт работающим у того, кто его отвязал.
    it('заявку увели в выпуск между чтением и удалением — не «удалено», а отказ', async () => {
      const id = await mkProduct({ slug: 'shop' });
      await svc().attach(OWNER, id, 'a.ru');
      const racing = {
        query: async (sql: string, params?: any[]) => {
          if (/^\s*DELETE FROM product_domains/.test(sql)) {
            await pool.query(`UPDATE product_domains SET status = 'issuing' WHERE product_id = $1`, [id]);
          }
          return pool.query(sql, params);
        },
      };
      await expect(svc(racing).detach(OWNER, id)).rejects.toMatchObject({ status: 409, response: { reason: 'issuing' } });
      expect((await row(id)).status).toBe('issuing');
    });

    it('без своего домена — не найден, со своей причиной', async () => {
      const id = await mkProduct({ slug: 'shop' });
      await expect(svc().detach(OWNER, id)).rejects.toMatchObject({ status: 404, response: { reason: 'no_domain' } });
    });

    it('из active — removing и задание domain, одним оператором', async () => {
      const id = await mkProduct({ slug: 'shop' });
      await putDomain(id, 'active');
      await expect(svc().detach(OWNER, id)).resolves.toEqual({ removed: 'queued' });
      expect((await row(id)).status).toBe('removing');
      expect(await jobs(id)).toEqual([{ kind: 'domain', status: 'queued' }]);
    });

    // После отказа агент мог успеть записать блоки порта 80 — без задания
    // отвязки они остались бы на машине.
    it('из failed — тоже через removing и задание', async () => {
      const id = await mkProduct({ slug: 'shop' });
      await putDomain(id, 'failed', { error: 'x' });
      await expect(svc().detach(OWNER, id)).resolves.toEqual({ removed: 'queued' });
      expect(await jobs(id)).toEqual([{ kind: 'domain', status: 'queued' }]);
    });

    it('у погашенного — можно: отвязка сужает, а не расширяет', async () => {
      const id = await mkProduct({ slug: 'shop', status: 'blocked' });
      await putDomain(id, 'active');
      await expect(svc().detach(OWNER, id)).resolves.toEqual({ removed: 'queued' });
    });

    it('во время выпуска — отказ', async () => {
      const id = await mkProduct({ slug: 'shop' });
      await putDomain(id, 'issuing');
      await expect(svc().detach(OWNER, id)).rejects.toMatchObject({ status: 409, response: { reason: 'issuing' } });
    });

    it('у продукта идёт другое задание — отказ, строка не тронута', async () => {
      const id = await mkProduct({ slug: 'shop' });
      await putDomain(id, 'active');
      await pool.query(`INSERT INTO product_provision_jobs (product_id, kind, status) VALUES ($1, 'sleep', 'running')`, [id]);
      await expect(svc().detach(OWNER, id)).rejects.toMatchObject({ status: 409, response: { reason: 'busy' } });
      expect((await row(id)).status).toBe('active');
    });

    // Отказ «домен занят другим продуктом»: у этой заявки на машине ничего нет,
    // а перевод в removing упёрся бы в индекс занятых доменов.
    it('failed из-за занятого домена — строка удаляется сразу', async () => {
      const mine = await mkProduct({ slug: 'mine' });
      const theirs = await mkProduct({ slug: 'theirs', user: ALIEN });
      await putDomain(theirs, 'active', { token: 'lk-t' });
      await putDomain(mine, 'failed', { token: 'lk-m', error: 'занят' });
      await expect(svc().detach(OWNER, mine)).resolves.toEqual({ removed: 'now' });
      expect(await row(mine)).toBeUndefined();
    });
  });
});
