/**
 * Смена ключей против симулятора хоста. Спрашивается СОСТОЯНИЕ хоста (какой
 * контейнер жив, с каким окружением, на каком образе и порту), а не форма
 * команд — см. шапку sleep.spec.ts.
 */
import { FakeHost, OAUTH, deps } from './fake-host';
import { ProvisionDeps, provision } from './provision';
import { HEALTH_INSIDE, REKEY_BACKUP_SUFFIX, capture, rekeyProduct, RekeyJob, runArgv } from './rekey';

let host: FakeHost;
beforeEach(() => {
  host = new FakeHost();
});

async function seedBot(slug = 'bot1', secrets: Record<string, string> = { BOT_TOKEN: 'old', API_KEY: 'k1' }) {
  await provision({ slug, kind: 'bot', name: 'Бот', runnerToken: 'ткн-раннера', secrets }, deps(host));
}
async function seedSite(slug = 'shop', secrets: Record<string, string> = { API_KEY: 'k1' }) {
  return (await provision({ slug, kind: 'site', name: 'Сайт', runnerToken: 'ткн-раннера', secrets }, deps(host))).port!;
}
const botJob = (over: Partial<RekeyJob> = {}): RekeyJob => ({
  slug: 'bot1', kind: 'bot', secrets: { BOT_TOKEN: 'new', NEW_KEY: 'n' }, dropNames: ['API_KEY'], ...over,
});
/** Сроки и паузы — ноль: отказ не ждёт минуту, повторная проверка — три секунды. */
const fast = (over: Partial<ProvisionDeps> = {}) => deps(host, { waitPortTimeoutMs: 0, settleMs: 0, ...over });
/** Сайт «отвечает» ровно тогда, когда симулятор считает его здоровым. */
const siteDeps = (over: Partial<ProvisionDeps> = {}) => fast({ waitPort: async (p) => host.probePort(p), ...over });

