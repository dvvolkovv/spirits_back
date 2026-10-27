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
import { createHash } from 'crypto';
import { posix } from 'path';
import { Script } from 'vm';
import { DEFAULTS, PathKind, ProvisionDeps } from './provision';

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
      /**
       * Полный идентификатор (64 hex), как `.ID` у `docker ps --no-trunc`.
       * Необязательный по той же причине, что imageId: контейнеры, положенные
       * в карту руками, получают его при первом спросе (idOf). Тест может
       * задать его сам — так строится сосед, чей id начинается со слага.
       */
      id?: string;
      restart?: string;
      /** Байты — уже проверенные и переведённые из `--memory=` в `dockerRun` (см. `parseMemory`). */
      memory?: number;
      /** NanoCPUs — уже проверенные и переведённые из `--cpus=` в `dockerRun` (см. `parseCpus`). */
      cpus?: number;
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
   * `probePort` (сайт). Моделирует код ВЛАДЕЛЬЦА продукта: он падает без
   * нужных ему ключей (например, без рабочего ключа платёжного API), а не
   * сам каркас. Плохой `BOT_TOKEN` сам по себе каркас бота НЕ валит: сервер
   * проверяет токен через `getMe` ДО того, как отдать его контейнеру, —
   * это тест на уровне `provision.ts`/`rekey.ts`, а не на этом правиле.
   * По умолчанию здоров любой запущенный; тест подменяет правило под свой
   * сценарий «нездоровых» ключей.
   */
  healthy: (name: string, c: { env: Record<string, string> }) => boolean = () => true;

  /**
   * Падает ли процесс контейнера сразу после старта (сосед съел память,
   * сломан entrypoint). Как у docker: `docker run`/`docker start` при этом
   * отвечают успехом — они отвечают за запуск процесса, а не за то, что он
   * удержался. Дальше по политике: с `--restart` docker крутит петлю
   * перезапусков (inspect — Running и Restarting, "restarting"), без неё
   * контейнер выходит ("exited"). По умолчанию не падает никто.
   */
  crashing: (name: string, c: { env: Record<string, string> }) => boolean = () => false;

  /**
   * Завести образ под меткой (или передвинуть метку на другой образ).
   *
   * Образы в Docker неизменяемы: один и тот же идентификатор не может
   * обзавестись другим окружением задним числом. Повторный вызов с тем же
   * `id`, но другим `env`, — ошибка заводящего теста, а не разрешённая
   * мутация: не отловленная здесь, она тихо переписала бы окружение образа
   * уже СОЗДАННЫХ контейнеров (inspectWhole читает его по `imageId` заново
   * при каждом inspect).
   */
  tagImage(tag: string, id: string, env: string[] = []): void {
    const existing = this.images.get(id);
    if (existing) {
      const same = existing.env.length === env.length && existing.env.every((e, i) => e === env[i]);
      if (!same) {
        throw new Error(`tagImage: образ ${id} уже заведён с другим окружением — образы в Docker неизменяемы`);
      }
    } else {
      this.images.set(id, { env: Object.freeze([...env]) as string[] });
    }
    this.tags.set(tag, id);
  }

  /**
   * Идентификатор по метке или идентификатору. Автозавод пустого образа —
   * ТОЛЬКО для `DEFAULTS.image`: это единственный образ, который заводящие
   * помощники спеков (`run()` и т.п.) используют без явного `tagImage`.
   * Любая другая незнакомая ссылка — отказ, как у живого docker: симулятор,
   * заводящий образ под любым именем, зеленил бы опечатку в `cfg.image`.
   */
  private resolveImage(ref: string): string {
    if (this.images.has(ref)) return ref;
    const id = this.tags.get(ref);
    if (id) return id;
    if (ref === DEFAULTS.image) {
      const fresh = `sha256:fake-${ref}`;
      this.tagImage(ref, fresh, []);
      return fresh;
    }
    throw new Error(`Unable to find image '${ref}' locally`);
  }

  /** Сайт отвечает на порту: запущенный (не в петле перезапусков) контейнер с этой публикацией и здоровый. */
  probePort(port: number): boolean {
    for (const [name, c] of this.containers) {
      if (this.stopped.has(name) || !c.publish) continue;
      if (Number(c.publish.split(':')[1]) === port) return this.stateOf(name) === 'running' && this.healthy(name, c);
    }
    return false;
  }

  /** Состояние как `.State.Status` у docker — с учётом `crashing` и политики перезапуска. */
  private stateOf(name: string): 'running' | 'restarting' | 'exited' {
    if (this.stopped.has(name)) return 'exited';
    const c = this.containers.get(name)!;
    if (!this.crashing(name, c)) return 'running';
    return (c.restart ?? 'no') === 'no' ? 'exited' : 'restarting';
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
   * Имена в сертификате (строка Domains у `certbot certificates`). Пишет их
   * certonly (из `-d`) или issueCert; сертификат, положенный в `certs` руками,
   * имён не имеет — и `certificates` на нём отказывает, а не выдумывает их.
   */
  certDomains = new Map<string, string[]>();

  /** Завести сертификат с именами — как после выпуска, но без задания domain. */
  issueCert(name: string, domains: string[]): void {
    this.certs.add(name);
    this.certDomains.set(name, [...domains]);
  }
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
      // `-f` обязателен (так зовут все хостовые шаги), `-v` — по желанию
      // (стирание снимает и анонимные тома). Ссылка — одна.
      const flags: string[] = [];
      let i = 0;
      while (i < args.length && args[i].startsWith('-')) flags.push(args[i++]);
      for (const f of flags) if (f !== '-f' && f !== '-v') throw new Error(`docker rm: неизвестный флаг ${f}`);
      if (!flags.includes('-f')) throw new Error(`docker rm без -f: ${args.join(' ')}`);
      const refs = args.slice(i);
      if (refs.length !== 1) throw new Error(`docker rm: симулятор снимает по одной ссылке: ${args.join(' ')}`);
      const name = this.resolveRef(refs[0]);
      if (!name || !this.containers.delete(name)) throw new Error(`No such container: ${refs[0]}`);
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
      const [name, bin, flag, script, ...extra] = args;
      if (bin !== 'node' || flag !== '-e' || script === undefined || extra.length) {
        throw new Error(`docker exec: симулятор знает только node -e: ${args.join(' ')}`);
      }
      if (!this.containers.has(name)) throw new Error(`No such container: ${name}`);
      const state = this.stateOf(name);
      if (state === 'exited') throw new Error(`Error response from daemon: container ${name} is not running`);
      if (state === 'restarting') {
        throw new Error(`Error response from daemon: Container ${name} is restarting, wait until the container is running`);
      }
      // `node -e` сперва КОМПИЛИРУЕТ скрипт и только потом выполняет его:
      // синтаксическая ошибка — exit 1 ДО того, как код владельца хоть раз
      // отработал. Ломаная строка HEALTH_INSIDE (задача 5 — rekey.ts)
      // обязана падать здесь же, а не тихо считаться здоровой правилом
      // `healthy`, которое моделирует только РАБОТАЮЩИЙ, но нездоровый код.
      try {
        // eslint-disable-next-line no-new -- компиляция без исполнения — весь смысл проверки.
        new Script(script);
      } catch {
        throw new Error('Command failed: exit status 1');
      }
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
    // Флаги — в любом порядке, как у docker; имя — одно.
    let format: string | undefined;
    let type: string | undefined;
    const names: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--format') format = args[++i];
      else if (args[i] === '--type') type = args[++i];
      else if (args[i].startsWith('-')) throw new Error(`docker inspect: неизвестный флаг ${args[i]}`);
      else names.push(args[i]);
    }
    if (!format || names.length !== 1) {
      throw new Error(`docker inspect: симулятор знает только [--type container] --format <шаблон> <имя>: ${args.join(' ')}`);
    }
    if (type !== undefined && type !== 'container') {
      throw new Error(`docker inspect --type ${type}: симулятор знает только --type container`);
    }
    const name = names[0];
    // Живой docker на несуществующем объекте отвечает именно так и rc=1;
    // с --type container — «No such container».
    if (!this.containers.has(name)) throw new Error(type ? `Error: No such container: ${name}` : `Error: No such object: ${name}`);

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
   *
   * Config.Env, как у живого docker: СНАЧАЛА переменные КОНТЕЙНЕРА (`-e`, в
   * порядке argv — ровно как docker кладёт их в Config.Env), ПОТОМ —
   * переменные ОБРАЗА, которые не переопределены. Переопределённая
   * переменная образа в списке не повторяется: она и так видна в своей
   * (контейнерной) позиции с новым значением.
   *
   * Mounts не показывает анонимный volume на `/product`, который живой
   * контейнер без `-v` получил бы от `VOLUME ["/product"]` в Dockerfile:
   * ни заведение, ни смена ключей его не читают, и усложнять симулятор
   * ради того, что никто не проверяет, — не повод.
   */
  private inspectWhole(name: string): any {
    const c = this.containers.get(name)!;
    const state = this.stateOf(name);
    const ownNames = new Set(Object.keys(c.env));
    const ownEnv = Object.entries(c.env).map(([k, v]) => `${k}=${v}`);
    const imageEnv = (this.images.get(c.imageId ?? this.resolveImage(c.image))?.env ?? []).filter(
      (e) => !ownNames.has(e.slice(0, e.indexOf('='))),
    );
    const [hostIp, hostPort, containerPort] = c.publish ? c.publish.split(':') : [];
    const [source, destination] = c.mount ? c.mount.split(':') : [];
    return {
      Name: `/${name}`,
      Image: c.imageId ?? this.resolveImage(c.image),
      Config: { Image: c.image, Env: [...ownEnv, ...imageEnv] },
      // Restarting вместе с Running=true — так docker показывает петлю
      // перезапусков (StateString: Running && Restarting → "restarting").
      State: { Running: state !== 'exited', Restarting: state === 'restarting', Status: state },
      HostConfig: {
        PortBindings: c.publish ? { [`${containerPort}/tcp`]: [{ HostIp: hostIp, HostPort: hostPort }] } : {},
        Memory: c.memory ?? 0,
        NanoCpus: c.cpus ?? 0,
        // Docker всегда отдаёт MaximumRetryCount (0 вне политики "on-failure");
        // Name "no" — ровно то, что видно у контейнера без --restart вовсе
        // (так лежат в карте только контейнеры, заведённые спеками руками).
        RestartPolicy: { Name: c.restart ?? 'no', MaximumRetryCount: 0 },
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
      // --expand с новым набором `-d`: в сертификате ровно эти имена.
      const domains = args.flatMap((a, i) => (a === '-d' && args[i + 1] ? [args[i + 1]] : []));
      this.issueCert(name, domains);
      return '';
    }
    if (sub === 'delete') {
      if (!this.certs.has(name)) throw new Error(`No certificate found with name ${name}`);
      this.certs.delete(name);
      this.certDomains.delete(name);
      return '';
    }
    if (sub === 'certificates') {
      // Форма certbot 2.x (cert_manager._describe_certs / _report_human_readable):
      // нет ни одного сертификата — «No certificates found.»; с --cert-name —
      // заголовок «matching» и только блок с ТОЧНО этим именем; rc=0 в обоих
      // случаях. Пустой ответ на машине с сертификатами замерен на certbot
      // 2.9.0 в отдельном каталоге конфигов.
      const dashes = '- '.repeat(39) + '-';
      if (this.certs.size === 0) return `\n${dashes}\nNo certificates found.\n${dashes}\n`;
      let block = '';
      if (this.certs.has(name)) {
        const domains = this.certDomains.get(name);
        if (!domains) throw new Error(`симулятор: у сертификата ${name} нет имён — заведите его через issueCert или certonly`);
        block =
          `  Certificate Name: ${name}\n    Serial Number: 3fa1\n    Key Type: ECDSA\n    Domains: ${domains.join(' ')}\n` +
          `    Expiry Date: 2027-01-20 10:00:00+00:00 (VALID: 85 days)\n` +
          `    Certificate Path: /etc/letsencrypt/live/${name}/fullchain.pem\n` +
          `    Private Key Path: /etc/letsencrypt/live/${name}/privkey.pem\n`;
      }
      return `\n${dashes}\nFound the following matching certs:\n${block}${dashes}\n`;
    }
    throw new Error(`certbot ${sub}: симулятор знает только certonly, delete и certificates`);
  }

  private idSeq = 0;

  /** Полный id контейнера (`.ID` у `docker ps --no-trunc`); выдаётся при первом спросе и переживает rename. */
  idOf(name: string): string {
    const c = this.containers.get(name);
    if (!c) throw new Error(`idOf: контейнера ${name} нет`);
    if (!c.id) c.id = createHash('sha256').update(`${name}#${++this.idSeq}`).digest('hex');
    return c.id;
  }

  /**
   * Ссылка на контейнер так, как её ищет docker (daemon.GetContainer):
   * полный id → точное имя → НАЧАЛО id (однозначное; иначе отказ). Последний
   * шаг и есть опасность снятия по имени: исчезнувшее имя из одних
   * шестнадцатеричных знаков находит соседа, чей id с него начинается.
   */
  private resolveRef(ref: string): string | undefined {
    const names = [...this.containers.keys()];
    const byId = names.find((n) => this.idOf(n) === ref);
    if (byId) return byId;
    if (this.containers.has(ref)) return ref;
    const byPrefix = names.filter((n) => this.idOf(n).startsWith(ref));
    if (byPrefix.length > 1) throw new Error(`Error response from daemon: multiple IDs found with provided prefix: ${ref}`);
    return byPrefix[0];
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
    let memory: number | undefined;
    let cpus: number | undefined;
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
      if (a === '-v') {
        const raw = args[++i];
        // Симулятор знает только простой bind-mount без опций — ровно так
        // его зовут заведение и смена ключей. `:ro`/`:rw` молча долетели бы
        // до inspectWhole и были бы обрезаны `split(':')` на первые две
        // части без единого предупреждения, что третья выброшена.
        if (!/^[^:]+:[^:]+$/.test(raw)) throw new Error(`docker run: неизвестная форма -v: ${raw}`);
        mount = raw;
        continue;
      }
      if (a === '-p') {
        const raw = args[++i];
        // Та же причина, что у -v: заведение и пробуждение публикуют порт
        // ровно в форме IP:HOST:CONTAINER — только её симулятор обязан знать.
        if (!/^\d{1,3}(?:\.\d{1,3}){3}:\d+:\d+$/.test(raw)) throw new Error(`docker run: неизвестная форма -p: ${raw}`);
        publish = raw;
        continue;
      }
      if (a === '-e') {
        const pair = args[++i];
        const eq = pair.indexOf('=');
        if (eq < 1) throw new Error(`-e без имени переменной: ${pair}`);
        // Docker берёт последнее значение, если имя повторилось.
        env[pair.slice(0, eq)] = pair.slice(eq + 1);
        continue;
      }
      if (a.startsWith('--memory=')) { memory = parseMemory(a.slice('--memory='.length)); continue; }
      if (a.startsWith('--cpus=')) { cpus = parseCpus(a.slice('--cpus='.length)); continue; }
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

  /**
   * `docker ps` в тех формах, что зовут хостовые шаги:
   *   - `--filter name=^<имя>$` — занято ли имя (containerTaken);
   *   - `--filter volume=<путь>` — кто смонтировал ровно этот путь. Как у
   *     docker (daemon/list.go): совпадение с источником bind-монтирования
   *     или с назначением, точное — замерено на docker 29.8.0: ни хвостовой
   *     слэш, ни родительский каталог не подходят;
   *   - без фильтра — перечень всех.
   * Шаблоны — `{{.Names}}` и `{{.ID}} {{.Names}}` (`--no-trunc` — полный id,
   * без него — 12 знаков). `-a` показывает и остановленные, без него —
   * только запущенные: разница существует со сна, и `containerTaken`
   * спрашивает с `-a` намеренно — имя занимает и погашенный контейнер.
   */
  private dockerPs(args: string[]): string {
    let all = false;
    let noTrunc = false;
    let filter = '';
    let format = '';
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-a') all = true;
      else if (args[i] === '--no-trunc') noTrunc = true;
      else if (args[i] === '--filter') filter = args[++i];
      else if (args[i] === '--format') format = args[++i];
      else throw new Error(`docker ps: неизвестный аргумент ${args[i]}`);
    }
    if (format !== '{{.Names}}' && format !== '{{.ID}} {{.Names}}') {
      throw new Error(`docker ps: симулятор знает только --format {{.Names}} и {{.ID}} {{.Names}}, а не ${format}`);
    }
    const visible = (n: string) => this.containers.has(n) && (all || this.isRunning(n));
    const line = (n: string) => (format === '{{.Names}}' ? n : `${noTrunc ? this.idOf(n) : this.idOf(n).slice(0, 12)} ${n}`);

    if (filter.startsWith('name=')) {
      const m = /^name=\^(.+)\$$/.exec(filter);
      if (!m) throw new Error(`docker ps: неожиданный фильтр ${filter}`);
      // Пустой ответ здесь — '\n', как было всегда: containerTaken читает оба.
      return visible(m[1]) ? `${line(m[1])}\n` : '\n';
    }
    let names: string[];
    if (!filter) {
      names = [...this.containers.keys()].filter(visible);
    } else if (filter.startsWith('volume=')) {
      const path = filter.slice('volume='.length);
      names = [...this.containers.entries()]
        .filter(([n, c]) => visible(n) && !!c.mount && c.mount.split(':').slice(0, 2).includes(path))
        .map(([n]) => n);
    } else {
      throw new Error(`docker ps: неожиданный фильтр ${filter}`);
    }
    return names.length ? `${names.map(line).join('\n')}\n` : '';
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
   * `fs.realpath` в мире без ссылок: путь нормализован, несуществующий —
   * ENOENT с тем же `code`, что у fs (по нему стирание отличает «каталога уже
   * нет» от «путь не прочитан»). Ссылки симулятор не изображает намеренно:
   * их проверяет purge.spec.ts на настоящей ФС, а выдуманная модель ссылок
   * проверяла бы выдумку.
   */
  realpath = async (path: string): Promise<string> => {
    const p = posix.resolve(path);
    if (!this.dirs.has(p) && !this.baseDirs.has(p)) {
      throw Object.assign(new Error(`ENOENT: no such file or directory, realpath '${path}'`), { code: 'ENOENT' });
    }
    return p;
  };

  /**
   * Каталоги, которые есть на хосте всегда, даже пустом: каталог продуктов
   * (`realpath` его стирание сверяет первым делом) и конфигов nginx. Тест
   * убирает отсюда, чтобы изобразить хост без каталога продуктов.
   */
  baseDirs = new Set<string>(['/', '/srv', DEFAULTS.productsDir, '/etc', '/etc/nginx', DEFAULTS.nginxConfDir]);

  /** `lstat` в мире без ссылок: каталог чекаута, файл конфига vhost или ничего. */
  pathKind = async (path: string): Promise<PathKind> => {
    const p = posix.resolve(path);
    if (this.dirs.has(p) || this.baseDirs.has(p)) return 'dir';
    const conf = new RegExp(`^${DEFAULTS.nginxConfDir}/([^/]+)\\.conf$`).exec(p);
    if (conf && this.confFiles.has(conf[1])) return 'other';
    return 'absent';
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

/** Единицы `--memory`, как у Docker (go-units `RAMInBytes`, бинарные степени 1024). */
const MEMORY_UNITS: Record<string, number> = {
  '': 1,
  b: 1,
  k: 1024,
  kb: 1024,
  kib: 1024,
  m: 1024 ** 2,
  mb: 1024 ** 2,
  mib: 1024 ** 2,
  g: 1024 ** 3,
  gb: 1024 ** 3,
  gib: 1024 ** 3,
};

/**
 * `--memory=1g` / `--memory=1073741824` → байты, как в HostConfig.Memory.
 * Отказ — ТЕКСТОМ, которым отвечает живой docker CLI на мусор в значении
 * (клиентская проверка флага, до обращения к daemon'у).
 */
function parseMemory(raw: string): number {
  const m = /^(\d+(?:\.\d+)?)([a-zA-Z]*)$/.exec(raw);
  const unit = m ? m[2].toLowerCase() : undefined;
  if (!m || unit === undefined || !(unit in MEMORY_UNITS)) {
    throw new Error(`invalid argument "${raw}" for "-m, --memory" flag: invalid size: '${raw}'`);
  }
  return Math.round(Number(m[1]) * MEMORY_UNITS[unit]);
}

/** Сколько CPU «есть» у симулированного хоста — предел для `--cpus`. */
const SIMULATED_HOST_CPUS = 4;

/**
 * `--cpus=1` → NanoCpus (целое, cpus × 1e9), как в HostConfig.NanoCpus.
 * Два разных отказа, как у живого docker: мусор в значении — клиентская
 * ошибка разбора флага; число вне диапазона — ответ daemon'а, знающего,
 * сколько CPU у хоста физически есть.
 */
function parseCpus(raw: string): number {
  if (!/^\d+(?:\.\d+)?$/.test(raw)) {
    throw new Error(`invalid argument "${raw}" for "--cpus" flag: strconv.ParseFloat: parsing "${raw}": invalid syntax`);
  }
  const value = Number(raw);
  if (value < 0.01 || value > SIMULATED_HOST_CPUS) {
    throw new Error(
      `Range of CPUs is from 0.01 to ${SIMULATED_HOST_CPUS.toFixed(2)}, as there are only ${SIMULATED_HOST_CPUS} CPUs available`,
    );
  }
  // Целое число nanocpus: ближайшее к value*1e9 отличается от самого value
  // не больше чем на 0.5e-9 CPU — глубже 1e-9 точности Docker и не считает.
  return Math.round(value * 1e9);
}

export const OAUTH = 'оаут-токен-хоста';

export function deps(host: FakeHost, over: Partial<ProvisionDeps> = {}): ProvisionDeps {
  return {
    run: host.run,
    writeFiles: host.writeFiles,
    exists: host.exists,
    removeDir: host.removeDir,
    realpath: host.realpath,
    pathKind: host.pathKind,
    freePort: host.freePort,
    readHostSecret: async () => `${OAUTH}\n`,
    waitPort: async () => true,
    productsDir: '/srv/products',
    nginxConfDir: '/etc/nginx/sites-products',
    ...over,
  };
}
