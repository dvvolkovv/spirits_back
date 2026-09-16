import { execFile } from 'child_process';
import { createServer } from 'net';
import { createServer as createHttpServer } from 'http';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { ProvisionDeps, ProvisionJob, hostDeps, provision } from './provision';
import { skeletonFor } from './skeleton';

const execFileAsync = promisify(execFile);

/**
 * Симулятор хоста продуктов, а не запись команд строками.
 *
 * Проверка вида `cmds.join('\n')).toContain('-p 127.0.0.1:8003:3000')` ловит
 * форму команды, а не её следствие: она одинаково зелена и когда порт
 * опубликован, и когда следом его перебили вторым `-p`, и когда контейнер с
 * этим именем вообще не создан, потому что имя занято. Поэтому здесь argv
 * разбирается так же, как его разобрал бы Docker, и складывается в состояние
 * хоста — контейнеры, тома, публикации, переменные окружения, конфиги nginx.
 * Тесты спрашивают состояние: «опубликован ли порт», «жив ли домен», «свободен
 * ли слаг», — а не «встречается ли подстрока».
 *
 * Симулятор нарочно строгий: незнакомый флаг или незнакомая программа — это
 * исключение, а не молчаливое «ну ладно». Команда, которую на живом хосте
 * никто не понял бы, не должна проходить тест.
 */
class FakeHost {
  /** Каталоги чекаутов: путь → файлы. */
  dirs = new Map<string, Record<string, string>>();
  /** Живые контейнеры: имя → что с ним сделали. */
  containers = new Map<
    string,
    { mount: string; publish?: string; env: Record<string, string>; image: string; cmd: string[] }
  >();
  /** Файлы vhost в /etc/nginx/sites-products. */
  confFiles = new Map<string, number>();
  /** Домены, которые nginx реально обслуживает (конфиг, перечитанный reload'ом). */
  liveVhosts = new Map<string, number>();
  /** Всё, что запускалось, в порядке запуска. */
  calls: string[][] = [];
  removedDirs: string[] = [];
  writtenDirs: string[] = [];

  /** Хук «отказать до того, как команда подействовала». */
  before?: (argv: string[]) => void;
  /** Хук «отказать после того, как команда подействовала» — так падают частично отработавшие шаги. */
  after?: (argv: string[]) => void;
  /** Сломать запись каркаса на середине: каталог создан, файлов нет. */
  writeFilesFailsAfterMkdir = false;

  run = async (argv: string[], opts?: { cwd?: string }): Promise<string> => {
    this.calls.push(argv);
    this.before?.(argv);
    const out = this.dispatch(argv, opts);
    this.after?.(argv);
    return out;
  };

  private dispatch(argv: string[], opts?: { cwd?: string }): string {
    const [bin, ...rest] = argv;
    switch (bin) {
      case 'docker':
        return this.docker(rest);
      case 'git':
        if (!opts?.cwd) throw new Error('git без cwd: отработал бы не в том каталоге');
        if (!this.dirs.has(opts.cwd)) throw new Error(`git в несуществующем каталоге ${opts.cwd}`);
        return '';
      case 'chown':
        return '';
      case 'product-vhost': {
        const [slug, port] = rest;
        if (!/^\d+$/.test(port ?? '')) throw new Error(`product-vhost: порт не число: ${port}`);
        this.confFiles.set(slug, Number(port));
        this.liveVhosts.set(slug, Number(port));
        return '';
      }
      case 'rm': {
        // Подчистка конфига vhost — единственное место, где остался rm.
        if (rest[0] !== '-f') throw new Error(`неожиданные флаги rm: ${rest.join(' ')}`);
        const m = /^\/etc\/nginx\/sites-products\/([^/]+)\.conf$/.exec(rest[1] ?? '');
        if (!m) throw new Error(`rm по неожиданному пути: ${rest[1]}`);
        this.confFiles.delete(m[1]);
        return '';
      }
      case 'nginx': {
        // Живой product-vhost перечитывает конфиг через systemctl, но прямое
        // `nginx -s reload` тоже перечитало бы: обе формы симулируются, чтобы
        // тест на «подчистка ничего не перечитывала» ловил любую из них.
        if (rest.join(' ') !== '-s reload') throw new Error(`неожиданный вызов nginx: ${rest.join(' ')}`);
        this.liveVhosts = new Map(this.confFiles);
        return '';
      }
      case 'systemctl': {
        if (rest.join(' ') !== 'reload nginx') throw new Error(`неожиданный systemctl: ${rest.join(' ')}`);
        this.liveVhosts = new Map(this.confFiles);
        return '';
      }
      default:
        throw new Error(`на хосте нет программы ${bin}`);
    }
  }

  private docker(rest: string[]): string {
    const [sub, ...args] = rest;
    if (sub === 'run') return this.dockerRun(args);
    if (sub === 'ps') return this.dockerPs(args);
    if (sub === 'rm') {
      if (args[0] !== '-f') throw new Error(`docker rm без -f: ${args.join(' ')}`);
      const name = args[1];
      if (!this.containers.delete(name)) throw new Error(`No such container: ${name}`);
      return '';
    }
    throw new Error(`docker ${sub}: неизвестная подкоманда`);
  }

  private dockerRun(args: string[]): string {
    let name = '';
    let mount = '';
    let image = '';
    let publish: string | undefined;
    let restart = '';
    const env: Record<string, string> = {};
    const cmd: string[] = [];

    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      // Позиция образа — не формальность. Живой docker всё, что стоит ПОСЛЕ
      // образа, отдаёт контейнеру командой: `-e RUNNER_TOKEN=…` после образа
      // становится аргументом процесса, а переменной не становится вовсе —
      // продукт молча остаётся без токена. Симулятор обязан разбирать argv так
      // же, иначе «образ первым» выглядит рабочей командой.
      if (image) { cmd.push(a); continue; }
      if (a === '-d') continue;
      if (a === '--name') { name = args[++i]; continue; }
      if (a === '--restart') { restart = args[++i]; continue; }
      if (a === '-v') { mount = args[++i]; continue; }
      if (a === '-p') { publish = args[++i]; continue; }
      if (a === '-e') {
        const pair = args[++i];
        const eq = pair.indexOf('=');
        if (eq < 1) throw new Error(`-e без имени переменной: ${pair}`);
        // Docker берёт последнее значение, если имя повторилось.
        env[pair.slice(0, eq)] = pair.slice(eq + 1);
        continue;
      }
      if (a.startsWith('--memory=') || a.startsWith('--cpus=')) continue;
      if (a.startsWith('-')) throw new Error(`docker run: неизвестный флаг ${a}`);
      image = a;
    }