describe('смена ключей: успех', () => {
  it('бот: новые ключи в окружении, снятые ушли, переменные платформы на месте', async () => {
    await seedBot();
    await rekeyProduct(botJob(), fast());

    const c = host.containers.get('bot1')!;
    expect(c.env.BOT_TOKEN).toBe('new');
    expect(c.env.NEW_KEY).toBe('n');
    expect('API_KEY' in c.env).toBe(false);
    expect(c.env.RUNNER_TOKEN).toBe('ткн-раннера');
    expect(c.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(OAUTH);
    expect(c.env.LINKEON_URL).toBeTruthy();
    expect(c.mount).toBe('/srv/products/bot1:/product');
    expect(host.isRunning('bot1')).toBe(true);
    expect(host.containers.has(`bot1${REKEY_BACKUP_SUFFIX}`)).toBe(false);
  });

  it('лимиты и политика перезапуска — те же, что дало заведение', async () => {
    // Снимаются с живого контейнера и уходят в docker run заново: потерянный
    // --memory оставил бы продукт без потолка памяти на общем хосте, а
    // потерянный --restart — лежащим после первой же перезагрузки машины.
    await seedBot();
    const before = { ...host.containers.get('bot1')! };
    await rekeyProduct(botJob(), fast());

    const c = host.containers.get('bot1')!;
    expect(c.memory).toBe(1024 ** 3);
    expect(c.memory).toBe(before.memory);
    expect(c.cpus).toBe(1e9);
    expect(c.cpus).toBe(before.cpus);
    expect(c.restart).toBe('unless-stopped');
    expect(c.cmd).toEqual([]);
  });

  it('сайт: тот же порт, домен не трогается вовсе', async () => {
    const port = await seedSite();
    const vhostCalls = host.ran('product-vhost').length;
    await rekeyProduct({ slug: 'shop', kind: 'site', secrets: { API_KEY: 'k2' }, dropNames: [] }, siteDeps());

    expect(host.containers.get('shop')!.publish).toBe(`127.0.0.1:${port}:3000`);
    expect(host.containers.get('shop')!.env.API_KEY).toBe('k2');
    expect(host.vhostMode('shop')).toBe('live');
    expect(host.ran('product-vhost').length).toBe(vhostCalls);
  });

  it('переменные, о которых сервер не знает, остаются как были', async () => {
    // У продуктов, заведённых руками (product-provision.sh), в окружении бывает
    // то, чего нет в зашифрованном наборе. Снимать их нельзя: сервер о них не
    // знает и вернуть не сможет.
    await seedBot();
    host.containers.get('bot1')!.env.HAND_MADE = '1';
    await rekeyProduct(botJob(), fast());
    expect(host.containers.get('bot1')!.env.HAND_MADE).toBe('1');
  });

  it('OWNER_TG_ID из задания ставится боту рядом с ключами', async () => {
    await seedBot();
    await rekeyProduct(botJob({ ownerTgId: '42' }), fast());
    expect(host.containers.get('bot1')!.env.OWNER_TG_ID).toBe('42');
  });

  it('сайту OWNER_TG_ID не ставится и при смене ключей', async () => {
    await seedSite();
    await rekeyProduct({ slug: 'shop', kind: 'site', secrets: {}, dropNames: [], ownerTgId: '42' }, siteDeps());
    expect('OWNER_TG_ID' in host.containers.get('shop')!.env).toBe(false);
  });

  it('метка образа на месте — запуск по ней же: контейнер остаётся в отборе обновления образа', async () => {
    host.tagImage('linkeon-product:base', 'sha256:v1', []);
    await seedBot();
    await rekeyProduct(botJob(), fast());
    expect(host.containers.get('bot1')!.image).toBe('linkeon-product:base');
    expect(host.containers.get('bot1')!.imageId).toBe('sha256:v1');
  });

  it('метку передвинули — тот же образ по его стабильной метке, а не новый образ', async () => {
    host.tagImage('linkeon-product:base', 'sha256:v1', []);
    host.tagImage('linkeon-product:src-aaaaaaaaaaaa', 'sha256:v1', []);
    await seedBot();
    host.tagImage('linkeon-product:base', 'sha256:v2', []);
    await rekeyProduct(botJob(), fast());
    expect(host.containers.get('bot1')!.imageId).toBe('sha256:v1');
    expect(host.containers.get('bot1')!.image).toBe('linkeon-product:src-aaaaaaaaaaaa');
  });
});

describe('смена ключей: откат и отказы', () => {
  it('нездоровый бот — откат: старый контейнер со старыми ключами в работе', async () => {
    await seedBot();
    host.healthy = (_name, c) => c.env.BOT_TOKEN !== 'плохой';
    await expect(rekeyProduct(botJob({ secrets: { BOT_TOKEN: 'плохой' } }), fast()))
      .rejects.toThrow(/ключи не применены.*старыми ключами/);
    const c = host.containers.get('bot1')!;
    expect(c.env.BOT_TOKEN).toBe('old');
    expect(c.env.API_KEY).toBe('k1');
    expect(host.isRunning('bot1')).toBe(true);
    expect(host.containers.has(`bot1${REKEY_BACKUP_SUFFIX}`)).toBe(false);
  });

  it('нездоровый сайт — откат, порт и домен прежние', async () => {
    const port = await seedSite();
    host.healthy = (_name, c) => c.env.API_KEY !== 'плохой';
    await expect(rekeyProduct({ slug: 'shop', kind: 'site', secrets: { API_KEY: 'плохой' }, dropNames: [] }, siteDeps()))
      .rejects.toThrow(/ключи не применены/);
    expect(host.containers.get('shop')!.env.API_KEY).toBe('k1');
    expect(host.isRunning('shop')).toBe(true);
    expect(host.probePort(port)).toBe(true);
    expect(host.vhostMode('shop')).toBe('live');
  });

  it('сайт отвечает изнутри, но не на опубликованном порту — откат', async () => {
    // Изнутри здоров, а домен смотрел бы в пустоту: правило сайта — оба
    // ответа, а не любой из них.
    const port = await seedSite();
    await expect(
      rekeyProduct(
        { slug: 'shop', kind: 'site', secrets: { API_KEY: 'k2' }, dropNames: [] },
        siteDeps({ waitPort: async () => false }),
      ),
    ).rejects.toThrow(/ключи не применены/);
    expect(host.containers.get('shop')!.env.API_KEY).toBe('k1');
    expect(host.probePort(port)).toBe(true);
  });

  it('docker run отказал — откат, и в причине нет значений ключей', async () => {
    await seedBot();
    host.before = (argv) => {
      if (argv[1] === 'run' && argv.includes('BOT_TOKEN=секрет-новый')) {
        throw new Error(`Command failed: ${argv.join(' ')}\ndocker: Error response from daemon: boom`);
      }
    };
    const err = await rekeyProduct(botJob({ secrets: { BOT_TOKEN: 'секрет-новый' } }), fast())
      .catch((e) => e);
    expect(String(err.message)).toMatch(/boom/);
    expect(String(err.message)).not.toContain('секрет-новый');
    expect(String(err.message)).not.toContain('ткн-раннера');
    expect(host.containers.get('bot1')!.env.BOT_TOKEN).toBe('old');
    expect(host.isRunning('bot1')).toBe(true);
  });

  it('docker run создал контейнер и отказал — новый снят, старый со старыми ключами в работе', async () => {
    // Так отказывает публикация порта: контейнер создан, а не стартовал. Под
    // именем продукта лежит НОВЫЙ контейнер — снимать надо его, а не старый.
    await seedBot();
    host.after = (argv) => {
      if (argv[1] === 'run' && argv.includes('BOT_TOKEN=new')) {
        throw new Error(`Command failed: ${argv.join(' ')}\ndocker: Error response from daemon: driver failed`);
      }
    };
    await expect(rekeyProduct(botJob(), fast())).rejects.toThrow(/старыми ключами/);
    expect(host.containers.get('bot1')!.env.BOT_TOKEN).toBe('old');
    expect(host.containers.get('bot1')!.env.RUNNER_TOKEN).toBe('ткн-раннера');
    expect(host.isRunning('bot1')).toBe(true);
    expect(host.containers.has(`bot1${REKEY_BACKUP_SUFFIX}`)).toBe(false);
  });

  it('многострочное значение в окружении не выносит в причину хвост командной строки', async () => {
    // execFile пишет «Command failed: <argv через пробел>\n<stderr>». Перевод
    // строки внутри значения (приватный ключ PEM) — НЕ конец argv: резать по
    // первому переводу строки значило бы выдать остаток командной строки.
    await seedBot();
    host.containers.get('bot1')!.env.HAND_PEM = 'начало-ключа\nхвост-ключа';
    host.before = (argv) => {
      if (argv[1] === 'run' && argv.includes('BOT_TOKEN=секрет-новый')) {
        throw new Error(`Command failed: ${argv.join(' ')}\ndocker: Error response from daemon: boom`);
      }
    };
    const err = await rekeyProduct(botJob({ secrets: { BOT_TOKEN: 'секрет-новый' } }), fast())
      .catch((e) => e);
    expect(String(err.message)).toMatch(/boom/);
    expect(String(err.message)).not.toContain('хвост-ключа');
    expect(String(err.message)).not.toContain('секрет-новый');
    expect(String(err.message)).not.toContain(OAUTH);
    expect(host.containers.get('bot1')!.env.HAND_PEM).toBe('начало-ключа\nхвост-ключа');
  });

  it('docker rename отказал — старый контейнер снова в работе, остатков нет', async () => {
    await seedBot();
    host.before = (argv) => {
      if (argv[1] === 'rename' && argv[2] === 'bot1') throw new Error('Command failed: docker rename bot1 bot1__rekey\nboom-rename');
    };
    await expect(rekeyProduct(botJob(), fast())).rejects.toThrow(/ключи не применены.*старыми ключами/);
    expect(host.isRunning('bot1')).toBe(true);
    expect(host.containers.get('bot1')!.env.BOT_TOKEN).toBe('old');
    expect(host.containers.has(`bot1${REKEY_BACKUP_SUFFIX}`)).toBe(false);
  });

  it('docker rename отказал, уже переименовав, — старый получает имя обратно и в работе', async () => {
    // Снятый по сроку шаг мог успеть сделать своё. Где старый контейнер,
    // решает состояние хоста, а не то, что ответила команда.
    await seedBot();
    host.after = (argv) => {
      if (argv[1] === 'rename' && argv[2] === 'bot1') throw new Error('docker не уложился в 300 с и снят по сроку: Command failed: docker rename bot1 bot1__rekey\n');
    };
    await expect(rekeyProduct(botJob(), fast())).rejects.toThrow(/старыми ключами/);
    expect(host.isRunning('bot1')).toBe(true);
    expect(host.containers.get('bot1')!.env.BOT_TOKEN).toBe('old');
    expect(host.containers.has(`bot1${REKEY_BACKUP_SUFFIX}`)).toBe(false);
  });

  it('откат не удался — отказ называет это и перечисляет остатки', async () => {
    await seedBot();
    host.healthy = (_name, c) => c.env.BOT_TOKEN !== 'плохой';
    host.before = (argv) => {
      if (argv[1] === 'rename' && argv[2] === `bot1${REKEY_BACKUP_SUFFIX}`) throw new Error('Command failed: docker rename\nboom');
    };
    const err = await rekeyProduct(botJob({ secrets: { BOT_TOKEN: 'плохой' } }), fast())
      .catch((e) => e);
    expect(String(err.message)).toMatch(/ключи не применены.*откат не удался/);
    expect(err.leftovers.join(' ')).toContain(`bot1${REKEY_BACKUP_SUFFIX}`);
    // Старый контейнер не удалён: в нём единственная копия RUNNER_TOKEN.
    expect(host.containers.get(`bot1${REKEY_BACKUP_SUFFIX}`)!.env.RUNNER_TOKEN).toBe('ткн-раннера');
  });

  it('остаток прерванной смены — отказ до любого изменения', async () => {
    await seedBot();
    await host.run(['docker', 'run', '-d', '--name', `bot1${REKEY_BACKUP_SUFFIX}`, '--restart', 'unless-stopped', 'linkeon-product:base']);
    host.calls.length = 0;
    await expect(rekeyProduct(botJob(), deps(host))).rejects.toThrow(/прерванной смены ключей/);
    expect(host.calls.some((c) => c[1] === 'stop' || c[1] === 'rename' || c[1] === 'run')).toBe(false);
  });

  it('спящему продукту ключи не меняются', async () => {
    await seedBot();
    await host.run(['docker', 'stop', 'bot1']);
    await expect(rekeyProduct(botJob(), deps(host))).rejects.toThrow(/не запущен \(спит или прервана прошлая смена ключей\)/);
    expect(host.containers.get('bot1')!.env.BOT_TOKEN).toBe('old');
  });

  it('метки того же образа нет — отказ до изменений', async () => {
    host.tagImage('linkeon-product:base', 'sha256:v1', []);
    await seedBot();
    host.tagImage('linkeon-product:base', 'sha256:v2', []);
    await expect(rekeyProduct(botJob(), deps(host))).rejects.toThrow(/не помечен/);
    expect(host.isRunning('bot1')).toBe(true);
    expect(host.containers.get('bot1')!.env.BOT_TOKEN).toBe('old');
  });

  it('без RUNNER_TOKEN в окружении — отказ до изменений: пересоздание потеряло бы раннер', async () => {
    await host.run(['docker', 'run', '-d', '--name', 'bot1', '--restart', 'unless-stopped', '-e', 'LINKEON_URL=https://x', 'linkeon-product:base']);
    await expect(rekeyProduct(botJob(), deps(host))).rejects.toThrow(/RUNNER_TOKEN/);
    expect(host.calls.some((c) => c[1] === 'stop')).toBe(false);
  });

  it('занятое имя в новом наборе или в снимаемых — отказ до изменений', async () => {
    await seedBot();
    await expect(rekeyProduct(botJob({ secrets: { BOT_TOKEN: 'n', RUNNER_TOKEN: 'подмена' } }), deps(host))).rejects.toThrow(/занято/);
    await expect(rekeyProduct(botJob({ dropNames: ['LINKEON_URL'] }), deps(host))).rejects.toThrow(/платформы/);
    expect(host.containers.get('bot1')!.env.RUNNER_TOKEN).toBe('ткн-раннера');
  });

  it('бот без BOT_TOKEN в новом наборе — отказ', async () => {
    await seedBot();
    await expect(rekeyProduct(botJob({ secrets: { NEW_KEY: 'n' } }), deps(host))).rejects.toThrow(/BOT_TOKEN/);
  });

  it('слаг не по форме — отказ до первого вызова docker', async () => {
    await expect(rekeyProduct(botJob({ slug: '../x' }), deps(host))).rejects.toThrow(/слаг/);
    expect(host.calls).toHaveLength(0);
  });

  it('OWNER_TG_ID пустой строкой — владелец отвязал Telegram: переменная снимается', async () => {
    await seedBot();
    host.containers.get('bot1')!.env.OWNER_TG_ID = '42';
    await rekeyProduct(botJob({ ownerTgId: '' }), fast());
    expect('OWNER_TG_ID' in host.containers.get('bot1')!.env).toBe(false);
  });

  it('OWNER_TG_ID не пришёл вовсе — переменная остаётся как была', async () => {
    await seedBot();
    host.containers.get('bot1')!.env.OWNER_TG_ID = '42';
    await rekeyProduct(botJob(), fast());
    expect(host.containers.get('bot1')!.env.OWNER_TG_ID).toBe('42');
  });

  it('OWNER_TG_ID не число — отказ до изменений', async () => {
    await seedBot();
    await expect(rekeyProduct(botJob({ ownerTgId: '12 -e X=1' }), deps(host))).rejects.toThrow(/OWNER_TG_ID/);
    expect(host.calls.some((c) => c[1] === 'stop')).toBe(false);
  });

  it('шаг, снятый по сроку, не выносит в причину командную строку с ключами', async () => {
    await seedBot();
    host.before = (argv) => {
      if (argv[1] === 'run' && argv.includes('BOT_TOKEN=секрет-срок')) {
        throw new Error(`docker не уложился в 300 с и снят по сроку: Command failed: ${argv.join(' ')}\n`);
      }
    };
    const err = await rekeyProduct(botJob({ secrets: { BOT_TOKEN: 'секрет-срок' } }), fast()).catch((e) => e);
    expect(String(err.message)).toMatch(/снят по сроку/);
    expect(String(err.message)).not.toContain('секрет-срок');
    expect(String(err.message)).not.toContain('ткн-раннера');
  });
});

describe('смена ключей: образ и окружение образа', () => {
  it('переменные образа не уходят флагом -e: новый берёт их из образа, своё поверх образа сохраняется', async () => {
    host.tagImage('linkeon-product:base', 'sha256:v1', ['CHECKOUT_PATH=/product', 'TZ=UTC']);
    await seedBot();
    host.containers.get('bot1')!.env.TZ = 'Europe/Moscow';
    await rekeyProduct(botJob(), fast());

    const c = host.containers.get('bot1')!;
    expect('CHECKOUT_PATH' in c.env).toBe(false);
    expect(c.env.TZ).toBe('Europe/Moscow');
    const j = JSON.parse(await host.run(['docker', 'inspect', '--format', '{{json .}}', 'bot1']));
    expect(j.Config.Env).toContain('CHECKOUT_PATH=/product');
    expect(j.Config.Env).not.toContain('TZ=UTC');
  });

  it('запущен не по метке linkeon-product (чужая метка того же образа) — по стабильной: продукт возвращается в отбор обновления образа', async () => {
    host.tagImage('linkeon-product:base', 'sha256:v1', []);
    host.tagImage('linkeon-product:src-bbbbbbbbbbbb', 'sha256:v1', []);
    host.tagImage('mirror/linkeon:1', 'sha256:v1', []);
    await seedBot();
    host.containers.get('bot1')!.image = 'mirror/linkeon:1';
    await rekeyProduct(botJob(), fast());
    expect(host.containers.get('bot1')!.image).toBe('linkeon-product:src-bbbbbbbbbbbb');
    expect(host.containers.get('bot1')!.imageId).toBe('sha256:v1');
  });

  it('запущен по идентификатору, стабильной метки нет — отказ до изменений', async () => {
    host.tagImage('linkeon-product:base', 'sha256:v1', []);
    await seedBot();
    host.containers.get('bot1')!.image = 'sha256:v1';
    host.calls.length = 0;
    await expect(rekeyProduct(botJob(), fast())).rejects.toThrow(/не помечен/);
    expect(host.calls.some((c) => ['stop', 'rename', 'run', 'rm'].includes(c[1]))).toBe(false);
  });

  it('метку передвинули между снятием настроек и запуском — новый на чужом образе снят, старый в работе', async () => {
    // Как verify_image в product-image-roll.sh: метка — не идентификатор, и
    // обновление образа может передвинуть её в любой момент.
    host.tagImage('linkeon-product:base', 'sha256:v1', []);
    await seedBot();
    host.before = (argv) => {
      if (argv[1] === 'run' && argv.includes('BOT_TOKEN=new')) host.tagImage('linkeon-product:base', 'sha256:v2', []);
    };
    await expect(rekeyProduct(botJob(), fast())).rejects.toThrow(/ключи не применены.*образ/);
    const c = host.containers.get('bot1')!;
    expect(c.imageId).toBe('sha256:v1');
    expect(c.env.BOT_TOKEN).toBe('old');
    expect(host.isRunning('bot1')).toBe(true);
    expect(host.containers.has(`bot1${REKEY_BACKUP_SUFFIX}`)).toBe(false);
  });

  it('контейнер спрашивается как контейнер: каждый inspect смены ключей — с --type container', async () => {
    // Без --type живой docker при отсутствии контейнера отдал бы образ с тем
    // же именем — и разбор пошёл бы по чужому объекту.
    await seedBot();
    host.calls.length = 0;
    await rekeyProduct(botJob(), fast());
    const inspects = host.calls.filter((c) => c[0] === 'docker' && c[1] === 'inspect');
    expect(inspects.length).toBeGreaterThan(0);
    expect(inspects.every((c) => c[2] === '--type' && c[3] === 'container')).toBe(true);
  });
});

describe('смена ключей: здоровье — два ответа через паузу', () => {
  it('ответил один раз и упал — откат', async () => {
    // Ключ, который код владельца читает лениво (на первом запросе к его
    // API), валит процесс уже ПОСЛЕ первого ответа /health.
    await seedBot();
    let answers = 0;
    host.healthy = (_name, c) => c.env.BOT_TOKEN !== 'new' || answers++ === 0;
    await expect(rekeyProduct(botJob(), fast())).rejects.toThrow(/ключи не применены.*старыми ключами/);
    expect(host.containers.get('bot1')!.env.BOT_TOKEN).toBe('old');
    expect(host.isRunning('bot1')).toBe(true);
    expect(host.containers.has(`bot1${REKEY_BACKUP_SUFFIX}`)).toBe(false);
  });
});

describe('смена ключей: откат — каждая ветка', () => {
  it('старый поднялся после отката и тут же упал — «откат не удался», остаток назван', async () => {
    // `docker start` отвечает 0, как только процесс запущен; упавший через
    // секунду — тоже. Как do_restore product-image-roll.sh: пауза и состояние.
    await seedBot();
    host.healthy = (_name, c) => c.env.BOT_TOKEN !== 'плохой';
    host.after = (argv) => {
      if (argv[1] === 'start' && argv[2] === 'bot1') host.crashing = (name) => name === 'bot1';
    };
    const err = await rekeyProduct(botJob({ secrets: { BOT_TOKEN: 'плохой' } }), fast()).catch((e) => e);
    expect(String(err.message)).toMatch(/ключи не применены.*откат не удался/);
    expect(err.leftovers.join(' ')).toMatch(/старый контейнер не поднялся после отката/);
    expect(host.containers.get('bot1')!.env.BOT_TOKEN).toBe('old');
  });

  it('docker stop отказал, уже остановив, — продукт снова в работе со старыми ключами', async () => {
    await seedBot();
    host.after = (argv) => {
      if (argv[1] === 'stop' && argv[2] === 'bot1') {
        throw new Error('docker не уложился в 300 с и снят по сроку: Command failed: docker stop bot1\n');
      }
    };
    await expect(rekeyProduct(botJob(), fast())).rejects.toThrow(/ключи не применены.*старыми ключами/);
    expect(host.isRunning('bot1')).toBe(true);
    expect(host.containers.get('bot1')!.env.BOT_TOKEN).toBe('old');
    expect(host.containers.has(`bot1${REKEY_BACKUP_SUFFIX}`)).toBe(false);
  });

  it('в откате не снялся новый контейнер — остаток назван, старый цел под резервным именем', async () => {
    await seedBot();
    host.healthy = (_name, c) => c.env.BOT_TOKEN !== 'плохой';
    host.before = (argv) => {
      if (argv[1] === 'rm' && argv[3] === 'bot1') throw new Error('Command failed: docker rm -f bot1\nError: device or resource busy');
    };
    const err = await rekeyProduct(botJob({ secrets: { BOT_TOKEN: 'плохой' } }), fast()).catch((e) => e);
    expect(String(err.message)).toMatch(/откат не удался/);
    expect(err.leftovers.join(' ')).toMatch(/новый контейнер bot1 не снят \(Error: device or resource busy\).*bot1__rekey/);
    expect(host.containers.get(`bot1${REKEY_BACKUP_SUFFIX}`)!.env.RUNNER_TOKEN).toBe('ткн-раннера');
  });

  it('в откате старый не стартовал — остаток назван', async () => {
    await seedBot();
    host.healthy = (_name, c) => c.env.BOT_TOKEN !== 'плохой';
    host.before = (argv) => {
      if (argv[1] === 'start' && argv[2] === 'bot1') throw new Error('Command failed: docker start bot1\nError: port is already allocated');
    };
    const err = await rekeyProduct(botJob({ secrets: { BOT_TOKEN: 'плохой' } }), fast()).catch((e) => e);
    expect(String(err.message)).toMatch(/откат не удался/);
    expect(err.leftovers.join(' ')).toMatch(/старый контейнер bot1 не поднялся \(Error: port is already allocated\)/);
    expect(host.containers.get('bot1')!.env.BOT_TOKEN).toBe('old');
  });
});

describe('смена ключей: старый контейнер после успеха', () => {
  const rmBackup = (c: string[]) => c[1] === 'rm' && c[3] === `bot1${REKEY_BACKUP_SUFFIX}`;

  it('не убрался с первого раза — убирается второй попыткой', async () => {
    await seedBot();
    let fails = 1;
    host.before = (argv) => {
      if (rmBackup(argv) && fails-- > 0) throw new Error('Command failed: docker rm -f bot1__rekey\nError: removal in progress');
    };
    await rekeyProduct(botJob(), fast());
    expect(host.containers.get('bot1')!.env.BOT_TOKEN).toBe('new');
    expect(host.containers.has(`bot1${REKEY_BACKUP_SUFFIX}`)).toBe(false);
  });

  it('не убрался и со второго — смена удалась, а фаза громко называет остаток', async () => {
    await seedBot();
    host.before = (argv) => {
      if (rmBackup(argv)) throw new Error('Command failed: docker rm -f bot1__rekey\nError: removal in progress');
    };
    const phases: string[] = [];
    await rekeyProduct(botJob(), fast({ onPhase: (m) => phases.push(m) }));
    expect(host.containers.get('bot1')!.env.BOT_TOKEN).toBe('new');
    expect(host.containers.has(`bot1${REKEY_BACKUP_SUFFIX}`)).toBe(true);
    expect(host.calls.filter(rmBackup)).toHaveLength(2);
    expect(phases.join('\n')).toMatch(/ВНИМАНИЕ.*bot1__rekey.*не убран.*removal in progress/);
  });
});

describe('снятие настроек и сборка docker run — по рукописному inspect', () => {
  const IMG = 'sha256:img';
  const image = { Id: IMG, RepoTags: ['linkeon-product:base'], Config: { Env: ['PATH=/usr/bin'] } };
  const siteJob: RekeyJob = { slug: 'shop', kind: 'site', secrets: { API_KEY: 'k2' }, dropNames: [] };

  function container(): any {
    return {
      Image: IMG,
      Config: {
        Image: 'linkeon-product:base',
        Env: ['API_KEY=k1', 'LINKEON_URL=https://my.linkeon.io', 'RUNNER_TOKEN=т', 'PATH=/usr/bin'],
      },
      State: { Running: true, Restarting: false, Status: 'running' },
      HostConfig: {
        PortBindings: { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '8005' }] },
        Memory: 1024 ** 3,
        NanoCpus: 1e9,
        RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
        NetworkMode: 'bridge',
        Privileged: false,
      },
      Mounts: [{ Type: 'bind', Source: '/srv/products/shop', Destination: '/product', RW: true }],
    };
  }

  /** run, который отвечает только на чтение; любое изменение хоста — отказ (и след в calls). */
  function stub(c: any) {
    const calls: string[][] = [];
    const run = async (argv: string[]) => {
      calls.push(argv);
      if (argv[1] === 'ps') return '\n';
      if (argv[1] === 'inspect') return `${JSON.stringify(c)}\n`;
      if (argv[1] === 'image') {
        const ref = argv[argv.length - 1];
        if (ref !== IMG && ref !== 'linkeon-product:base') throw new Error(`Error: No such image: ${ref}`);
        return `${JSON.stringify(image)}\n`;
      }
      throw new Error(`заглушка: изменение хоста ${argv.slice(0, 2).join(' ')}`);
    };
    return { calls, d: deps(host, { run, waitPortTimeoutMs: 0, settleMs: 0 }) };
  }
  const onlyReads = (calls: string[][]) => calls.every((c) => ['ps', 'inspect', 'image'].includes(c[1]));
  const after = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1];

  it('форма заведения: --restart, -v, -p IP:ПОРТ:ПОРТ, -e, --memory=1g, --cpus=1, метка последней', async () => {
    expect(runArgv('shop', await capture(siteJob, stub(container()).d), ['A=1'])).toEqual([
      'docker', 'run', '-d', '--name', 'shop', '--restart', 'unless-stopped', '-v', '/srv/products/shop:/product',
      '-p', '127.0.0.1:8005:3000', '-e', 'A=1', '--memory=1g', '--cpus=1', 'linkeon-product:base',
    ]);
  });

  it('свои переменные — без переменных образа', async () => {
    expect((await capture(siteJob, stub(container()).d)).ownEnv).toEqual([
      'API_KEY=k1', 'LINKEON_URL=https://my.linkeon.io', 'RUNNER_TOKEN=т',
    ]);
  });

  it('on-failure:N, память не кратная гигабайту, дробные CPU, монтирование только для чтения', async () => {
    const c = container();
    c.HostConfig.RestartPolicy = { Name: 'on-failure', MaximumRetryCount: 5 };
    c.HostConfig.Memory = 1536 * 1024 ** 2;
    c.HostConfig.NanoCpus = 1.5e9;
    c.Mounts[0].RW = false;
    const argv = runArgv('shop', await capture(siteJob, stub(c).d), []);
    expect(after(argv, '--restart')).toBe('on-failure:5');
    expect(argv).toContain('--memory=1536m');
    expect(argv).toContain('--cpus=1.5');
    expect(after(argv, '-v')).toBe('/srv/products/shop:/product:ro');

    // Ни на одну единицу нацело не делится — байтами, без округления.
    c.HostConfig.Memory = 1_000_000_000;
    expect(runArgv('shop', await capture(siteJob, stub(c).d), [])).toContain('--memory=1000000000');
  });

  it.each<[string, (c: any) => void, RegExp]>([
    ['IPv6 в адресе публикации', (c) => { c.HostConfig.PortBindings['3000/tcp'][0].HostIp = '::1'; }, /публикацию/],
    ['запись окружения без «=»', (c) => { c.Config.Env.push('LONELY'); }, /переменную окружения/],
    ['дробный лимит памяти', (c) => { c.HostConfig.Memory = 1.5; }, /лимит памяти/],
    ['отрицательный лимит памяти', (c) => { c.HostConfig.Memory = -1; }, /лимит памяти/],
    ['лимит CPU не число', (c) => { c.HostConfig.NanoCpus = 'много'; }, /лимит CPU/],
    ['двоеточие в пути каталога на хосте', (c) => { c.Mounts[0].Source = '/srv/products/a:b'; }, /монтирование/],
    ['двоеточие в пути внутри контейнера', (c) => { c.Mounts[0].Destination = '/product:x'; }, /монтирование/],
    ['том вместо привязки каталога', (c) => { c.Mounts.push({ Type: 'volume', Name: 'x', Destination: '/data' }); }, /монтирование/],
  ])('%s — отказ до любого изменения', async (_label, spoil, re) => {
    const c = container();
    spoil(c);
    const { d, calls } = stub(c);
    await expect(rekeyProduct(siteJob, d)).rejects.toThrow(re);
    expect(onlyReads(calls)).toBe(true);
  });
});

