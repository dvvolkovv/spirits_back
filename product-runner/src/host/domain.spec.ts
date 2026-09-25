/**
 * Задание своего домена против симулятора хоста — того же, что у заведения и
 * сна. Спрашивается СОСТОЯНИЕ хоста (какие имена в конфиге, есть ли
 * сертификат), а порядок команд — только там, где в порядке и есть смысл.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { HostJob } from './api';
import { HostConfig } from './config';
import { ACME_WEBROOT, DomainJob, applyDomain, certName } from './domain';
import { FakeHost, deps } from './fake-host';
import { HostDeps, runJob } from './index';

let host: FakeHost;
beforeEach(() => {
  host = new FakeHost();
});

function job(over: Partial<DomainJob> = {}): DomainJob {
  return { slug: 'shop', kind: 'site', port: 8001, customNames: ['a.ru'], vhostMode: 'proxy', ...over };
}

const vhostCalls = () => host.calls.filter((c) => c[0] === 'product-vhost');
const kinds = () =>
  host.calls.map((c) => (c[0] === 'certbot' ? `certbot ${c[1]}` : `${c[0]} ${c.slice(2).join(' ')}`));

describe('привязка своего домена', () => {
  it('конфиг с именами → certbot → снова конфиг, и сертификат выпущен', async () => {
    // Первый конфиг открывает имена по HTTP (ACME-вызов ложится в webroot),
    // второй — тот же вызов, но теперь сертификат есть, и product-vhost
    // дописывает 443. Без второго домен так и остался бы без HTTPS.
    await applyDomain(job(), deps(host));

    expect(kinds()).toEqual([
      'product-vhost 8001 --domain a.ru',
      'certbot certonly',
      'product-vhost 8001 --domain a.ru',
    ]);
    expect(host.certs.has('linkeon-shop')).toBe(true);
    expect(host.vhostDomains.get('shop')).toEqual(['a.ru']);
    expect(host.vhostMode('shop')).toBe('live');
  });

  it('certbot зовётся webroot-ом с нашим именем сертификата и всеми именами', async () => {
    await applyDomain(job({ customNames: ['a.ru', 'www.a.ru'] }), deps(host));

    const certbot = host.calls.find((c) => c[0] === 'certbot')!;
    expect(certbot).toEqual([
      'certbot', 'certonly', '--webroot', '-w', ACME_WEBROOT, '--cert-name', certName('shop'),
      '--non-interactive', '--agree-tos', '--keep-until-expiring', '--expand',
      '-d', 'a.ru', '-d', 'www.a.ru',
    ]);
  });

  it('спящему продукту имена ложатся на заглушку, а не на прокси', async () => {
    await applyDomain(job({ vhostMode: 'asleep', port: null }), deps(host));

    expect(vhostCalls()[0]).toEqual(['product-vhost', 'shop', '--asleep', '--domain', 'a.ru']);
    expect(host.vhostMode('shop')).toBe('asleep');
  });

  it('отказ certbot: конфиг откатывается БЕЗ своих имён, причина доезжает', async () => {
    // Сервер пометит заявку отказавшей; продукт обязан продолжить работать на
    // своём адресе платформы, а конфиг с чужим именем без сертификата — это
    // имя, открытое по HTTP неизвестно кому.
    host.certbotFails = 'Detail: 1.2.3.4: Invalid response from http://a.ru/.well-known/acme-challenge/x: 404';

    await expect(applyDomain(job(), deps(host))).rejects.toThrow(/Invalid response from http:\/\/a\.ru/);

    expect(host.vhostDomains.get('shop')).toEqual([]);
    expect(vhostCalls().at(-1)).toEqual(['product-vhost', 'shop', '8001']);
    expect(host.certs.size).toBe(0);
  });

  it('отказ и отката — оба факта в причине, остаток — впереди', async () => {
    host.certbotFails = 'Type: unauthorized';
    let vhosts = 0;
    host.before = (argv) => {
      if (argv[0] === 'product-vhost' && ++vhosts === 2) throw new Error('nginx: configuration file test failed');
    };

    const err: any = await applyDomain(job(), deps(host)).catch((e) => e);

    expect(err.message).toMatch(/certbot не выпустил сертификат.*unauthorized/s);
    expect(err.leftovers.join(' ')).toMatch(/a\.ru.*nginx: configuration file test failed/s);
  });
});

describe('отказ product-vhost по ходу привязки', () => {
  it('первый конфиг не встал — certbot не зовётся, отката нет, причина со своей приставкой', async () => {
    // product-vhost сам возвращает прежний конфиг байт в байт, когда `nginx -t`
    // красный (exit 1), — откатывать агенту нечего, а второй вызов поверх
    // только повторил бы тот же отказ.
    host.before = (argv) => {
      if (argv[0] === 'product-vhost') throw new Error('Command failed: product-vhost shop 8001 --domain a.ru\nnginx: [emerg] test failed');
    };

    await expect(applyDomain(job(), deps(host))).rejects.toThrow(/^конфиг своего домена не встал: .*emerg/s);

    expect(host.ran('certbot')).toHaveLength(0);
    expect(vhostCalls()).toHaveLength(1);
  });

  it('конфиг с сертификатом не встал — откат без своих имён, причина со своей приставкой', async () => {
    // Скрипт вернул бы первую версию — порт 80 со своими именами, — а сервер
    // пометит заявку отказавшей: имена остались бы жить на машине молча.
    let vhosts = 0;
    host.before = (argv) => {
      if (argv[0] === 'product-vhost' && ++vhosts === 2) throw new Error('Command failed: product-vhost\nssl emerg');
    };

    await expect(applyDomain(job(), deps(host))).rejects.toThrow(/^конфиг с сертификатом не встал: .*ssl emerg/s);

    expect(kinds()).toEqual([
      'product-vhost 8001 --domain a.ru',
      'certbot certonly',
      'product-vhost 8001 --domain a.ru',
      'product-vhost 8001',
    ]);
    expect(host.vhostDomains.get('shop')).toEqual([]);
    // Выпущенный сертификат оставлен: безвреден, а следующий выпуск его же
    // возьмёт (--cert-name, --keep-until-expiring) без лишнего похода в LE.
    expect(host.certs.has('linkeon-shop')).toBe(true);
  });

  it('и откат не встал — остаток впереди причины', async () => {
    let vhosts = 0;
    host.before = (argv) => {
      if (argv[0] === 'product-vhost' && ++vhosts >= 2) throw new Error(`отказ ${vhosts}`);
    };

    const err: any = await applyDomain(job(), deps(host)).catch((e) => e);

    expect(err.message).toMatch(/^конфиг с сертификатом не встал: отказ 2/);
    expect(err.leftovers.join(' ')).toMatch(/a\.ru.*откат конфига не удался: отказ 3/s);
  });
});

describe('мелочи привязки', () => {
  it('certbot занят плановым продлением — узнаваемая причина, откат выполнен', async () => {
    host.certbotFails = 'Command failed: certbot certonly\nAnother instance of Certbot is already running.';

    await expect(applyDomain(job(), deps(host))).rejects.toThrow(
      /^certbot занят плановым продлением — повторите через минуту/,
    );
    expect(host.vhostDomains.get('shop')).toEqual([]);
  });

  it('повторённые имена уезжают один раз, порядок сохранён', async () => {
    await applyDomain(job({ customNames: ['www.a.ru', 'a.ru', 'www.a.ru', 'a.ru'] }), deps(host));

    expect(vhostCalls()[0]).toEqual(['product-vhost', 'shop', '8001', '--domain', 'www.a.ru', '--domain', 'a.ru']);
    const certbot = host.calls.find((c) => c[0] === 'certbot')!;
    // Весь хвост после флагов, а не последние четыре: при повторах в `-d`
    // хвост из четырёх совпал бы и со строкой, где имена идут дважды.
    expect(certbot.slice(certbot.indexOf('--expand') + 1)).toEqual(['-d', 'www.a.ru', '-d', 'a.ru']);
  });
});

describe('отвязка своего домена', () => {
  it('сначала конфиг без имён, потом удаление сертификата', async () => {
    // Обратный порядок оставил бы конфиг, ссылающийся на удалённые файлы
    // сертификата: следующий `nginx -t` упал бы для ВСЕЙ машины.
    await applyDomain(job(), deps(host));
    host.calls.length = 0;

    await applyDomain(job({ customNames: [] }), deps(host));

    expect(kinds()).toEqual(['product-vhost 8001', 'certbot delete']);
    expect(host.calls[1]).toEqual(['certbot', 'delete', '--cert-name', 'linkeon-shop', '--non-interactive']);
    expect(host.certs.has('linkeon-shop')).toBe(false);
    expect(host.vhostDomains.get('shop')).toEqual([]);
  });

  it('сертификата нет — это не отказ: повтор отвязки обязан проходить', async () => {
    await expect(applyDomain(job({ customNames: [] }), deps(host))).resolves.toBeUndefined();
  });

  it('прочий отказ удаления — отказ со своим началом', async () => {
    host.before = (argv) => {
      if (argv[0] === 'certbot') throw new Error('Command failed: certbot delete\nPermission denied');
    };
    await expect(applyDomain(job({ customNames: [] }), deps(host))).rejects.toThrow(
      /^certbot не удалил сертификат linkeon-shop: .*Permission denied/s,
    );
  });

  it('отвязка у спящего — заглушка без имён', async () => {
    await applyDomain(job({ customNames: [], vhostMode: 'asleep', port: null }), deps(host));

    expect(vhostCalls()).toEqual([['product-vhost', 'shop', '--asleep']]);
  });
});

describe('отказы до единого действия', () => {
  it('у бота своего домена не бывает', async () => {
    await expect(applyDomain(job({ kind: 'bot' }), deps(host))).rejects.toThrow(/бот|форм/);
    expect(host.calls).toHaveLength(0);
  });

  it('прокси без порта — отказ про порт', async () => {
    await expect(applyDomain(job({ port: null }), deps(host))).rejects.toThrow(/порт/);
    expect(host.calls).toHaveLength(0);
  });

  it('мусорное имя — отказ до конфига и certbot', async () => {
    await expect(applyDomain(job({ customNames: ['a.ru', '-x.ru'] }), deps(host))).rejects.toThrow(/имя домена/);
    expect(host.calls).toHaveLength(0);
  });

  it('мусорный слаг — отказ', async () => {
    await expect(applyDomain(job({ slug: '-rf' }), deps(host))).rejects.toThrow(/слаг/);
    expect(host.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Причина отказа в том виде, в каком её получит сервер.
// ---------------------------------------------------------------------------

const CONFIG: HostConfig = {
  linkeonUrl: 'https://test.linkeon.io',
  hostToken: 'x'.repeat(64),
  pollIntervalMs: 3000,
  pollTimeoutMs: 10_000,
  requestTimeoutMs: 10_000,
  reportAttempts: 1,
  reportRetryMs: 0,
};

const DOMAIN_JOB: HostJob = {
  jobId: 'j-1', productId: 'p-1', slug: 'shop', kind: 'site', name: 'Магазин',
  runnerToken: '', secrets: {}, jobKind: 'domain', port: 8001, customNames: ['a.ru'], vhostMode: 'proxy',
};

function hostDepsWithRealDomain(): HostDeps {
  return {
    config: CONFIG,
    api: { poll: async () => ({ ok: true, job: null }), complete: async () => true },
    provision: async () => ({}),
    sleepProduct: async () => undefined,
    wakeProduct: async () => ({}),
    domain: (j) => applyDomain(j, deps(host)),
    sleep: async () => undefined,
    log: () => {},
  };
}

/**
 * Маркер устаревшего агента — берётся из исходника сервера, а не копией: копия
 * разошлась бы с оригиналом молча, и проверка стала бы проверять выдумку.
 */
