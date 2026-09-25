import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MAX_DOMAIN_LENGTH, assertDomainName, vhostArgv } from './vhost';

/**
 * Настоящий скрипт в песочнице. Пути подменяются через окружение (PV_*),
 * перечитка — `true`. `nginx -t` — НАСТОЯЩИЙ там, где есть /usr/sbin/nginx
 * (нода): через обёртку, которая переносит порты 80/443 выше 1024 — nginx
 * 1.24 при `-t` привязывает сокеты, а тест идёт не от root.
 */
const SCRIPT = path.resolve(__dirname, '../../../scripts/product-vhost');
const NGINX = '/usr/sbin/nginx';
const HAVE_NGINX = fs.existsSync(NGINX);

interface Sandbox {
  root: string;
  run: (...args: string[]) => { status: number | null; out: string };
  conf: (slug: string) => string;
  confs: () => string[];
  cert: (slug: string) => void;
  bucket: (size: number | null) => void;
}

// Песочницы убираются после каждого теста: иначе каждый прогон оставлял бы в
// /tmp каталоги с ключами и конфигами.
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

function sandbox(realNginx: boolean): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-'));
  roots.push(root);
  for (const d of ['conf', 'live', 'acme', 'share', 'snippets', 'tmp', 'shadow']) fs.mkdirSync(path.join(root, d));
  let nginxBin = 'true';
  if (realNginx) {
    const gen = spawnSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=probe',
      '-keyout', path.join(root, 'key.pem'), '-out', path.join(root, 'crt.pem'),
    ], { encoding: 'utf8' });
    if (gen.status !== 0) throw new Error(`openssl: ${gen.stderr}`);
    // Как snippets/products-ssl.conf на машинах, только с самоподписанным сертификатом.
    fs.writeFileSync(path.join(root, 'snippets/products-ssl.conf'),
      `ssl_certificate ${root}/crt.pem;\nssl_certificate_key ${root}/key.pem;\n` +
      'ssl_protocols TLSv1.2 TLSv1.3;\nssl_session_cache shared:SSL:10m;\n');
    const p80 = 30000 + (process.pid % 10000);
    const p443 = p80 + 1;
    const wrapper = path.join(root, 'nginx-t');
    fs.writeFileSync(wrapper, [
      '#!/bin/sh',
      `rm -f "${root}/shadow/"*.conf`,
      `for f in "${root}/conf/"*.conf; do`,
      '  [ -e "$f" ] || continue',
      `  sed -e 's/listen 80;/listen 127.0.0.1:${p80};/' -e 's/listen 443 ssl;/listen 127.0.0.1:${p443} ssl;/' "$f" > "${root}/shadow/$(basename "$f")"`,
      'done',
      `exec ${NGINX} -t -p "${root}/" -c "${root}/nginx.conf" -e "${root}/error.log"`,
      '',
    ].join('\n'), { mode: 0o755 });
    nginxBin = wrapper;
  }
  const bucket = (size: number | null) => fs.writeFileSync(path.join(root, 'nginx.conf'), [
    `pid ${root}/nginx.pid;`,
    `error_log ${root}/error.log;`,
    'events {}',
    'http {',
    size ? `  server_names_hash_bucket_size ${size};` : '',
    `  client_body_temp_path ${root}/tmp/body; proxy_temp_path ${root}/tmp/proxy; fastcgi_temp_path ${root}/tmp/fcgi;`,
    `  uwsgi_temp_path ${root}/tmp/uwsgi; scgi_temp_path ${root}/tmp/scgi; access_log off;`,
    `  include ${root}/shadow/*.conf;`,
    '}',
    '',
  ].join('\n'));
  bucket(null); // как на машинах до PHASE 4 этой задачи: корзина по умолчанию, 64
  const env = {
    ...process.env,
    PV_CONF_DIR: path.join(root, 'conf'),
    PV_LE_LIVE: path.join(root, 'live'),
    PV_ACME_ROOT: path.join(root, 'acme'),
    PV_ASLEEP_DIR: path.join(root, 'share'),
    PV_NGINX: nginxBin,
    PV_RELOAD: 'true',
  };
  return {
    root,
    bucket,
    run: (...args) => {
      const r = spawnSync('sh', [SCRIPT, ...args], { env, encoding: 'utf8' });
      return { status: r.status, out: `${r.stdout}${r.stderr}` };
    },
    conf: (slug) => fs.readFileSync(path.join(root, 'conf', `${slug}.conf`), 'utf8'),
    confs: () => fs.readdirSync(path.join(root, 'conf')),
    cert: (slug) => {
      const d = path.join(root, 'live', `linkeon-${slug}`);
      fs.mkdirSync(d, { recursive: true });
      const src = (f: string) => (realNginx ? fs.readFileSync(path.join(root, f)) : 'x');
      fs.writeFileSync(path.join(d, 'fullchain.pem'), src('crt.pem'));
      fs.writeFileSync(path.join(d, 'privkey.pem'), src('key.pem'));
    },
  };
}