describe('здоровье изнутри контейнера — правило checkHealth раннера', () => {
  // Симулятор скрипт только компилирует, а правило моделирует своим
  // `healthy`. Само правило — здесь: скрипт исполняется с подменёнными fetch
  // и process.exit, код выхода 0 — «здоров».
  type Seen = { code: number; url?: string; init?: any };
  function runScript(answer: () => Promise<Response>): Promise<Seen> {
    return new Promise((resolve) => {
      let url: string | undefined;
      let init: any;
      const fetchStub = (u: string, i: any) => {
        url = u;
        init = i;
        return answer();
      };
      const processStub = { exit: (code: number) => resolve({ code, url, init }) };
      new Function('fetch', 'process', HEALTH_INSIDE)(fetchStub, processStub);
    });
  }
  const reply = (body: string | null, status = 200, contentType = 'application/json') => async () =>
    new Response(body, { status, headers: contentType ? { 'content-type': contentType } : {} });

  it('2xx, JSON с непустым sha — здоров; спрашивается /health на порту контейнера без перехода по редиректу', async () => {
    const seen = await runScript(reply(JSON.stringify({ ok: true, sha: 'abc123' })));
    expect(seen.code).toBe(0);
    expect(seen.url).toBe('http://127.0.0.1:3000/health');
    expect(seen.init.redirect).toBe('manual');
  });

  it.each<[string, () => Promise<Response>]>([
    ['не 2xx', reply(JSON.stringify({ sha: 'abc' }), 502)],
    ['редирект', reply(JSON.stringify({ sha: 'abc' }), 302)],
    ['text/html по заголовку при JSON в теле', reply(JSON.stringify({ sha: 'abc' }), 200, 'text/html; charset=utf-8')],
    ['HTML в теле без заголовка', reply('<!DOCTYPE html><html>{"sha":"abc"}</html>', 200, '')],
    ['JSON без sha', reply(JSON.stringify({ ok: true }))],
    ['sha пустой строкой', reply(JSON.stringify({ sha: '' }))],
    ['sha не строка', reply(JSON.stringify({ sha: 123 }))],
    ['не JSON', reply('ok', 200, 'text/plain')],
    ['пустое тело', reply(null, 204, '')],
    ['соединение отвергнуто', async () => { throw new TypeError('fetch failed'); }],
  ])('%s — нездоров', async (_label, answer) => {
    expect((await runScript(answer)).code).toBe(1);
  });
});