    if (!name) throw new Error('docker run без --name');
    if (!image) throw new Error('docker run без образа');
    if (restart !== 'unless-stopped') throw new Error(`docker run: --restart=${restart}`);
    if (this.containers.has(name)) {
      throw new Error(`Conflict. The container name "/${name}" is already in use`);
    }
    if (publish) {
      const busy = [...this.containers.values()].some((c) => c.publish === publish);
      if (busy) throw new Error(`Bind for ${publish} failed: port is already allocated`);
    }
    this.containers.set(name, { mount, publish, env, image, cmd });
    return name;
  }

  private dockerPs(args: string[]): string {
    const filter = args.includes('--filter') ? args[args.indexOf('--filter') + 1] : '';
    const m = /^name=\^(.+)\$$/.exec(filter);
    if (!m) throw new Error(`docker ps: неожиданный фильтр ${filter}`);
    return this.containers.has(m[1]) ? `${m[1]}\n` : '\n';
  }

  // --- файловая часть ---

  writeFiles = async (dir: string, files: Record<string, string>): Promise<void> => {
    this.writtenDirs.push(dir);
    this.dirs.set(dir, {});
    if (this.writeFilesFailsAfterMkdir) throw new Error('на диске нет места');
    this.dirs.set(dir, { ...files });
  };

  exists = async (path: string): Promise<boolean> => this.dirs.has(path);

  removeDir = async (dir: string): Promise<void> => {
    this.removedDirs.push(dir);
    this.dirs.delete(dir);
  };

  /** Как на хосте: свободен тот порт, которого нет среди опубликованных у живых контейнеров. */
  freePort = async (): Promise<number> => {
    const taken = new Set(
      [...this.containers.values()]
        .map((c) => c.publish)
        .filter(Boolean)
        .map((p) => Number((p as string).split(':')[1])),
    );
    for (let port = 8001; port <= 8099; port++) if (!taken.has(port)) return port;
    throw new Error('свободных портов нет');
  };

  /** Чисто ли на хосте: ни каталога, ни контейнера, ни домена. */
  isClean(slug: string, productsDir = '/srv/products'): boolean {
    return (
      !this.dirs.has(`${productsDir}/${slug}`) &&
      !this.containers.has(slug) &&
      !this.liveVhosts.has(slug) &&
      !this.confFiles.has(slug)
    );
  }

  ran(bin: string): string[][] {
    return this.calls.filter((c) => c[0] === bin);
  }
}

const OAUTH = 'оаут-токен-хоста';

function deps(host: FakeHost, over: Partial<ProvisionDeps> = {}): ProvisionDeps {
  return {
    run: host.run,
    writeFiles: host.writeFiles,
    exists: host.exists,
    removeDir: host.removeDir,
    freePort: host.freePort,
    readHostSecret: async () => `${OAUTH}\n`,
    waitPort: async () => true,
    productsDir: '/srv/products',
    nginxConfDir: '/etc/nginx/sites-products',
    ...over,
  };
}

function job(over: Partial<ProvisionJob> = {}): ProvisionJob {
  return {
    slug: 'kafe-ulej',
    kind: 'site',
    name: 'Кафе «Улей»',
    runnerToken: 'ткн-раннера',
    secrets: {},
    ...over,
  };
}

let host: FakeHost;
beforeEach(() => {
  host = new FakeHost();
});

describe('форма продукта', () => {
  it('сайт получает публикацию порта на петлю и живой vhost на тот же порт', async () => {
    const res = await provision(job(), deps(host));

    expect(res.port).toBe(8001);
    expect(host.containers.get('kafe-ulej')!.publish).toBe('127.0.0.1:8001:3000');
    expect(host.liveVhosts.get('kafe-ulej')).toBe(8001);
  });

  it('бот не получает ни публикации порта, ни vhost', async () => {
    // Публикация открыла бы бота с адреса хоста, а vhost завёл бы домен,
    // которого у бота быть не должно: он сам ходит в Telegram.
    const res = await provision(job({ slug: 'bot-ulej', kind: 'bot' }), deps(host));

    expect(res.port).toBeUndefined();
    expect(host.containers.get('bot-ulej')!.publish).toBeUndefined();
    expect(host.liveVhosts.size).toBe(0);
    expect(host.confFiles.size).toBe(0);
    expect(host.ran('product-vhost')).toHaveLength(0);
  });

  it('боту не выделяется порт вовсе — иначе порты кончались бы вдвое быстрее', async () => {
    let freePortCalls = 0;
    await provision(
      job({ slug: 'bot-ulej', kind: 'bot' }),
      deps(host, { freePort: async () => { freePortCalls++; return 8001; } }),
    );

    expect(freePortCalls).toBe(0);
  });

  it('форма контейнера одинакова у сайта и бота во всём, кроме публикации порта', async () => {
    await provision(job({ slug: 'sajt' }), deps(host));
    await provision(job({ slug: 'bot', kind: 'bot' }), deps(host));

    const site = host.containers.get('sajt')!;
    const bot = host.containers.get('bot')!;
    expect(bot.image).toBe(site.image);
    expect(bot.env).toEqual(site.env);
    expect(bot.mount).toBe('/srv/products/bot:/product');
  });

  it('контейнер стартует своим entrypoint, без команды поверх', async () => {
    // Всё, что стоит после образа, docker отдаёт контейнеру командой и
    // подменяет ею CMD образа — то есть /entrypoint.sh, который поднимает
    // продукт и раннер. Пустая команда здесь означает «поднимается штатно».
    await provision(job({ secrets: { BOT_TOKEN: 'тк' } }), deps(host));

    const c = host.containers.get('kafe-ulej')!;
    expect(c.cmd).toEqual([]);
    expect(c.image).toBe('linkeon-product:base');
    expect(c.env.RUNNER_TOKEN).toBe('ткн-раннера');
  });

  it('неизвестная форма продукта — отказ до единого изменения на хосте', async () => {
    await expect(
      provision(job({ kind: 'сайт' as any }), deps(host)),
    ).rejects.toThrow(/форма продукта/);

    expect(host.calls).toHaveLength(0);
    expect(host.dirs.size).toBe(0);
  });
});

