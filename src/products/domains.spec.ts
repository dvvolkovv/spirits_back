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

  const mkProduct = async (o: { slug: string; user?: string; kind?: string; status?: string; domain?: string | null }) => {
    const r = await pool.query(
      `INSERT INTO products (user_id, name, slug, kind, status, checkout_path, runner_token_hash, host_id, port, domain)
       VALUES ($1, $2, $2, $3, $4, $5, $6, 'own', 8001, $7) RETURNING id`,
      [o.user ?? OWNER, o.slug, o.kind ?? 'site', o.status ?? 'running', `/srv/${o.slug}`, `hash-${o.slug}`,
       o.domain !== undefined ? o.domain : (o.kind ?? 'site') === 'site' ? `${o.slug}.p.linkeon.io` : null],
    );
    return r.rows[0].id as string;
  };

  /**
   * Обёртка pg для гонок: запросы по шаблону ждут, пока их не соберётся n, и
   * уходят в базу разом. Не дождались за 5 с — отпускает всех: пусть решают
   * утверждения теста, а не таймаут jest.
   */
  const barrierOn = (re: RegExp, n = 2) => {
    let arrived = 0;
    let release!: () => void;
    const all = new Promise<void>((r) => (release = r));
    const timer = setTimeout(() => release(), 5_000);
    return {
      query: async (sql: string, params?: any[]) => {
        if (re.test(sql)) {
          if (++arrived === n) {
            clearTimeout(timer);
            release();
          }
          await all;
        }
        return pool.query(sql, params);
      },
    };
  };

  /** Опрос условия (не сон вслепую): короткая пауза между заходами, потолок 10 с. */
  const until = async (cond: () => Promise<boolean>) => {
    const deadline = Date.now() + 10_000;
    while (!(await cond())) {
      if (Date.now() > deadline) throw new Error('условие не наступило за 10 с');
      await new Promise((r) => setTimeout(r, 10));
    }
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
      const first = await svc().attach(OWNER, id, 'a.ru');
      const token = (await row(id)).token;
      await expect(svc().attach(OWNER, id, 'https://A.RU/')).resolves.toEqual(first);
      expect((await row(id)).token).toBe(token);
    });

    it('второй домен на продукт — отказ', async () => {
      const id = await mkProduct({ slug: 'shop' });
      await svc().attach(OWNER, id, 'a.ru');
      await expect(svc().attach(OWNER, id, 'b.ru')).rejects.toMatchObject({ status: 409, response: { reason: 'has_domain' } });
    });

    // Отвязка уже идёт: «сначала отвяжите» было бы неправдой, а 200 со
    // строкой в removing — обещанием домена, который вот-вот снимут.
    it('пока домен отвязывается — любая привязка 409 removing', async () => {
      const id = await mkProduct({ slug: 'shop' });
      await putDomain(id, 'removing');
      const removing = { status: 409, response: { reason: 'removing' } };
      await expect(svc().attach(OWNER, id, 'a.ru')).rejects.toMatchObject(removing);
      await expect(svc().attach(OWNER, id, 'b.ru')).rejects.toMatchObject(removing);
    });

    // Спека: заявок в awaiting_dns на один домен сколько угодно — домен
    // достаётся той, чей TXT первым появится в DNS. Считай занятость и по
    // ждущим/отказанным, любой мог бы забронировать чужой домен впрок.
    it('чужие заявки awaiting_dns и failed на тот же домен не мешают', async () => {
      const mine = await mkProduct({ slug: 'mine' });
      const t1 = await mkProduct({ slug: 't1', user: ALIEN });
      const t2 = await mkProduct({ slug: 't2', user: ALIEN });
      await putDomain(t1, 'awaiting_dns', { token: 'lk-1' });
      await putDomain(t2, 'failed', { token: 'lk-2', error: 'x' });
      await expect(svc().attach(OWNER, mine, 'a.ru')).resolves.toMatchObject({ status: 'awaiting_dns' });
    });

    // Обе прошли проверку «строки нет» и вставляют разом: без ON CONFLICT
    // вторая получила бы 500 (23505 product_domains_pkey).
    it('две привязки разных доменов разом — одна проходит, другая has_domain, строка одна', async () => {
      const id = await mkProduct({ slug: 'shop' });
      const s = svc(barrierOn(/^\s*INSERT INTO product_domains/));
      const results = await Promise.allSettled([s.attach(OWNER, id, 'a.ru'), s.attach(OWNER, id, 'b.ru')]);
      const ok = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<any>[];
      const refused = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      expect(ok).toHaveLength(1);
      expect(refused).toHaveLength(1);
      expect(refused[0].reason).toMatchObject({ status: 409, response: { reason: 'has_domain' } });
      const rows = (await pool.query(`SELECT domain FROM product_domains WHERE product_id = $1`, [id])).rows;
      expect(rows).toEqual([{ domain: ok[0].value.domain }]);
    });

    // Проигравший в ON CONFLICT не гоняет свою проверку DNS: её гоняет тот,
    // кто завёл строку, а проигравшему достаётся ответ по этой строке.
    it('две привязки одного домена разом — DNS проверяет только та, что завела строку', async () => {
      const id = await mkProduct({ slug: 'shop' });
      const txt = jest.spyOn(dns, 'resolveTxt');
      const s = svc(barrierOn(/^\s*INSERT INTO product_domains/));
      const results = await Promise.allSettled([s.attach(OWNER, id, 'a.ru'), s.attach(OWNER, id, 'a.ru')]);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      expect(results.map((r: any) => r.value.domain)).toEqual(['a.ru', 'a.ru']);
      expect(txt).toHaveBeenCalledTimes(1);
    });

    // Адрес платформы — products.domain: из него кабинет рисует ссылку и по
    // нему заведение проверяет /health. Склейка слага с зоной машины — только
    // запасной путь, если адреса вдруг нет.
    it('цель CNAME — адрес продукта из products.domain', async () => {
      const id = await mkProduct({ slug: 'shop', domain: 'shop-legacy.p.linkeon.io' });
      const v = await svc().attach(OWNER, id, 'shop.dmitryvolkov.ru');
      expect(v.records[1]).toMatchObject({ type: 'CNAME', value: 'shop-legacy.p.linkeon.io' });

      const bare = await mkProduct({ slug: 'bare', domain: null });
      const vb = await svc().attach(OWNER, bare, 'bare.dmitryvolkov.ru');
      expect(vb.records[1]).toMatchObject({ type: 'CNAME', value: 'bare.p.linkeon.io' });
    });

    it('домен, работающий у другого продукта, — отказ', async () => {
      const mine = await mkProduct({ slug: 'mine' });
      const theirs = await mkProduct({ slug: 'theirs', user: ALIEN });
      await putDomain(theirs, 'active');
      await expect(svc().attach(OWNER, mine, 'a.ru')).rejects.toMatchObject({ status: 409, response: { reason: 'taken' } });
      expect(await row(mine)).toBeUndefined();
    });

    // Обход проверки владения. Проверка DNS длится до ~7 с, и длительность
    // держит владелец проверяемого домена. Пока a.ru проверяется, заявку
    // отвязывают и заводят b.ru; «всё зелёное» от a.ru, записанное по одному
    // product_id, легло бы в строку b.ru, и выпуск стартовал бы для b.ru, чей
    // TXT в DNS не появлялся ни разу. Результат принадлежит заявке (её коду).
    it('заявку сменили, пока шла проверка DNS, — результат старой не ложится на новую', async () => {
      const id = await mkProduct({ slug: 'shop' });
      const IP = '139.59.210.42';
      const A_NAMES = ['a.ru', 'www.a.ru'];
      let open!: () => void;
      const gate = new Promise<void>((r) => (open = r));
      let started!: () => void;
      const inFlight = new Promise<void>((r) => (started = r));
      // DNS a.ru полностью готов — TXT с кодом ИМЕННО этой заявки, A на
      // машину, AAAA нет, — но отвечает только по сигналу теста, как
      // медленный сервер владельца. Остальные имена — обычный подменный DNS,
      // мгновенно (у b.ru пусто).
      const resolver: DnsResolver = {
        resolveTxt: async (n) => {
          if (n !== `${TXT_LABEL}.a.ru`) return dns.resolveTxt(n);
          const token = (await row(id)).token; // код заявки a.ru, пока она в базе
          started(); // к этому моменту checkDns уже запустил и A/AAAA a.ru
          await gate;
          return [[token]];
        },
        resolve4: async (n) => {
          if (!A_NAMES.includes(n)) return dns.resolve4(n);
          await gate;
          return [IP];
        },
        resolve6: async (n) => {
          if (A_NAMES.includes(n)) await gate;
          return dns.resolve6(n);
        },
      };
      const s = new DomainsService(pg as any);
      (s as any).resolver = resolver;
      const issue = jest.spyOn(s, 'tryIssue');

      const pending = s.attach(OWNER, id, 'a.ru');
      pending.catch(() => undefined); // отказ разбирает expect ниже; до него он не «необработанный»
      await inFlight; // заявка a.ru заведена, её проверка в полёте

      await expect(s.detach(OWNER, id)).resolves.toEqual({ removed: 'now' });
      const vb = await s.attach(OWNER, id, 'b.ru'); // своя проверка b.ru кончается сразу: DNS пуст
      expect(vb.status).toBe('awaiting_dns');
      const tokenB = (await row(id)).token;

      open();
      await expect(pending).rejects.toMatchObject({ status: 409, response: { reason: 'changed' } });

      const r = await row(id);
      expect(r).toMatchObject({ domain: 'b.ru', status: 'awaiting_dns', token: tokenB });
      // Результат в строке — проверки b.ru, а не «всё зелёное» от a.ru.
      expect(r.check_result.records.map((c: any) => `${c.type} ${c.name}`)).toEqual([
        'TXT _linkeon.b.ru', 'A b.ru', 'AAAA b.ru', 'A www.b.ru', 'AAAA www.b.ru',
      ]);
      expect(r.check_result.records[0]).toMatchObject({ ok: false, want: tokenB });
      // Выпуск по результату чужой заявки не просится вовсе.
      expect(issue).not.toHaveBeenCalled();
      expect(await jobs(id)).toEqual([]);
    });

    // Второе окно той же гонки — между записью результата и чтением строки
    // для ответа: показать её значило бы ответить на привязку a.ru доменом b.ru.
    it('заявку сменили сразу после записи результата — ответ не выдаёт новую за проверенную', async () => {
      const id = await mkProduct({ slug: 'shop' });
      let swapped = false;
      const racing = {
        query: async (sql: string, params?: any[]) => {
          const res = await pool.query(sql, params);
          if (!swapped && /^\s*UPDATE product_domains SET check_result/.test(sql)) {
            swapped = true;
            await pool.query(`DELETE FROM product_domains WHERE product_id = $1`, [id]);
            await putDomain(id, 'awaiting_dns', { domain: 'b.ru', token: 'lk-b' });
          }
          return res;
        },
      };
      await expect(svc(racing).attach(OWNER, id, 'a.ru')).rejects.toMatchObject({ status: 409, response: { reason: 'changed' } });
      expect(await row(id)).toMatchObject({ domain: 'b.ru', token: 'lk-b', check_result: null });
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

    it('архивный продукт — привязка, состояние и отвязка не находят его', async () => {
      const id = await mkProduct({ slug: 'shop' });
      await putDomain(id, 'active');
      await pool.query(`UPDATE products SET archived_at = now() WHERE id = $1`, [id]);
      const notFound = { status: 404, response: { reason: 'not_found' } };
      await expect(svc().attach(OWNER, id, 'b.ru')).rejects.toMatchObject(notFound);
      await expect(svc().get(OWNER, id)).rejects.toMatchObject(notFound);
      await expect(svc().detach(OWNER, id)).rejects.toMatchObject(notFound);
      expect((await row(id)).status).toBe('active');
      expect(await jobs(id)).toEqual([]);
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

    it('чужой продукт — отвязать нельзя', async () => {
      const alien = await mkProduct({ slug: 'alien', user: ALIEN });
      await putDomain(alien, 'active');
      await expect(svc().detach(OWNER, alien)).rejects.toMatchObject({ status: 404, response: { reason: 'not_found' } });
      expect((await row(alien)).status).toBe('active');
      expect(await jobs(alien)).toEqual([]);
    });

    it('из removing — «поставлена», второго задания нет', async () => {
      const id = await mkProduct({ slug: 'shop' });
      await putDomain(id, 'removing');
      await pool.query(`INSERT INTO product_provision_jobs (product_id, kind, status) VALUES ($1, 'domain', 'queued')`, [id]);
      await expect(svc().detach(OWNER, id)).resolves.toEqual({ removed: 'queued' });
      expect(await jobs(id)).toEqual([{ kind: 'domain', status: 'queued' }]);
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

    // Встречное задание: пробуждение вставила чужая, ещё не закоммиченная
    // транзакция — NOT EXISTS его не видит, и отвязка упирается в
    // единственное активное задание продукта (23505 one_active). Это
    // «занято», а не «домен держит другой продукт»: удалить здесь строку
    // failed значило бы оставить на машине блоки порта 80 без задания отвязки.
    it('встречное задание во время отвязки failed — 409 busy, строка на месте', async () => {
      const id = await mkProduct({ slug: 'shop' });
      await putDomain(id, 'failed', { error: 'x' });
      const other = await pool.connect();
      let open = false;
      try {
        await other.query('BEGIN');
        open = true;
        await other.query(`INSERT INTO product_provision_jobs (product_id, kind, status) VALUES ($1, 'wake', 'queued')`, [id]);
        const pending = svc().detach(OWNER, id);
        pending.catch(() => undefined); // отказ разбирает expect ниже
        // Отвязка обязана встать на блокировке уникального индекса заданий.
        await until(async () =>
          (await pool.query(
            `SELECT 1 FROM pg_stat_activity
              WHERE datname = current_database() AND pid <> pg_backend_pid()
                AND wait_event_type = 'Lock' AND query LIKE 'WITH d AS%'`,
          )).rows.length > 0,
        );
        await other.query('COMMIT');
        open = false;
        await expect(pending).rejects.toMatchObject({ status: 409, response: { reason: 'busy' } });
        expect((await row(id)).status).toBe('failed');
      } finally {
        if (open) await other.query('ROLLBACK').catch(() => undefined);
        other.release();
      }
    });

    // Вторая отвязка той же строки — не «другое задание»: отвязку уже
    // поставила первая, и правдивый ответ обеим — «поставлена».
    it('две отвязки разом — обе «поставлена», задание одно', async () => {
      const id = await mkProduct({ slug: 'shop' });
      await putDomain(id, 'active');
      const s = svc(barrierOn(/^\s*WITH d AS/));
      const results = await Promise.allSettled([s.detach(OWNER, id), s.detach(OWNER, id)]);
      expect(results).toEqual([
        { status: 'fulfilled', value: { removed: 'queued' } },
        { status: 'fulfilled', value: { removed: 'queued' } },
      ]);
      expect((await row(id)).status).toBe('removing');
      expect(await jobs(id)).toEqual([{ kind: 'domain', status: 'queued' }]);
    });

    // Отказ taken — «домен занят другим продуктом»: эта заявка до машины не
    // доходила, а перевод в removing упёрся бы в индекс занятых доменов.
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
