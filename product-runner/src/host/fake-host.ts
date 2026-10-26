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
    {
      mount: string;
      publish?: string;
      env: Record<string, string>;
      /** Чем контейнер запущен — метка или идентификатор, как было в argv (`.Config.Image`). */
      image: string;
      /**
       * Идентификатор образа, на который метка указывала В МОМЕНТ запуска
       * (`.Image`). Необязательные (и restart тоже): спеки заведения кладут
       * контейнер в карту руками (`provision.spec.ts` ~323, ~336) без этих
       * полей; inspectWhole подставляет умолчания.
       */
      imageId?: string;
      cmd: string[];
      restart?: string;
      memory?: string;
      cpus?: string;
    }
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
  /**
   * Образы: идентификатор → окружение образа. Метки — отдельно: метка, как у
   * docker, ПЕРЕДВИГАЕТСЯ на новый образ (`base` после обновления образа), а
   * уже запущенный контейнер остаётся на старом идентификаторе. Ровно на этой
   * разнице стоит выбор образа при смене ключей (rekey.ts).
   */
  images = new Map<string, { env: string[] }>();
  tags = new Map<string, string>();

  /**
   * Здоров ли контейнер для `/health` — общий для `docker exec` (бот) и
   * `probePort` (сайт). По умолчанию здоров любой запущенный; тест подменяет
   * правило, чтобы «нездоровым» был именно контейнер с плохими ключами.
   */
  healthy: (name: string, c: { env: Record<string, string> }) => boolean = () => true;

  /** Завести образ под меткой (или передвинуть метку на другой образ). */
  tagImage(tag: string, id: string, env: string[] = []): void {
    this.images.set(id, { env });
    this.tags.set(tag, id);
  }

  /** Идентификатор по метке или идентификатору; незнакомая метка заводит пустой образ. */
  private resolveImage(ref: string): string {
    if (this.images.has(ref)) return ref;
    const id = this.tags.get(ref);
    if (id) return id;
    const fresh = `sha256:fake-${ref}`;
    this.tagImage(ref, fresh, []);
    return fresh;
  }

  /** Сайт отвечает на порту: запущенный контейнер с этой публикацией и здоровый. */
  probePort(port: number): boolean {
    for (const [name, c] of this.containers) {
      if (this.stopped.has(name) || !c.publish) continue;
      if (Number(c.publish.split(':')[1]) === port) return this.healthy(name, c);
    }
    return false;
  }

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
  /**
   * Свои имена в конфиге продукта — ПОСЛЕДНИЙ набор, а не накопленный: живой
   * product-vhost переписывает конфиг целиком, и имя, не приехавшее в вызове,
   * из конфига уходит. Пустой список — «своих имён нет».
   */
  vhostDomains = new Map<string, string[]>();
  /** Сертификаты certbot по имени (`--cert-name`). */
  certs = new Set<string>();
  /**
   * Текст отказа `certbot certonly`, заданный тестом, или null — выпуск проходит.
   * Отказ бросается ДО выпуска: сертификата после него нет, как у живого certbot.
   */
  certbotFails: string | null = null;
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
        const [slug, arg, ...tail] = rest;
        // Хвост — только пары `--domain <имя>`. Всё прочее живой скрипт не
        // поймёт, и симулятор, проглотивший хвост, зеленил бы форму вызова,
        // на которой скрипт падает.
        const names: string[] = [];
        for (let i = 0; i < tail.length; i += 2) {
          if (tail[i] !== '--domain' || !tail[i + 1]) {
            throw new Error(`product-vhost: непонятный хвост: ${tail.join(' ')}`);
          }
          names.push(tail[i + 1]);
        }
        // Живой скрипт — `sh -eu` с `S="$1"; P="$2"`, и конфиг он пишет ДО
        // `nginx -t`. Флаг он обязан разбирать сам: `product-vhost shop
        // --asleep` на прежней редакции подставил бы `--asleep` в
        // `proxy_pass`, оставил бы битый конфиг на диске и уронил бы `nginx
        // -t` для ВСЕГО хоста — ни один продукт больше не перечитался бы.
        if (arg === '--asleep') {
          this.confFiles.set(slug, 0);
          this.liveVhosts.set(slug, 0);
          this.vhostModes.set(slug, 'asleep');
          this.vhostDomains.set(slug, names);
          return '';
        }
        if (!/^\d+$/.test(arg ?? '')) throw new Error(`product-vhost: порт не число: ${arg}`);
        this.confFiles.set(slug, Number(arg));
        this.liveVhosts.set(slug, Number(arg));
        this.vhostModes.set(slug, 'live');
        this.vhostDomains.set(slug, names);
        return '';
      }
      case 'certbot':
        return this.certbot(rest);
      case 'rm': {
        // Подчистка конфига vhost — единственное место, где остался rm.
        if (rest[0] !== '-f') throw new Error(`неожиданные флаги rm: ${rest.join(' ')}`);
        const m = /^\/etc\/nginx\/sites-products\/([^/]+)\.conf$/.exec(rest[1] ?? '');
        if (!m) throw new Error(`rm по неожиданному пути: ${rest[1]}`);
        this.confFiles.delete(m[1]);
        this.vhostModes.delete(m[1]);
        this.vhostDomains.delete(m[1]);
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
    if (sub === 'inspect') return this.dockerInspect(args);
    if (sub === 'rename') {
      const [from, to, ...extra] = args;
      if (!from || !to || extra.length) throw new Error(`docker rename: ${args.join(' ')}`);
      if (!this.containers.has(from)) throw new Error(`No such container: ${from}`);
      if (this.containers.has(to)) throw new Error(`Conflict. The container name "/${to}" is already in use`);
      this.containers.set(to, this.containers.get(from)!);
      this.containers.delete(from);
      if (this.stopped.delete(from)) this.stopped.add(to);
      return '';
    }
    if (sub === 'exec') {
      // Ровно та форма, которой смена ключей спрашивает /health бота:
      // `docker exec <имя> node -e <скрипт>`. Прочее — отказ.
      const [name, bin, flag] = args;
      if (bin !== 'node' || flag !== '-e' || args.length !== 4) throw new Error(`docker exec: симулятор знает только node -e: ${args.join(' ')}`);
      if (!this.containers.has(name)) throw new Error(`No such container: ${name}`);
      if (this.stopped.has(name)) throw new Error(`Error response from daemon: container ${name} is not running`);
      if (!this.healthy(name, this.containers.get(name)!)) throw new Error('Command failed: exit status 1');
      return '';
    }
    if (sub === 'image') {
      const [verb, flag, format, ref, ...extra] = args;
      if (verb !== 'inspect' || flag !== '--format' || format !== '{{json .}}' || !ref || extra.length) {
        throw new Error(`docker image: симулятор знает только inspect --format {{json .}} <образ>: ${args.join(' ')}`);
      }
      const id = this.images.has(ref) ? ref : this.tags.get(ref);
      if (!id) throw new Error(`Error: No such image: ${ref}`);
      const repoTags = [...this.tags.entries()].filter(([, v]) => v === id).map(([t]) => t);
      return `${JSON.stringify({ Id: id, RepoTags: repoTags, Config: { Env: this.images.get(id)!.env } })}\n`;
    }
    throw new Error(`docker ${sub}: неизвестная подкоманда`);
  }

  /**
   * `docker inspect --format <шаблон> <имя>` — ровно та форма, которой
   * пробуждение спрашивает у контейнера его собственный порт.
   *
   * ГЛАВНОЕ СВОЙСТВО, И ОНО ИЗМЕРЕНО НА ЖИВОМ DOCKER (29.8.0, 23.09.2026), а не
   * предположено: у ОСТАНОВЛЕННОГО контейнера `.NetworkSettings.Ports` — пустой
   * объект `{}`, а `.HostConfig.PortBindings` держит `127.0.0.1:18999` как
   * держал. Сетевая песочница при остановке разбирается, запрошенная публикация
   * — нет.
   *
   * Для пробуждения это и есть вся разница между работающей починкой и мёртвой:
   * задание `wake` приходит к контейнеру, который СПИТ. Симулятор, отдающий порт
   * по обоим полям одинаково, зеленил бы реализацию, которая на машине продуктов
   * не восстановила бы ни одного порта.
   *
   * Голый `index` по отсутствующему отображению docker не прощает: на
   * остановленном контейнере
   * `{{ (index (index .NetworkSettings.Ports "3000/tcp") 0).HostPort }}` не
   * печатает пустую строку, а падает с «index of untyped nil» и rc=1 (тоже
   * замерено). Форма с `{{with}}` на том же месте отдаёт пустую строку и rc=0.
   * Симулятор воспроизводит обе.
   */
  private dockerInspect(args: string[]): string {
    const [flag, format, name, ...extra] = args;
    if (flag !== '--format' || !format || !name || extra.length) {
      throw new Error(`docker inspect: симулятор знает только --format <шаблон> <имя>: ${args.join(' ')}`);
    }
    // Живой docker на несуществующем объекте отвечает именно так и rc=1.
    if (!this.containers.has(name)) throw new Error(`Error: No such object: ${name}`);

    if (format === '{{json .}}') {
      return `${JSON.stringify(this.inspectWhole(name))}\n`;
    }

    const fromBindings = format.includes('.HostConfig.PortBindings');
    const fromNetwork = format.includes('.NetworkSettings.Ports');
    if (!fromBindings && !fromNetwork) {
      throw new Error(`docker inspect: симулятор не знает шаблона ${format}`);
    }

    const publish = this.containers.get(name)!.publish;
    // '127.0.0.1:8001:3000' → '8001'. У бота публикации нет вовсе.
    const bound = publish ? publish.split(':')[1] : '';
    const visible = fromBindings ? bound : this.stopped.has(name) ? '' : bound;
    if (visible) return `${visible}\n`;
    if (!format.includes('{{with')) {
      throw new Error(
        `template parsing error: template: :1:4: executing "" at <index (index ...) 0>: `
          + 'error calling index: index of untyped nil',
      );
    }
    return '\n';
  }

  /**
   * Контейнер целиком — в форме `docker inspect --format '{{json .}}'`.
   * Config.Env, как у docker: переменные образа, затем свои; своя с тем же
   * именем заменяет переменную образа (одна строка, новое значение).
   */
  private inspectWhole(name: string): any {
    const c = this.containers.get(name)!;
    const own = new Set(Object.keys(c.env));
    const imageEnv = (this.images.get(c.imageId ?? this.resolveImage(c.image))?.env ?? []).filter((e) => !own.has(e.slice(0, e.indexOf('='))));
    const [hostIp, hostPort, containerPort] = c.publish ? c.publish.split(':') : [];
    const [source, destination] = c.mount ? c.mount.split(':') : [];
    return {
      Name: `/${name}`,
      Image: c.imageId ?? this.resolveImage(c.image),
      Config: { Image: c.image, Env: [...imageEnv, ...Object.entries(c.env).map(([k, v]) => `${k}=${v}`)] },
      State: { Running: !this.stopped.has(name), Status: this.stopped.has(name) ? 'exited' : 'running' },
      HostConfig: {
        PortBindings: c.publish ? { [`${containerPort}/tcp`]: [{ HostIp: hostIp, HostPort: hostPort }] } : {},
        Memory: memoryBytes(c.memory),
        NanoCpus: c.cpus ? Math.round(Number(c.cpus) * 1e9) : 0,
        RestartPolicy: { Name: c.restart ?? '' },
        NetworkMode: 'bridge',
        Privileged: false,
      },
      Mounts: c.mount ? [{ Type: 'bind', Source: source, Destination: destination, RW: true }] : [],
    };
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

  /**
   * certbot в той форме, в какой его зовёт задание domain: `certonly` (выпуск
   * или расширение по `--cert-name`) и `delete`. Живой `certbot delete` по
   * отсутствующему имени отвечает «No certificate found with name …» и rc=1 —
   * на этом тексте отвязка отличает повтор от настоящего отказа.
   */
  private certbot(rest: string[]): string {
    const [sub, ...args] = rest;
    const at = args.indexOf('--cert-name');
    const name = at >= 0 ? args[at + 1] : undefined;
    if (!name) throw new Error(`certbot ${sub}: без --cert-name`);
    if (sub === 'certonly') {
      if (this.certbotFails !== null) throw new Error(this.certbotFails);
      this.certs.add(name);
      return '';
    }
    if (sub === 'delete') {
      if (!this.certs.has(name)) throw new Error(`No certificate found with name ${name}`);
      this.certs.delete(name);
      return '';
    }
    throw new Error(`certbot ${sub}: симулятор знает только certonly и delete`);
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
    let memory: string | undefined;
    let cpus: string | undefined;
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
      if (a.startsWith('--memory=')) { memory = a.slice('--memory='.length); continue; }
      if (a.startsWith('--cpus=')) { cpus = a.slice('--cpus='.length); continue; }
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
    this.containers.set(name, { mount, publish, env, image, imageId: this.resolveImage(image), cmd, restart, memory, cpus });
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

/** `--memory=1g` / `--memory=1073741824` → байты, как в HostConfig.Memory. */
function memoryBytes(raw: string | undefined): number {
  if (!raw) return 0;
  const m = /^(\d+(?:\.\d+)?)([kmg]?)$/i.exec(raw);
  if (!m) throw new Error(`--memory: непонятное значение ${raw}`);
  const mul = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2].toLowerCase() as '' | 'k' | 'm' | 'g'];
  return Math.round(Number(m[1]) * mul);
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