describe('секреты клиента', () => {
  it('секреты уезжают в контейнер переменными окружения', async () => {
    await provision(job({ secrets: { BOT_TOKEN: 'тк', API_KEY: 'к2' } }), deps(host));

    const env = host.containers.get('kafe-ulej')!.env;
    expect(env.BOT_TOKEN).toBe('тк');
    expect(env.API_KEY).toBe('к2');
  });

  it('кавычка в значении не разрывает команду — значение доезжает дословно', async () => {
    // В черновике значение подставлялось в `-e KEY='${v}'`. Одинарная кавычка
    // внутри закрывает открытую, и остаток значения становится командой,
    // которую хост выполняет от root.
    const value = "a'; rm -rf /srv/products; echo 'b";

    await provision(job({ secrets: { BOT_TOKEN: value } }), deps(host));

    expect(host.containers.get('kafe-ulej')!.env.BOT_TOKEN).toBe(value);
    // Ни одного удаления не случилось: аргумент остался аргументом.
    expect(host.removedDirs).toHaveLength(0);
    expect(host.ran('rm')).toHaveLength(0);
  });

  it('подстановка команды в значении остаётся текстом', async () => {
    const value = '$(cat /root/.secrets/claude-oauth-token)';

    await provision(job({ secrets: { EVIL: value } }), deps(host));

    expect(host.containers.get('kafe-ulej')!.env.EVIL).toBe(value);
  });

  it('многострочный секрет доезжает целым', async () => {
    // Приватные ключи многострочные. Форма argv их переносит, а --env-file —
    // нет: там перевод строки завёл бы НОВУЮ переменную.
    const key = '-----BEGIN KEY-----\nстрока\nещё\n-----END KEY-----';

    await provision(job({ secrets: { SSH_KEY: key } }), deps(host));

    expect(host.containers.get('kafe-ulej')!.env.SSH_KEY).toBe(key);
  });

  it('имя секрета, притворяющееся флагом Docker, отвергается до изменений на хосте', async () => {
    // Второй вектор, который экранирование кавычек не закрывает вовсе:
    // `-v /:/host` в имени отдал бы контейнеру клиента корень хоста.
    for (const key of ['X -v /:/host -e Y', '--privileged', '-e', 'A B', 'КЛЮЧ', '1KEY', 'A=B']) {
      const h = new FakeHost();
      await expect(
        provision(job({ secrets: { [key]: 'v' } }), deps(h)),
      ).rejects.toThrow(/имя секрета/);
      expect(h.calls).toHaveLength(0);
      expect(h.dirs.size).toBe(0);
    }
  });

  it('секрет с именем нашей переменной отвергается', async () => {
    // LINKEON_URL увёл бы раннер продукта за заданиями на чужой сервер вместе
    // с токеном; PRODUCT_START_SCRIPT вернул бы pm2 через оболочку.
    for (const key of ['LINKEON_URL', 'RUNNER_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'PRODUCT_START_SCRIPT', 'PORT', 'CHECKOUT_PATH']) {
      const h = new FakeHost();
      await expect(
        provision(job({ secrets: { [key]: 'подмена' } }), deps(h)),
      ).rejects.toThrow(/имя секрета занято/);
      expect(h.containers.size).toBe(0);
    }
  });

  it('наши переменные доезжают именно нашими значениями', async () => {
    await provision(job({ secrets: { BOT_TOKEN: 'тк' } }), deps(host));

    const env = host.containers.get('kafe-ulej')!.env;
    expect(env.RUNNER_TOKEN).toBe('ткн-раннера');
    expect(env.LINKEON_URL).toBe('https://my.linkeon.io');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(OAUTH);
    expect(env.PORT).toBe('3000');
  });

  it('наши переменные идут последними: Docker берёт последнее значение имени', async () => {
    // Проверка имён секретов выше уже не даёт клиенту назваться нашей
    // переменной, и пока она на месте, порядок в команде ничего не решает.
    // Держим его вторым рубежом и проверяем прямо: ослабнет проверка имён —
    // подмена `RUNNER_TOKEN` или `LINKEON_URL` всё равно не проедет.
    await provision(job({ secrets: { BOT_TOKEN: 'тк', API_KEY: 'к2' } }), deps(host));

    const argv = host.calls.find((c) => c[0] === 'docker' && c[1] === 'run')!;
    const names = argv
      .map((a, i) => (argv[i - 1] === '-e' ? a.slice(0, a.indexOf('=')) : null))
      .filter(Boolean);

    expect(names.slice(0, 2)).toEqual(['BOT_TOKEN', 'API_KEY']);
    expect(names.slice(2)).toEqual([
      'LINKEON_URL',
      'RUNNER_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'PRODUCT_START_SCRIPT',
      'PORT',
    ]);
  });

  it('значение секрета не попадает ни в сообщение об ошибке, ни в доклад', async () => {
    const secret = 'очень-секретное-значение';
    const phases: string[] = [];
    host.before = (argv) => {
      if (argv[0] === 'docker' && argv[1] === 'run') throw new Error('нет места');
    };

    await expect(
      provision(
        job({ secrets: { BOT_TOKEN: secret } }),
        deps(host, { onPhase: (m) => phases.push(m) }),
      ),
    ).rejects.toThrow('нет места');

    expect(phases.join('\n')).not.toContain(secret);
    expect(phases.join('\n')).not.toContain(OAUTH);
  });

  it('имя продукта в шелл не уезжает — оно только в файлах каркаса', async () => {
    const name = '$(rm -rf /srv/products) && `whoami`';

    await provision(job({ name }), deps(host));

    for (const argv of host.calls) {
      for (const arg of argv) expect(arg).not.toContain('whoami');
    }
    // При этом имя в каркасе есть — обезвреженное, за это отвечает skeleton.
    expect(Object.keys(host.dirs.get('/srv/products/kafe-ulej')!)).toEqual(
      Object.keys(skeletonFor('site', name, 'kafe-ulej')),
    );
  });
});

describe('слаг проверяется здесь, а не на той стороне', () => {
  const BAD = ['', '.', '..', '../../etc', 'a/b', 'A', '-kafe', 'kafe-', 'ka fe', 'кафе', 'k'.repeat(41), 'kafe;rm -rf /', 'kafe$(id)'];

  it.each(BAD)('слаг %p отвергается, и на хосте ничего не происходит', async (slug) => {
    const h = new FakeHost();

    await expect(provision(job({ slug }), deps(h))).rejects.toThrow(/слаг не годится/);

    // Главное здесь — не сам отказ, а что до подчистки дело не дошло:
    // именно она сносила бы /srv/products целиком на пустом слаге.
    expect(h.removedDirs).toHaveLength(0);
    expect(h.calls).toHaveLength(0);
    expect(h.dirs.size).toBe(0);
  });

  it('годный слаг с дефисом и цифрами проходит', async () => {
    await provision(job({ slug: 'kafe-2-ulej' }), deps(host));
    expect(host.containers.has('kafe-2-ulej')).toBe(true);
  });

  it('задание без токена раннера отвергается до изменений', async () => {
    await expect(provision(job({ runnerToken: '' }), deps(host))).rejects.toThrow(/токена раннера/);
    expect(host.calls).toHaveLength(0);
  });
});

describe('токен Claude с хоста', () => {
  it('читается один раз и уезжает без хвостового перевода строки', async () => {
    await provision(job(), deps(host, { readHostSecret: async () => `${OAUTH}\n` }));

    expect(host.containers.get('kafe-ulej')!.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(OAUTH);
  });

  it('пустой токен — отказ, а не молча поднятый контейнер', async () => {
    // В черновике токен подставлялся `$(cat ...)`: неудачный cat давал пустую
    // строку, контейнер поднимался, health зеленел, а ходов не было ни одного.
    await expect(
      provision(job(), deps(host, { readHostSecret: async () => '  \n' })),
    ).rejects.toThrow(/токен Claude/);

    expect(host.containers.size).toBe(0);
    expect(host.dirs.size).toBe(0);
  });

  it('нечитаемый файл токена — отказ до изменений на хосте', async () => {
    await expect(
      provision(job(), deps(host, { readHostSecret: async () => { throw new Error('ENOENT'); } })),
    ).rejects.toThrow('ENOENT');

    expect(host.calls).toHaveLength(0);
    expect(host.dirs.size).toBe(0);
  });
});

describe('слаг уже занят', () => {
  it('каталог существует — отказ, и чужой каталог не тронут', async () => {
    host.dirs.set('/srv/products/kafe-ulej', { 'server.js': 'работа клиента' });

    await expect(provision(job(), deps(host))).rejects.toThrow(/уже занят/);

    expect(host.dirs.get('/srv/products/kafe-ulej')).toEqual({ 'server.js': 'работа клиента' });
    expect(host.removedDirs).toHaveLength(0);
    expect(host.writtenDirs).toHaveLength(0);
  });

  it('контейнер с таким именем уже есть — отказ, и чужой контейнер жив', async () => {
    host.containers.set('kafe-ulej', { mount: '/x:/product', env: {}, image: 'чужой', cmd: [] });

    await expect(provision(job(), deps(host))).rejects.toThrow(/контейнер kafe-ulej уже есть/);

    expect(host.containers.get('kafe-ulej')!.image).toBe('чужой');
    expect(host.dirs.size).toBe(0);
    expect(host.writtenDirs).toHaveLength(0);
  });

  it('остановленный контейнер тоже считается занятым именем', async () => {
    // docker run споткнётся и о него: имя занимают и остановленные.
    const calls: string[][] = [];
    const h = new FakeHost();
    h.containers.set('kafe-ulej', { mount: '', env: {}, image: 'старый', cmd: [] });
    const d = deps(h, { run: async (argv, o) => { calls.push(argv); return h.run(argv, o); } });

    await expect(provision(job(), d)).rejects.toThrow(/уже есть/);
    expect(calls[0]).toContain('-a');
  });
});

describe('подчистка при отказе', () => {
  it('падение на середине подчищает за собой', async () => {
    // Иначе слаги и порты кончаются молча: каталог занят, контейнер висит,
    // а продукт числится незаведённым.
    host.before = (argv) => {
      if (argv[0] === 'docker' && argv[1] === 'run') throw new Error('нет места');
    };

    await expect(provision(job(), deps(host))).rejects.toThrow('нет места');

    expect(host.isClean('kafe-ulej')).toBe(true);
  });

  it('после подчистки слаг снова заводится с нуля', async () => {
    // Итог подчистки измеряется не удалением, а тем, что повтор проходит.
    let firstRun = true;
    host.before = (argv) => {
      if (firstRun && argv[0] === 'docker' && argv[1] === 'run') {
        firstRun = false;
        throw new Error('нет места');
      }
    };

    await expect(provision(job(), deps(host))).rejects.toThrow('нет места');
    const res = await provision(job(), deps(host));

    expect(res.port).toBe(8001);
    expect(host.containers.has('kafe-ulej')).toBe(true);
  });

  it('несозданный контейнер не мешает подчистить каталог', async () => {
    // Шаг помечается сделанным ДО docker run, поэтому в самом частом случае
    // снимать нечего. Ошибка «No such container» не должна ни рвать подчистку,
    // ни выглядеть остатком на хосте.
    host.before = (argv) => {
      if (argv[0] === 'docker' && argv[1] === 'run') throw new Error('нет места');
    };

    const err = await provision(job(), deps(host)).catch((e) => e);

    expect(err.leftovers).toBeUndefined();
    expect(host.calls.filter((c) => c[0] === 'docker' && c[1] === 'rm')).toHaveLength(0);
    expect(host.dirs.size).toBe(0);
  });

  it('контейнер, созданный и не стартовавший, тоже снимается', async () => {
    // docker run отказывает и после создания контейнера: тот остаётся в
    // состоянии Created, держит имя и не даёт завести слаг заново.
    host.after = (argv) => {
      if (argv[0] === 'docker' && argv[1] === 'run') throw new Error('OCI runtime create failed');
    };

    await expect(provision(job(), deps(host))).rejects.toThrow(/OCI runtime/);

    expect(host.containers.size).toBe(0);
    expect(host.isClean('kafe-ulej')).toBe(true);
  });

  it('каталог, созданный и незаполненный, тоже удаляется', async () => {
    host.writeFilesFailsAfterMkdir = true;

    await expect(provision(job(), deps(host))).rejects.toThrow('на диске нет места');

    expect(host.dirs.size).toBe(0);
    expect(host.removedDirs).toEqual(['/srv/products/kafe-ulej']);
  });

  it('падение git снимает каталог, контейнер при этом не заводился', async () => {
    host.before = (argv) => {
      if (argv[0] === 'git' && argv[1] === 'commit') throw new Error('nothing to commit');
    };

    await expect(provision(job(), deps(host))).rejects.toThrow('nothing to commit');

    expect(host.isClean('kafe-ulej')).toBe(true);
    expect(host.ran('docker').some((c) => c[1] === 'run')).toBe(false);
  });

  it('частично заведённый vhost снимается вместе с контейнером и каталогом', async () => {
    // product-vhost успевает написать конфиг и падает на своём reload.
    host.after = (argv) => {
      if (argv[0] === 'product-vhost') throw new Error('nginx: configuration file test failed');
    };

    await expect(provision(job(), deps(host))).rejects.toThrow(/test failed/);

    expect(host.isClean('kafe-ulej')).toBe(true);
  });

  it('vhost снимается раньше контейнера: порт не возвращается в оборот под живым доменом', async () => {
    const order: string[] = [];
    host.after = (argv) => {
      if (argv[0] === 'product-vhost') {
        order.push('заведён vhost');
        throw new Error('не задался');
      }
      if (argv[0] === 'systemctl') order.push('снят vhost');
      if (argv[0] === 'docker' && argv[1] === 'rm') order.push('снят контейнер');
    };

    await expect(provision(job(), deps(host))).rejects.toThrow('не задался');

    expect(order).toEqual(['заведён vhost', 'снят vhost', 'снят контейнер']);
  });

  it('подчистка сама падает — контейнер оставлен нарочно, и порт не достаётся чужому продукту', async () => {
    // Порядок подчистки не косметика: контейнер — это то, что держит порт.
    // Если снять его при живом домене, порт вернётся в оборот, достанется
    // следующему продукту, и чужой сайт начнёт отвечать по этому домену.
    const phases: string[] = [];
    host.after = (argv) => {
      if (argv[0] === 'product-vhost') throw new Error('не задался');
    };
    // Отказ reload — «до», а не «после»: конфиг не перечитан, значит домен всё
    // ещё обслуживается по старому, несмотря на удалённый файл.
    host.before = (argv) => {
      if (argv[0] === 'systemctl') throw new Error('nginx: [emerg] duplicate default server');
    };

    const err = await provision(job(), deps(host, { onPhase: (m) => phases.push(m) })).catch((e) => e);

    expect(err.message).toBe('не задался'); // исходная причина, а не причина подчистки
    expect(err.leftovers.join(' ')).toMatch(/vhost/);
    expect(phases.join('\n')).toContain('ВНИМАНИЕ');

    // Домен жив — и контейнер оставлен живым нарочно, чтобы порт был занят.
    expect(host.liveVhosts.get('kafe-ulej')).toBe(8001);
    expect(host.containers.has('kafe-ulej')).toBe(true);

    // Проверка по существу: следующий продукт получает ДРУГОЙ порт, то есть
    // под живым доменом чужого сайта не окажется.
    host.after = undefined;
    host.before = undefined;
    const second = await provision(job({ slug: 'drugoj' }), deps(host));
    expect(second.port).not.toBe(8001);
    expect(host.liveVhosts.get('kafe-ulej')).toBe(8001);
  });

  it('не снятый контейнер оставляет каталог: удалять том из-под живого контейнера нельзя', async () => {
    host.before = (argv) => {
      if (argv[0] === 'docker' && argv[1] === 'rm') throw new Error('device or resource busy');
    };
    host.after = (argv) => {
      if (argv[0] === 'product-vhost') throw new Error('не задался');
    };

    const err = await provision(job(), deps(host)).catch((e) => e);

    expect(err.message).toBe('не задался');
    expect(host.removedDirs).toHaveLength(0);
    expect(host.dirs.has('/srv/products/kafe-ulej')).toBe(true);
    expect(err.leftovers.join(' ')).toContain('/srv/products/kafe-ulej');
  });

  it('удачная подчистка не оставляет предупреждений и не выдумывает остатков', async () => {
    const phases: string[] = [];
    host.before = (argv) => {
      if (argv[0] === 'docker' && argv[1] === 'run') throw new Error('нет места');
    };

    const err = await provision(job(), deps(host, { onPhase: (m) => phases.push(m) })).catch((e) => e);

    expect(err.leftovers).toBeUndefined();
    expect(phases.join('\n')).not.toContain('ВНИМАНИЕ');
  });

  it('подчистка не трогает того, чего не создавала', async () => {
    // Отказ до первого изменения: ни одного докерного или файлового действия
    // после него быть не должно.
    host.before = (argv) => {
      if (argv[0] === 'docker' && argv[1] === 'ps') throw new Error('docker daemon недоступен');
    };

    await expect(provision(job(), deps(host))).rejects.toThrow(/daemon/);

    expect(host.removedDirs).toHaveLength(0);
    expect(host.ran('rm')).toHaveLength(0);
    expect(host.calls.filter((c) => c[0] === 'docker' && c[1] === 'rm')).toHaveLength(0);
  });
});

describe('ожидание порта вместо sleep 12', () => {
  it('vhost заводится только после того, как порт ответил', async () => {
    // Иначе домен молча отдаёт 502: nginx с proxy_pass на мёртвый порт не
    // ругается, promoteReady не видит публичного 200, и продукт висит в
    // provisioning до таймаута при живом контейнере.
    let vhostAtWait = 0;
    const d = deps(host, {
      waitPort: async () => {
        vhostAtWait = host.confFiles.size;
        return true;
      },
    });

    await provision(job(), d);

    expect(vhostAtWait).toBe(0);
    expect(host.containers.has('kafe-ulej')).toBe(true);
  });

  it('порт не поднялся — отказ с подчисткой, а не vhost вслепую', async () => {
    await expect(
      provision(job(), deps(host, { waitPort: async () => false, waitPortTimeoutMs: 45_000 })),
    ).rejects.toThrow(/не ответил на http:\/\/127\.0\.0\.1:8001\/health за 45 с/);

    expect(host.ran('product-vhost')).toHaveLength(0);
    expect(host.isClean('kafe-ulej')).toBe(true);
  });

  it('ждём тот самый порт, который опубликован', async () => {
    const waited: number[] = [];
    await provision(
      job(),
      deps(host, { freePort: async () => 8042, waitPort: async (p) => { waited.push(p); return true; } }),
    );

    expect(waited).toEqual([8042]);
    expect(host.containers.get('kafe-ulej')!.publish).toBe('127.0.0.1:8042:3000');
    expect(host.liveVhosts.get('kafe-ulej')).toBe(8042);
  });

  it('у бота ждать нечего — ожидание не вызывается', async () => {
    let waits = 0;
    await provision(
      job({ slug: 'bot', kind: 'bot' }),
      deps(host, { waitPort: async () => { waits++; return true; } }),
    );

    expect(waits).toBe(0);
  });
});

describe('точка входа продукта', () => {
  it('PRODUCT_START_SCRIPT — файл каркаса, а не команда', async () => {
    // С командой pm2 владеет оболочкой, а не процессом: при перезапуске старый
    // выживает сиротой, держит порт и отвечает старым кодом — health-check
    // проверяет сироту, автооткат не срабатывает.
    await provision(job(), deps(host));

    const value = host.containers.get('kafe-ulej')!.env.PRODUCT_START_SCRIPT;
    const files = host.dirs.get('/srv/products/kafe-ulej')!;
    expect(Object.keys(files)).toContain(value);
    expect(value).not.toMatch(/[\s;&|$]/);
  });

  it('у бота точка входа та же и тоже существует в каркасе', async () => {
    await provision(job({ slug: 'bot', kind: 'bot' }), deps(host));

    const value = host.containers.get('bot')!.env.PRODUCT_START_SCRIPT;
    expect(Object.keys(host.dirs.get('/srv/products/bot')!)).toContain(value);
  });
});

describe('на настоящей файловой системе', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'provision-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** Настоящие fs и git, симулятор — только для docker, chown, nginx. */
  function realDeps(over: Partial<ProvisionDeps> = {}): ProvisionDeps {
    const real = hostDeps();
    return {
      ...real,
      productsDir: root,
      readHostSecret: async () => OAUTH,
      freePort: async () => 8001,
      waitPort: async () => true,
      run: async (argv, opts) => {
        // chown 1000:1000 под обычным пользователем не пройдёт — на хосте это
        // делается от root.
        if (argv[0] === 'git') return real.run(argv, opts);
        return host.run(argv, opts);
      },
      ...over,
    };
  }

  it('в чекауте настоящий git-репозиторий с одним коммитом и каркасом', async () => {
    await provision(job(), realDeps());

    const dir = join(root, 'kafe-ulej');
    const log = await execFileAsync('git', ['log', '--oneline'], { cwd: dir });
    expect(log.stdout.trim().split('\n')).toHaveLength(1);
    expect(log.stdout).toContain('первичный каркас продукта');

    const status = await execFileAsync('git', ['status', '--porcelain'], { cwd: dir });
    expect(status.stdout.trim()).toBe('');

    const tracked = (await execFileAsync('git', ['ls-files'], { cwd: dir })).stdout.trim().split('\n').sort();
    expect(tracked).toEqual(Object.keys(skeletonFor('site', 'Кафе «Улей»', 'kafe-ulej')).sort());
  });

  it('содержимое файлов в чекауте совпадает с каркасом байт в байт', async () => {
    await provision(job(), realDeps());

    const files = skeletonFor('site', 'Кафе «Улей»', 'kafe-ulej');
    for (const [name, content] of Object.entries(files)) {
      expect(await readFile(join(root, 'kafe-ulej', name), 'utf8')).toBe(content);
    }
  });

  it('контейнер стартует только когда в чекауте уже есть .git', async () => {
    // entrypoint отказывается стартовать без .git: без него не работает откат.
    let gitAtRun: boolean | null = null;
    host.before = (argv) => {
      if (argv[0] === 'docker' && argv[1] === 'run') {
        gitAtRun = existsSync(join(root, 'kafe-ulej', '.git'));
      }
    };

    await provision(job(), realDeps());

    expect(gitAtRun).toBe(true);
  });

  it('отказ после записи действительно стирает каталог с диска', async () => {
    host.before = (argv) => {
      if (argv[0] === 'docker' && argv[1] === 'run') throw new Error('нет места');
    };

    await expect(provision(job(), realDeps())).rejects.toThrow('нет места');

    expect(existsSync(join(root, 'kafe-ulej'))).toBe(false);
  });

  it('существующий на диске каталог — отказ, и его содержимое цело', async () => {
    const dir = join(root, 'kafe-ulej');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'server.js'), 'работа клиента', 'utf8');

    await expect(provision(job(), realDeps())).rejects.toThrow(/уже занят/);

    expect(await readFile(join(dir, 'server.js'), 'utf8')).toBe('работа клиента');
  });
});