const count = (text: string, re: RegExp) => (text.match(new RegExp(re.source, 'g')) ?? []).length;
const LONG = `${'a'.repeat(55)}.com`; // 59 знаков: больше 46, меньше 100

(HAVE_NGINX ? describe : describe.skip)('product-vhost с настоящим nginx -t', () => {
  jest.setTimeout(30_000);

  it('без --domain — прежние два блока', () => {
    const s = sandbox(true);
    expect(s.run('shop', '8001')).toMatchObject({ status: 0 });
    const c = s.conf('shop');
    expect(count(c, /listen 80;/)).toBe(1);
    expect(count(c, /listen 443 ssl;/)).toBe(1);
    expect(c).not.toMatch(/acme-challenge/);
  });

  it('свой домен без сертификата: только порт 80 с путём Let’s Encrypt и страницей «подключается»', () => {
    const s = sandbox(true);
    expect(s.run('shop', '8001', '--domain', 'a.ru', '--domain', 'www.a.ru')).toMatchObject({ status: 0 });
    const c = s.conf('shop');
    expect(count(c, /acme-challenge/)).toBe(2);
    expect(c).toMatch(/connecting\.html/);
    expect(count(c, /listen 443 ssl;/)).toBe(1); // только основной адрес
  });

  it('с сертификатом: блок 443 у каждого имени, тот же прокси, путь для продления остаётся', () => {
    const s = sandbox(true);
    s.cert('shop');
    expect(s.run('shop', '8001', '--domain', 'a.ru', '--domain', 'www.a.ru')).toMatchObject({ status: 0 });
    const c = s.conf('shop');
    expect(count(c, /listen 443 ssl;/)).toBe(3);
    expect(c).toMatch(/server_name www\.a\.ru;[\s\S]*?ssl_certificate\s+\S*linkeon-shop\/fullchain\.pem/);
    expect(count(c, /proxy_pass http:\/\/127\.0\.0\.1:8001;/)).toBe(3);
    expect(count(c, /acme-challenge/)).toBe(2);
  });

  // Главное свойство варианта А: заглушка ложится на свой домен сама.
  it('спящий продукт: на своём домене заглушка, а не прокси', () => {
    const s = sandbox(true);
    s.cert('shop');
    expect(s.run('shop', '--asleep', '--domain', 'a.ru')).toMatchObject({ status: 0 });
    const c = s.conf('shop');
    expect(c).not.toMatch(/proxy_pass/);
    expect(count(c, /return 503;/)).toBe(2);
  });

  // Новый конфиг, не прошедший `nginx -t`, не остаётся на диске: иначе падал
  // бы `nginx -t` всей машины, и ни один продукт больше не перечитывался.
  it('красный nginx -t: прежний файл возвращается байт в байт, выход ненулевой', () => {
    const s = sandbox(true);
    expect(s.run('shop', '8001', '--domain', 'a.ru')).toMatchObject({ status: 0 });
    const before = s.conf('shop');
    expect(s.run('shop', '8001', '--domain', LONG).status).toBe(1);
    expect(s.conf('shop')).toBe(before);
  });

  it('красный nginx -t у нового продукта: файла не остаётся', () => {
    const s = sandbox(true);
    expect(s.run('fresh', '8002', '--domain', LONG).status).toBe(1);
    expect(s.confs()).toEqual([]);
  });

  // Замер, ради которого PHASE 4 ставит корзину 128: при 64 не заводится
  // даже продукт со слагом из 34 знаков (34 + «.p.linkeon.io» = 47).
  it('корзина 64 не держит слаг из 34 знаков, корзина 128 держит и его, и длинный домен', () => {
    const s = sandbox(true);
    // Хеш имён nginx строит, только когда на адресе больше одного server: с
    // одним продуктом на песочнице длинное имя прошло бы и при 64. На машине
    // продуктов всегда больше одного — сосед заводится первым.
    expect(s.run('shop', '8001')).toMatchObject({ status: 0 });
    expect(s.run('a'.repeat(34), '8003').status).toBe(1);
    s.bucket(128);
    expect(s.run('a'.repeat(40), '8003')).toMatchObject({ status: 0 });
    expect(s.run('shop', '8001', '--domain', LONG)).toMatchObject({ status: 0 });
    expect(s.run('shop', '8001', '--domain', `${'a'.repeat(48)}.${'b'.repeat(48)}.ru`)).toMatchObject({ status: 0 });
  });
});

