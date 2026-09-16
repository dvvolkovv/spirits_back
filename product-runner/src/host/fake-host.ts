/**
 * СИМУЛЯТОР ХОСТА ПРОДУКТОВ. Общий для provision.spec.ts и sleep.spec.ts.
 *
 * ПОЧЕМУ ОТДЕЛЬНЫМ ФАЙЛОМ, А НЕ КОПИЕЙ. Хостовых шагов стало два семейства —
 * заведение и сон с пробуждением, — и обе проверки обязаны видеть ОДНО
 * состояние хоста. Скопированный симулятор разошёлся бы с оригиналом молча:
 * сон проверялся бы против модели, в которой `docker run` ведёт себя не так,
 * как в модели заведения, и обе батареи оставались бы зелёными.
 *
 * ПОЧЕМУ НЕ `*.spec.ts`. Файл с тестами, импортированный из другого спека,
 * регистрирует свои describe/it В НЁМ ЖЕ — тесты посчитались бы дважды. А имя
 * без `.spec` попадает под `include` сборки (tsconfig исключает только
 * `src/**\/*.spec.ts`), поэтому файл дописан в `exclude` явно: симулятор
 * хоста не имеет права уехать в dist боевого агента. Типы его при этом
 * проверяет ts-jest — он компилирует импортируемые .ts вместе со спеком.
 *
 * Собственные свойства симулятора сторожит fake-host.spec.ts: он общий, и
 * незамеченная правка ослабила бы сразу обе батареи.
 */
import { ProvisionDeps } from './provision';