describe('настоящие реализации для хоста', () => {
  it('run не проходит через шелл: аргумент остаётся аргументом', async () => {
    const value = "a'; echo взлом; echo '";
    const out = await hostDeps().run(['node', '-e', 'process.stdout.write(process.argv[1])', value]);

    expect(out).toBe(value);
  });

  it('writeFiles, exists и removeDir работают на настоящей ФС', async () => {
    const d = hostDeps();
    const root = await mkdtemp(join(tmpdir(), 'hostdeps-'));
    const dir = join(root, 'p');

    expect(await d.exists(dir)).toBe(false);
    await d.writeFiles(dir, { 'a.txt': 'раз', 'b.txt': 'два' });
    expect(await d.exists(dir)).toBe(true);
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('раз');

    await d.removeDir(dir);
    expect(await d.exists(dir)).toBe(false);
    await rm(root, { recursive: true, force: true });
  });

  it('exists видит и файл, и каталог — занятый путь есть занятый путь', async () => {
    const d = hostDeps();
    const root = await mkdtemp(join(tmpdir(), 'hostdeps-'));
    const file = join(root, 'занято');
    await writeFile(file, '', 'utf8');

    expect(await d.exists(file)).toBe(true);
    await rm(root, { recursive: true, force: true });
  });

  it('freePort пропускает порты, занятые контейнерами', async () => {
    const d = hostDeps({
      run: async () => '127.0.0.1:8001->3000/tcp\n127.0.0.1:8002->3000/tcp\n',
    });

    expect(await d.freePort()).toBe(8003);
  });

  it('freePort не путает 8001 с 18001', async () => {
    const d = hostDeps({ run: async () => '127.0.0.1:18001->3000/tcp\n' });

    expect(await d.freePort()).toBe(8001);
  });

  it('freePort отказывает, когда весь диапазон занят', async () => {
    const busy = Array.from({ length: 99 }, (_, i) => `127.0.0.1:${8001 + i}->3000/tcp`).join('\n');
    const d = hostDeps({ run: async () => busy });

    await expect(d.freePort()).rejects.toThrow(/свободных портов/);
  });

  /**
   * Ожидание поднявшегося продукта проверяется НАСТОЯЩИМ HTTP, а не заглушкой.
   *
   * Прошлая редакция спрашивала TCP-connect и проверялась `createServer()` без
   * обработчика соединений. Оба конца были одинаково пустые, тест сходился, и
   * защита не работала: порт хоста занимает docker-proxy с момента `docker
   * run`, так что connect проходит при пустом контейнере. Поэтому ниже каждый
   * случай — отдельный вид «на порту кто-то есть, но продукта нет».
   */
  async function serve(
    handler: (req: any, res: any) => void,
  ): Promise<{ port: number; close: () => Promise<void> }> {
    const server = createHttpServer(handler);
    const port: number = await new Promise((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve((server.address() as any).port)),
    );
    return {
      port,
      close: () =>
        new Promise<void>((resolve) => {
          (server as any).closeAllConnections?.();
          server.close(() => resolve());
        }),
    };
  }

  const health = (body: unknown) => (_req: any, res: any) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  it('поднявшийся продукт — 200 с полем sha', async () => {
    const s = await serve(health({ ok: true, sha: 'a1b2c3' }));

    expect(await hostDeps().waitPort(s.port, 2000)).toBe(true);
    await s.close();
  });

  it('порт принимает соединение и молчит — так выглядит docker-proxy при пустом контейнере', async () => {
    // Ровно этим `createServer()` без обработчика прошлая редакция теста и
    // зеленела. Теперь это случай «продукт не поднялся».
    // Соединения запоминаем, чтобы разорвать их руками: net.Server, в отличие
    // от http.Server, ждёт закрытия открытых соединений и без этого close()
    // не вернётся никогда.
    const accepted: import('net').Socket[] = [];
    const server = createServer((socket) => accepted.push(socket));
    const port: number = await new Promise((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve((server.address() as any).port)),
    );

    expect(await hostDeps().waitPort(port, 100)).toBe(false);
    expect(accepted.length).toBeGreaterThan(0); // соединение приняли, ответа не дали

    accepted.forEach((socket) => socket.destroy());
    await new Promise((r) => server.close(() => r(null)));
  });

  it('200 без поля sha — на порту не наш продукт', async () => {
    const s = await serve(health({ ok: true }));

    expect(await hostDeps().waitPort(s.port, 100)).toBe(false);
    await s.close();
  });

  it('503 на старте — ещё не поднялся', async () => {
    const s = await serve((_req, res) => {
      res.writeHead(503);
      res.end('starting');
    });

    expect(await hostDeps().waitPort(s.port, 100)).toBe(false);
    await s.close();
  });

  it('503 с полным телом health — код ответа решает, а не наличие sha', async () => {
    // Продукт, который клиенту напишет ассистент, вполне может отдавать на
    // прогреве 503 и уже знать свой sha. Пускать vhost на него нельзя: домен
    // тут же начнёт отдавать 503 наружу.
    const s = await serve((_req, res) => {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, sha: 'a1b2c3' }));
    });

    expect(await hostDeps().waitPort(s.port, 100)).toBe(false);
    await s.close();
  });

  it('HTML без content-type тоже не health: смотрим и на тело', async () => {
    // Заголовок может быть каким угодно — text/plain, octet-stream, пусто.
    // Единственное, на что тут можно опереться, это само тело.
    const s = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('<!doctype html><html><body>заглушка хостинга</body></html>');
    });

    expect(await hostDeps().waitPort(s.port, 100)).toBe(false);
    await s.close();
  });

  it('200 с HTML — это фолбэк, а не health', async () => {
    // На доменах проекта SPA-фолбэк отдаёт 200 с index.html на любой путь.
    const s = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><body>ok</body></html>');
    });

    expect(await hostDeps().waitPort(s.port, 100)).toBe(false);
    await s.close();
  });

  it('закрытый порт — ложь', async () => {
    const s = await serve(health({ ok: true, sha: 'a1' }));
    const port = s.port;
    await s.close();

    expect(await hostDeps().waitPort(port, 100)).toBe(false);
  });

  it('продукт, поднявшийся не сразу, дожидается — это ожидание, а не одна проба', async () => {
    const readyAt = Date.now() + 700;
    const s = await serve((_req, res) => {
      if (Date.now() < readyAt) {
        res.writeHead(503);
        return res.end('starting');
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sha: 'a1b2c3' }));
    });

    expect(await hostDeps().waitPort(s.port, 10_000)).toBe(true);
    await s.close();
  });
});