describe('product-vhost: разбор аргументов', () => {
  it('мусор в домене — отказ до записи файла', () => {
    const s = sandbox(false);
    for (const bad of ['a..ru', '-a.ru', 'a-.ru', 'a.-ru', 'a.ru;', 'A.RU', 'nodot', '']) {
      expect({ bad, status: s.run('shop', '8001', '--domain', bad).status }).toEqual({ bad, status: 2 });
    }
    expect(s.confs()).toEqual([]);
  });

  it('имя длиннее 100 знаков — отказ, ровно 100 — нет', () => {
    const s = sandbox(false);
    const exact = `${'a'.repeat(48)}.${'b'.repeat(48)}.ru`;
    expect(s.run('shop', '8001', '--domain', `b${exact}`).status).toBe(2);
    expect(s.confs()).toEqual([]);
    expect(s.run('shop', '8001', '--domain', exact).status).toBe(0);
  });

  it('--domain без значения и непонятный хвост — отказ', () => {
    const s = sandbox(false);
    expect(s.run('shop', '8001', '--domain').status).toBe(2);
    expect(s.run('shop', '8001', '--foo', 'a.ru').status).toBe(2);
    expect(s.confs()).toEqual([]);
  });

  // Самопроверка PHASE 4 (ensure_product_vhost) требует rc=2 ровно на этом.
  it('прежние отказы на месте', () => {
    const s = sandbox(false);
    expect(s.run().status).toBe(2);
    expect(s.run('deploy-selfcheck', '--sleep').status).toBe(2);
    expect(s.run('-evil', '8001').status).toBe(2);
    expect(s.confs()).toEqual([]);
  });
});

/**
 * Два разборщика одного имени — assertDomainName в агенте и `case` в скрипте.
 * Разойдись они, агент передал бы имя, которое скрипт отбивает (rc 2 — задание
 * domain падает на каждой попытке), а мусор, который пропустил бы скрипт,
 * агент не остановил бы. Проверяется сама командная строка из vhostArgv, с
 * настоящим `nginx -t` там, где он есть: принятое имя должно и пройти проверку
 * конфига (корзина 128, как после PHASE 4).
 */
describe('vhostArgv агента и product-vhost согласны об именах', () => {
  jest.setTimeout(60_000);

  const exact = `${'a'.repeat(48)}.${'b'.repeat(48)}.ru`;
  const both: Array<[string, boolean]> = [
    ['a.ru', true],
    ['a-b.ru', true],
    ['1.ru', true],
    ['0-0.ru', true],
    ['a.b.c.d.e.ru', true],
    ['www.a.ru', true],
    ['xn--80a1acny.xn--p1ai', true], // пуникод: «--» внутри метки законен
    ['xn--d1acufc.xn--p1ai', true],
    [exact, true], // ровно MAX_DOMAIN_LENGTH
    [`b${exact}`, false], // на один знак длиннее
    ['', false],
    ['nodot', false],
    ['a..ru', false],
    ['.a.ru', false],
    ['a.ru.', false], // FQDN с точкой в конце — сервер её срезает, сюда не доходит
    ['-a.ru', false],
    ['a-.ru', false],
    ['a.-ru', false],
    ['a.ru-', false],
    ['A.RU', false],
    ['a_b.ru', false],
    ['a b.ru', false],
    ['a.ru;', false],
    ['a.ru\n', false],
    ['*.a.ru', false],
    ['пример.рф', false],
    ['a.ru/x', false],
  ];

  const agentOk = (name: string) => {
    try { assertDomainName(name); return true; } catch { return false; }
  };

  it('каждый случай: одинаковое решение, а принятое скрипт действительно пишет', () => {
    expect(exact.length).toBe(MAX_DOMAIN_LENGTH);
    const s = sandbox(HAVE_NGINX);
    s.bucket(128);
    const got = both.map(([name]) => {
      const agent = agentOk(name);
      // Строка вызова — ровно та, что строит агент; для отбитого агентом имени —
      // та же форма руками, чтобы спросить скрипт о нём же.
      const argv = agent ? vhostArgv('product-vhost', 'shop', 8001, [name]).slice(1) : ['shop', '8001', '--domain', name];
      const r = s.run(...argv);
      return { name, agent, script: r.status === 0, status: r.status };
    });
    expect(got.map(({ name, agent, script }) => ({ name, agent, script })))
      .toEqual(both.map(([name, ok]) => ({ name, agent: ok, script: ok })));
    // Отказ скрипта — именно разбор аргументов (2), а не красный nginx -t (1).
    for (const g of got) if (!g.script) expect({ name: g.name, status: g.status }).toEqual({ name: g.name, status: 2 });
  });

  // Единственное известное расхождение — в безопасную сторону: метку длиннее
  // 63 знаков (предел DNS) отбивает только агент. Скрипт её не считает, но и
  // получить её не может: агент — единственный, кто его вызывает с доменом.
  it('метка из 64 знаков: агент отбивает, скрипт пропустил бы', () => {
    const name = `${'a'.repeat(64)}.ru`;
    expect(agentOk(name)).toBe(false);
    const s = sandbox(false);
    expect(s.run('shop', '8001', '--domain', name).status).toBe(0);
  });
});