export class FakeHost {
  /** Каталоги чекаутов: путь → файлы. */
  dirs = new Map<string, Record<string, string>>();
  /** Живые контейнеры: имя → что с ним сделали. */
  containers = new Map<
    string,
    { mount: string; publish?: string; env: Record<string, string>; image: string; cmd: string[] }
  >();
  /**
   * Контейнеры, которые СУЩЕСТВУЮТ, но остановлены.
   *
   * Отдельным множеством, а не полем контейнера: остановленный держит имя,
   * каталог и своё отображение портов, и всё это надо уметь отличать от
   * удалённого. Ровно в этой разнице смысл сна — перестать тратить память, а
   * не начать заново.
   */
  stopped = new Set<string>();
  /** Файлы vhost в /etc/nginx/sites-products. Значение — порт proxy_pass. */
  confFiles = new Map<string, number>();
  /** Домены, которые nginx реально обслуживает (конфиг, перечитанный reload'ом). */
  liveVhosts = new Map<string, number>();
  /**
   * Режим vhost: боевой прокси или заглушка неоплаченного продукта.
   *
   * Отдельно от портов, потому что у заглушки порта нет вовсе (`return 503`
   * вместо `proxy_pass`), а `confFiles`/`liveVhosts` продолжают отвечать на
   * вопрос «есть ли конфиг и обслуживается ли домен». В картах при этом
   * лежит 0 — «проксировать некуда».
   */
  vhostModes = new Map<string, 'live' | 'asleep'>();
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
        const [slug, arg] = rest;
        // Живой скрипт — `sh -eu` с `S="$1"; P="$2"`, и конфиг он пишет ДО
        // `nginx -t`. Флаг он обязан разбирать сам: `product-vhost shop
        // --asleep` на прежней редакции подставил бы `--asleep` в
        // `proxy_pass`, оставил бы битый конфиг на диске и уронил бы `nginx
        // -t` для ВСЕГО хоста — ни один продукт больше не перечитался бы.
        if (arg === '--asleep') {
          this.confFiles.set(slug, 0);
          this.liveVhosts.set(slug, 0);
          this.vhostModes.set(slug, 'asleep');
          return '';
        }
        if (!/^\d+$/.test(arg ?? '')) throw new Error(`product-vhost: порт не число: ${arg}`);
        this.confFiles.set(slug, Number(arg));
        this.liveVhosts.set(slug, Number(arg));
        this.vhostModes.set(slug, 'live');
        return '';
      }
      case 'rm': {
        // Подчистка конфига vhost — единственное место, где остался rm.
        if (rest[0] !== '-f') throw new Error(`неожиданные флаги rm: ${rest.join(' ')}`);
        const m = /^\/etc\/nginx\/sites-products\/([^/]+)\.conf$/.exec(rest[1] ?? '');
        if (!m) throw new Error(`rm по неожиданному пути: ${rest[1]}`);
        this.confFiles.delete(m[1]);
        this.vhostModes.delete(m[1]);
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
      this.stopped.delete(name);
      return '';
    }
    if (sub === 'stop' || sub === 'start') return this.dockerStopStart(sub, args);
    throw new Error(`docker ${sub}: неизвестная подкоманда`);
  }

  /**
   * `docker stop` / `docker start`. Ни то, ни другое НЕ удаляет контейнер: имя,
   * монтирование и отображение портов у него остаются.
   *
   * Повторный `stop` уже остановленного и `start` уже запущенного — no-op, как
   * у живого docker: иначе сон, доехавший до агента дважды (ретрай отчёта,
   * повторная выдача задания), выглядел бы отказом там, где хост уже в нужном
   * состоянии.
   *
   * Отказ старта по занятому порту — НЕ выдумка ради строгости. Порт
   * остановленного контейнера исчезает из `docker ps`, а `freePort` боевых
   * зависимостей спрашивает именно `docker ps` без `-a`: пока один продукт
   * спит, его порт может достаться новому. Тогда `docker start` упирается
   * ровно в это сообщение.
   */
  private dockerStopStart(sub: 'stop' | 'start', args: string[]): string {
    const [name, ...extra] = args;
    if (extra.length) throw new Error(`docker ${sub}: лишние аргументы ${extra.join(' ')}`);
    if (!this.containers.has(name)) throw new Error(`No such container: ${name}`);
    if (sub === 'stop') {
      this.stopped.add(name);
      return name;
    }
    const publish = this.containers.get(name)!.publish;
    if (publish && this.publishTakenByRunning(publish, name)) {
      throw new Error(
        `Error response from daemon: driver failed programming external connectivity on endpoint ${name}: `
          + `Bind for ${publish} failed: port is already allocated`,
      );
    }
    this.stopped.delete(name);
    return name;
  }

  /** Держит ли этот адрес публикации какой-нибудь ЗАПУЩЕННЫЙ контейнер. */
  private publishTakenByRunning(publish: string, except?: string): boolean {
    for (const [name, c] of this.containers) {
      if (name === except || this.stopped.has(name)) continue;
      if (c.publish === publish) return true;
    }
    return false;
  }

  /** Есть ли контейнер и запущен ли он. */
  isRunning(name: string): boolean {
    return this.containers.has(name) && !this.stopped.has(name);
  }

  /** Боевой прокси, заглушка или домена нет вовсе. */
  vhostMode(slug: string): 'live' | 'asleep' | undefined {
    return this.liveVhosts.has(slug) ? this.vhostModes.get(slug) : undefined;
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
      // Порт держит только ЗАПУЩЕННЫЙ контейнер: остановленный своё
      // отображение освобождает и заберёт обратно лишь на `docker start`.
      // Именно отсюда растёт опасность сна — см. dockerStopStart.
      const busy = this.publishTakenByRunning(publish);
      if (busy) throw new Error(`Bind for ${publish} failed: port is already allocated`);
    }
    this.containers.set(name, { mount, publish, env, image, cmd });
    return name;
  }

  private dockerPs(args: string[]): string {
    const filter = args.includes('--filter') ? args[args.indexOf('--filter') + 1] : '';
    const m = /^name=\^(.+)\$$/.exec(filter);
    if (!m) throw new Error(`docker ps: неожиданный фильтр ${filter}`);
    // `-a` показывает и остановленные, без него — только запущенные. Разница
    // существует ровно со сна: `containerTaken` спрашивает с `-a` намеренно,
    // потому что имя занимает и погашенный контейнер.
    const visible = args.includes('-a') ? this.containers.has(m[1]) : this.isRunning(m[1]);
    return visible ? `${m[1]}\n` : '\n';
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

  /**
   * Как на хосте: свободен тот порт, которого нет среди опубликованных у
   * ЗАПУЩЕННЫХ контейнеров.
   *
   * «Запущенных», а не «существующих», — это не строгость, а воспроизведение
   * боевого `hostDeps.freePort`: он спрашивает `docker ps` БЕЗ `-a`, и порт
   * остановленного контейнера в выдачу не попадает. Отсюда и растёт стык,
   * который сторожит sleep.spec: пока продукт спит, его порт может достаться
   * новому, и пробуждение упрётся в «port is already allocated». Симулятор,
   * считающий такой порт занятым, показывал бы хост честнее, чем он есть.
   */
  freePort = async (): Promise<number> => {
    const taken = new Set(
      [...this.containers.entries()]
        .filter(([name]) => !this.stopped.has(name))
        .map(([, c]) => c.publish)
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

export const OAUTH = 'оаут-токен-хоста';

export function deps(host: FakeHost, over: Partial<ProvisionDeps> = {}): ProvisionDeps {
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