/**
 * Добавлено проверкой задачи 9. Каждый случай здесь — мутация, пережившая
 * исходную батарею: код её закрывает, а тест на неё отсутствовал, то есть
 * защита держалась ни на чём и могла уехать первой же правкой.
 */
describe('дыры, оставшиеся незакрытыми тестом', () => {
  // Мутация: SLUG_RE с флагом `m`. В JavaScript `$` без `m` не совпадает
  // перед хвостовым переводом строки — на этом и держится отказ, но ни один
  // тест этого не мерил. С флагом `m` слаг `kafe\n../../etc` проходит
  // проверку целиком, а путь для удаления собирается из ВСЕЙ строки.
  it.each(['kafe\n', 'kafe\n../../etc', '\nkafe', 'kafe\nrm'])(
    'слаг с переводом строки (%j) отвергается: путь собирается из всей строки, а не из первой',
    async (slug) => {
      const h = new FakeHost();

      await expect(provision(job({ slug }), deps(h))).rejects.toThrow(/слаг не годится/);

      expect(h.calls).toHaveLength(0);
      expect(h.removedDirs).toHaveLength(0);
    },
  );

  // Та же мутация в SECRET_KEY_RE: с флагом `m` имя `OK\n-v /:/host -e Y`
  // проходит по первой строке.
  it.each(['OK\n', 'OK\n-v /:/host -e Y', '\nOK'])(
    'имя секрета с переводом строки (%j) отвергается',
    async (key) => {
      const h = new FakeHost();

      await expect(provision(job({ secrets: { [key]: 'v' } }), deps(h))).rejects.toThrow(/имя секрета/);
      expect(h.calls).toHaveLength(0);
    },
  );

  // Мутации: убрать PATH / NODE_OPTIONS / HOME / CLAUDE_BIN из RESERVED_ENV.
  // Все четыре выжили. И это худшая половина списка: свои `-e` мы шлём
  // последними, и для LINKEON_URL или RUNNER_TOKEN порядок — второй рубеж.
  // Эти четыре мы не шлём вовсе, поэтому проверка имени у них ЕДИНСТВЕННАЯ
  // защита, и клиентский `PATH=/tmp` или `NODE_OPTIONS=--require /tmp/x.js`
  // подменяет то, чем раннер запускает продукт.
  it.each(['PATH', 'NODE_OPTIONS', 'HOME', 'CLAUDE_BIN'])(
    'секрет с именем %s отвергается: мы такого -e не шлём, перебить его нечем',
    async (key) => {
      const h = new FakeHost();

      await expect(
        provision(job({ secrets: { [key]: '/tmp/подмена' } }), deps(h)),
      ).rejects.toThrow(/имя секрета занято/);
      expect(h.containers.size).toBe(0);
    },
  );

  it('нулевой байт в значении секрета — отказ до изменений на хосте', async () => {
    // execFile отвергает его сам, но уже после того, как каталог создан и
    // закоммичен: отказ пришёл бы через подчистку и с невнятным ERR_INVALID_ARG_VALUE.
    await expect(
      provision(job({ secrets: { BOT_TOKEN: 'aa\0bb' } }), deps(host)),
    ).rejects.toThrow(/нулевой байт/);

    expect(host.calls).toHaveLength(0);
    expect(host.dirs.size).toBe(0);
  });

  it('подчистка не трогает vhost, которого не заводила', async () => {
    // Мутация: снять `done.includes('vhost')`. У бота vhost не заводится
    // вовсе, но конфиг с таким именем на хосте остаться мог — от прошлой
    // жизни слага. Подчистка, снимающая чужой конфиг, уносит домен, к
    // которому этот провижининг не притрагивался.
    host.confFiles.set('bot-ulej', 9999);
    host.liveVhosts.set('bot-ulej', 9999);
    host.before = (argv) => {
      if (argv[0] === 'docker' && argv[1] === 'run') throw new Error('нет места');
    };

    await expect(provision(job({ slug: 'bot-ulej', kind: 'bot' }), deps(host))).rejects.toThrow('нет места');

    expect(host.ran('rm')).toHaveLength(0);
    expect(host.ran('nginx')).toHaveLength(0);
    expect(host.ran('systemctl')).toHaveLength(0);
    expect(host.liveVhosts.get('bot-ulej')).toBe(9999);
  });

  it('образ — последний аргумент: всё, что после него, docker отдал бы контейнеру', async () => {
    // Мутация: поставить образ перед флагами. Симулятор её переживает —
    // он разбирает argv как набор флагов, а живой docker всё после образа
    // считает командой контейнера: `-e RUNNER_TOKEN=…` стал бы аргументом
    // процесса, переменной не стал бы, и продукт молча остался бы без токена.
    await provision(job({ secrets: { BOT_TOKEN: 'тк' } }), deps(host));

    const argv = host.calls.find((c) => c[0] === 'docker' && c[1] === 'run')!;
    expect(argv[argv.length - 1]).toBe('linkeon-product:base');
    expect(argv.indexOf('linkeon-product:base')).toBe(argv.length - 1);
  });

  it('контейнеру выставлены пределы памяти и CPU', async () => {
    // Мутация: снять `--memory`/`--cpus`. Продукт клиента живёт на общей
    // машине, и без предела один цикл в его коде уносит все остальные.
    await provision(job(), deps(host));

    const argv = host.calls.find((c) => c[0] === 'docker' && c[1] === 'run')!;
    expect(argv).toContain('--memory=1g');
    expect(argv).toContain('--cpus=1');
  });
});