function serverOutdatedMarker(): string {
  const src = readFileSync(join(__dirname, '../../../src/products/domain-name.ts'), 'utf8');
  const m = /export const AGENT_OUTDATED_MARKER = '([^']+)';/.exec(src);
  if (!m) throw new Error('AGENT_OUTDATED_MARKER не найден в src/products/domain-name.ts');
  return m[1];
}

describe('причина отказа задания domain', () => {
  it('никогда не начинается с маркера устаревшего агента — даже если certbot сказал ровно его', async () => {
    // Сервер по этому началу решает «агент устарел» и ВОЗВРАЩАЕТ попытку
    // выпуска. Текст certbot цитирует ответ веб-сервера пользователя, то есть
    // начало нашей причины не имеет права быть чужим текстом.
    const marker = serverOutdatedMarker();
    host.certbotFails = `${marker} provision, sleep, wake`;

    const report = await runJob(DOMAIN_JOB, hostDepsWithRealDomain());

    expect(report.ok).toBe(false);
    const error = (report as { error: string }).error;
    expect(error.startsWith(marker)).toBe(false);
    expect(error).toMatch(/^certbot не выпустил сертификат: /);
  });

  it('длинная выдача certbot: в первые 1000 знаков попадает строка Detail', async () => {
    // Сервер хранит только голову причины (DOMAIN_ERROR_MAX = 1000), а полезное
    // у certbot — в КОНЦЕ выдачи: Domain/Type/Detail/Hint после простыни.
    host.certbotFails = [
      'Command failed: certbot certonly --webroot -w /var/www/linkeon-acme -d a.ru',
      ...Array.from({ length: 60 }, (_, i) => `Saving debug log to /var/log/letsencrypt/letsencrypt.log ${i}`),
      'Certbot failed to authenticate some domains (authenticator: webroot).',
      '  Domain: a.ru',
      '  Type:   unauthorized',
      '  Detail: 1.2.3.4: Invalid response from http://a.ru/.well-known/acme-challenge/xyz: 404',
      '',
      'Hint: The Certificate Authority failed to download the temporary challenge files.',
      'Some challenges have failed.',
    ].join('\n');

    const report = await runJob(DOMAIN_JOB, hostDepsWithRealDomain());

    const head = (report as { error: string }).error.slice(0, 1000);
    expect(head).toMatch(/^certbot не выпустил сертификат: /);
    expect(head).toContain('Detail: 1.2.3.4: Invalid response from http://a.ru');
    expect(head).toContain('Type:   unauthorized');
    expect(head).toContain('Domain: a.ru');
  });

  it('без строк Domain/Type/Detail — хвост выдачи, а не голова', async () => {
    host.certbotFails = `${'шум '.repeat(1000)}ПОСЛЕДНЯЯ СТРОКА`;

    const report = await runJob(DOMAIN_JOB, hostDepsWithRealDomain());

    const error = (report as { error: string }).error;
    expect(error).toMatch(/^certbot не выпустил сертификат: /);
    expect(error.length).toBeLessThan(1000);
    expect(error.endsWith('ПОСЛЕДНЯЯ СТРОКА')).toBe(true);
  });

  it('неудавшийся откат с длинными именами не выталкивает Detail за голову в 1000 знаков', async () => {
    const long1 = `${'a'.repeat(48)}.${'b'.repeat(48)}.ru`;
    const long2 = `${'c'.repeat(48)}.${'d'.repeat(48)}.ru`;
    const detail = `Detail: 1.2.3.4: Invalid response from http://${long1}/.well-known/acme-challenge/${'x'.repeat(43)}: 404: \"<html><head><title>404 Not Found</title></head><body>${'<p>страница не найдена</p>'.repeat(10)}\"`;
    host.certbotFails = [
      ...Array.from({ length: 40 }, (_, i) => `шум ${i} `.repeat(10)),
      `  Domain: ${long1}`,
      '  Type:   unauthorized',
      detail,
      `Hint: ${'подсказка '.repeat(20)}`,
    ].join('\n');
    let vhosts = 0;
    host.before = (argv) => {
      if (argv[0] === 'product-vhost' && ++vhosts === 2) throw new Error(`nginx -t: ${'ошибка '.repeat(200)}`);
    };

    const report = await runJob({ ...DOMAIN_JOB, customNames: [long1, long2] }, hostDepsWithRealDomain());

    const head = (report as { error: string }).error.slice(0, 1000);
    expect(head).toMatch(/^НА ХОСТЕ ОСТАЛОСЬ: /);
    // Строка Detail — ЦЕЛИКОМ: обрезанная на полуслове, она теряет ровно ту
    // часть (что ответил сервер пользователя), ради которой её несли.
    expect(head).toContain(detail);
    expect(head).toContain('certbot не выпустил сертификат: ');
  });

  it('при неудавшемся откате причина начинается с остатка, а не с текста certbot', async () => {
    host.certbotFails = 'маркер-от-чужого-сервера';
    let vhosts = 0;
    host.before = (argv) => {
      if (argv[0] === 'product-vhost' && ++vhosts === 2) throw new Error('nginx -t failed');
    };

    const report = await runJob(DOMAIN_JOB, hostDepsWithRealDomain());

    expect((report as { error: string }).error).toMatch(/^НА ХОСТЕ ОСТАЛОСЬ: /);
  });
});