/**
 * ДЕФЕКТ, найденный проверкой задачи 9. Блок заводился КРАСНЫМ и показывал,
 * что `waitPort` не измеряет того, ради чего его завели. Дефект устранён —
 * `probe` спрашивает `GET /health` и требует 200 с полем `sha`, — а тест
 * остаётся сторожем: он краснеет на любом возврате к проверке сокета.
 *
 * Шапка provision.ts обещает: `sleep 12` заменён ожиданием по факту, «vhost
 * заводится только после того, как порт ответил». На деле `probe()` делает
 * голый TCP-connect, а порт хоста занимает docker-proxy — в момент `docker
 * run`, задолго до того, как внутри контейнера поднимется pm2 и начнёт
 * слушать приложение.
 *
 * Замерено на живом docker (EnableUserlandProxy: true — умолчание):
 *
 *   docker run -d -p 127.0.0.1:18099:3000 redis:7-alpine sh -c 'sleep 60'
 *   connect 127.0.0.1:18099 → CONNECT OK
 *
 * Внутри контейнера не слушает никто, а connect проходит. То есть `waitPort`
 * возвращает true сразу после `docker run`: это не ожидание по факту, это
 * `sleep 0` — строго хуже `sleep 12`, который заменяли. Промах тот же и такой
 * же тихий: vhost заведён на порт, за которым ещё никого нет, домен отдаёт
 * 502, `promoteReady` не видит публичного 200, продукт висит в `provisioning`
 * до таймаута при живом контейнере.
 *
 * Старый тест «waitPort отвечает правдой про слушающий порт» этого не ловит:
 * `createServer()` без обработчика соединений ведёт себя ровно как
 * docker-proxy с мёртвым бэкендом — принимает и молчит.
 *
 * Починено в `probe`: спрашивается `GET http://127.0.0.1:PORT/health` с
 * требованием 200 и поля `sha`, как `checkHealth` в deploy.ts, на который
 * шапка и ссылается. Каркас сайта этот маршрут уже отдаёт.
 */
describe('waitPort отличает поднявшийся продукт от docker-proxy', () => {
  it('порт, который принимает соединение и тут же рвёт его, не считается поднявшимся', async () => {
    const server = createServer((s) => s.destroy());
    const port: number = await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as any).port));
    });

    const up = await hostDeps().waitPort(port, 2000);
    await new Promise((r) => server.close(r));

    expect(up).toBe(false);
  });
});
