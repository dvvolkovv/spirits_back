/**
 * Хостовые шаги провижининга: что агент делает на машине продуктов, получив
 * задание. Единственное место во всём куске, где код напрямую управляет Docker
 * и файловой системой, — и потому единственное, где чужой ввод стоит рядом с
 * правами root.
 *
 * Отношение к `scripts/product-provision.sh`: шаги те же и в том же порядке —
 * скрипт обкатан на двух живых продуктах. Отличия от черновика плана, все
 * намеренные и все по одной причине — **шелла здесь нет**.
 *
 * ## Почему не строки команд
 *
 * Черновик собирал команды склейкой: `-e ${k}='${v}'`. Слаг на сервере
 * проверен регуляркой, а имя и значение секрета вводит клиент в кабинете, и не
 * проверены ничем. Одинарная кавычка внутри значения закрывает открытую:
 * значение `a'; rm -rf /srv/products; echo '` превращает одну команду в три и
 * выполняет их от root. Имя секрета ломает то же самое дешевле — без единой
 * кавычки: имя `X -v /:/host -e Y` добавляет Docker'у флаг, и контейнер клиента
 * получает корень хоста. Ни то, ни другое не чинится экранированием кавычек:
 * чинится тем, что аргументы не проходят через шелл вовсе. Здесь всё —
 * `run(argv: string[])` поверх `execFile`, ровно как в `git.ts`, где по той же
 * причине не через шелл идёт сообщение коммита.
 *
 * Побочный выигрыш формы argv: значение секрета может содержать что угодно, в
 * том числе переводы строки, — приватный ключ уезжает в контейнер целым.
 * `--env-file` этого не умеет (перевод строки в значении там не экранируется, а
 * заводит НОВУЮ переменную — то есть даёт клиенту подменить наш `RUNNER_TOKEN`
 * содержимым своего секрета) и требует лишнего файла с секретами на диске.
 *
 * ## Почему не `$(cat /root/.secrets/claude-oauth-token)`
 *
 * Подстановка внутри двойных кавычек — это работа шелла, и работает она ровно
 * до первой ошибки: нет файла, нет прав, опечатка в пути — `cat` пишет в stderr,
 * подставляется пустая строка, `docker run` спокойно стартует с пустым
 * `CLAUDE_CODE_OAUTH_TOKEN`. Контейнер поднят, порт отвечает, health зелёный,
 * heartbeat доходит — продукт въезжает в `running` и не может сделать ни одного
 * хода. Отказ молча превращается в успех. Токен читается явным шагом и до любых
 * изменений на хосте: пустой — отказ, и отказываться ещё нечем.
 *
 * ## Почему `rm -rf` нет вообще
 *
 * `rm -rf /srv/products/${slug}` в обработчике ошибки опасен дважды. Во-первых,
 * слаг здесь не наш: он приехал по сети в задании. Пустой слаг даёт
 * `/srv/products/` — все продукты хоста; `..` даёт `/srv`. Проверка слага на
 * сервере этого не закрывает: она в другом процессе на другой машине, а платит
 * за неё эта. Слаг проверяется здесь, своей копией `SLUG_RE`, и проверяется
 * первым делом. Во-вторых, подчищать можно только своё: каталог мог
 * существовать ДО нас (повторная выдача задания, восстановленный руками
 * чекаут), и тогда `rm -rf` уносит работу клиента. Поэтому каталог и контейнер
 * проверяются на занятость до того, как что-либо создано, а удаляется только
 * то, что создано этим вызовом.
 *
 * ## Порядок подчистки
 *
 * Обратный созданию, и цепочка рвётся на первом отказе. Порядок не
 * косметический: контейнер — это то, что держит порт. `freePort` считает
 * свободным порт, которого нет в `docker ps`, поэтому снятый контейнер
 * возвращает порт в оборот. Если при этом остался vhost, домен снесённого
 * продукта начинает проксировать на порт, который достался ЧУЖОМУ продукту.
 * Поэтому vhost снимается первым, а если снять не удалось — контейнер не
 * трогаем: пусть висит и держит порт, это строго безопаснее. По той же логике
 * каталог не удаляется, пока жив контейнер, смонтированный на него.
 *
 * ## `sleep 12` из скрипта
 *
 * В скрипте между `docker run` и `product-vhost` стоит `sleep 12`. Он там не
 * «на всякий случай»: `docker run -d` возвращается, как только контейнер
 * создан, а внутри ещё должен отработать entrypoint, подняться pm2 и начать
 * слушать порт. vhost, заведённый раньше этого момента, ошибки не даёт — nginx
 * с `proxy_pass` на литеральный `127.0.0.1:PORT` перечитывает конфиг молча, —
 * и именно поэтому промах тихий: домен отдаёт 502, `promoteReady` не видит
 * публичного 200, продукт висит в `provisioning` до таймаута и падает, хотя
 * контейнер живой. Таймер тут — заглушка вместо условия, и он врёт в обе
 * стороны: двенадцать секунд впустую в норме и мало на загруженном хосте.
 * Заменено ожиданием по факту — опросом порта до первого ответа, как
 * `waitHealthy` в `deploy.ts`. Не дождались за отведённое время — это отказ
 * провижининга с подчисткой, а не vhost вслепую.
 */
import { execFile } from 'child_process';
import { connect } from 'net';
import { mkdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { join } from 'path';
import { promisify } from 'util';
import { ProductKind, skeletonFor } from './skeleton';

const execFileAsync = promisify(execFile);

/**
 * Копия серверной `SLUG_RE` (`src/products/provisioning.service.ts`). Копия, а
 * не импорт: раннер — отдельный пакет со своим tsconfig, и живёт он на чужой
 * машине. Дублирование здесь не небрежность, а суть: слаг приезжает по сети, и
 * доверять проверке, оставшейся на той стороне, нельзя именно там, где из слага
 * собирается путь для удаления и имя контейнера.
 *
 * Форма запрещает ровно то, что опасно: `/` и `..` (путь), пустую строку
 * (`/srv/products/` целиком), ведущий дефис (`docker rm -f -x` разберёт слаг как
 * флаг), пробелы и метасимволы.
 */
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/** Имя переменной окружения в том виде, в каком его примет sh внутри контейнера. */
const SECRET_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Переменные, которые задаём мы. Клиентский секрет с таким именем — это не
 * совпадение: `LINKEON_URL` увёл бы раннер продукта за заданиями на чужой
 * сервер вместе с токеном, `CHECKOUT_PATH` увёл бы его из чекаута,
 * `PRODUCT_START_SCRIPT` вернул бы сироту из-за pm2 через оболочку.
 */
const RESERVED_ENV = [
  'LINKEON_URL',
  'RUNNER_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'PRODUCT_START_SCRIPT',
  'CHECKOUT_PATH',
  'CLAUDE_BIN',
  'PORT',
  'HOME',
  'PATH',
  'NODE_OPTIONS',
];

/**
 * Точка входа продукта — ПУТЬ К ФАЙЛУ, а не команда.
 *
 * С командой (`npm start`) pm2 владеет оболочкой, а не node: при перезапуске
 * настоящий процесс выживает сиротой, держит порт и продолжает отвечать старым
 * кодом. Health-check тогда проверяет сироту, выкат считается удачным, а
 * автооткат не срабатывает никогда. Это уже стоило двух аварий, и один раз —
 * ровно на этом шаге: в провижининг уехало `PRODUCT_START_CMD` вместо
 * `PRODUCT_START_SCRIPT`, продукт при этом поднялся, а выкаты стали
 * фиктивными.
 */
const START_SCRIPT = 'server.js';
/** Путь, а не команда: ни пробелов, ни метасимволов, ни `npm`. */
const START_SCRIPT_RE = /^[A-Za-z0-9._/-]+$/;

/** Порт внутри контейнера. Снаружи он публикуется только у сайта. */
const CONTAINER_PORT = 3000;

const DEFAULTS = {
  productsDir: '/srv/products',
  image: 'linkeon-product:base',
  linkeonUrl: 'https://my.linkeon.io',
  oauthTokenPath: '/root/.secrets/claude-oauth-token',
  vhostBin: 'product-vhost',
  nginxConfDir: '/etc/nginx/sites-products',
  waitPortTimeoutMs: 60_000,
};

export interface ProvisionJob {
  slug: string;
  kind: ProductKind;
  name: string;
  runnerToken: string;
  secrets: Record<string, string>;
}

/** Запуск программы БЕЗ шелла. Возвращает stdout. */
export type Run = (argv: string[], opts?: { cwd?: string }) => Promise<string>;

export interface ProvisionDeps {
  run: Run;
  writeFiles: (dir: string, files: Record<string, string>) => Promise<void>;
  freePort: () => Promise<number>;
  /** Есть ли что-то по пути — файл, каталог, что угодно. */
  exists: (path: string) => Promise<boolean>;
  removeDir: (dir: string) => Promise<void>;
  readHostSecret: (path: string) => Promise<string>;
  /** Отвечает ли порт. Ожидание по факту вместо `sleep 12`. */
  waitPort: (port: number, timeoutMs: number) => Promise<boolean>;

  productsDir?: string;
  image?: string;
  linkeonUrl?: string;
  oauthTokenPath?: string;
  vhostBin?: string;
  nginxConfDir?: string;
  waitPortTimeoutMs?: number;
  /** Куда докладывать ход дела и, главное, что осталось на хосте после отказа. */
  onPhase?: (message: string) => void;
}

/** Что успели создать — в порядке создания. Подчистка идёт по этому списку назад. */
type Step = 'dir' | 'container' | 'vhost';

function validateSecrets(raw: Record<string, string> | undefined): Array<[string, string]> {
  const entries = Object.entries(raw ?? {});
  for (const [key, value] of entries) {
    if (!SECRET_KEY_RE.test(key)) {
      // Значение в сообщение не попадает: провижининг докладывается в кабинет
      // и в журнал, а секрет клиента там оказаться не должен.
      throw new Error(`имя секрета не годится: ${JSON.stringify(key)}`);
    }
    if (RESERVED_ENV.includes(key)) {
      throw new Error(`имя секрета занято переменной провижининга: ${key}`);
    }
    if (typeof value !== 'string') {
      throw new Error(`значение секрета ${key} не строка`);
    }
    // Нулевой байт argv не переживёт (execFile отвергает его сам, но невнятно),
    // а перевод строки — переживёт, и это важно: приватные ключи многострочные.
    if (value.includes('\0')) {
      throw new Error(`значение секрета ${key} содержит нулевой байт`);
    }
  }
  return entries;
}

function dockerRunArgv(
  job: ProvisionJob,
  dir: string,
  port: number | undefined,
  oauthToken: string,
  secrets: Array<[string, string]>,
  cfg: { image: string; linkeonUrl: string },
): string[] {
  const argv = [
    'docker',
    'run',
    '-d',
    '--name',
    job.slug,
    '--restart',
    'unless-stopped',
    '-v',
    `${dir}:/product`,
  ];
  // Порт публикуется только у сайта, и только на петлю: снаружи продукт виден
  // через nginx. У бота публикации нет вовсе — ему незачем быть доступным по
  // адресу хоста, он сам ходит в Telegram.
  if (port !== undefined) argv.push('-p', `127.0.0.1:${port}:${CONTAINER_PORT}`);
  for (const [key, value] of secrets) argv.push('-e', `${key}=${value}`);
  argv.push('-e', `LINKEON_URL=${cfg.linkeonUrl}`);
  argv.push('-e', `RUNNER_TOKEN=${job.runnerToken}`);
  argv.push('-e', `CLAUDE_CODE_OAUTH_TOKEN=${oauthToken}`);
  argv.push('-e', `PRODUCT_START_SCRIPT=${START_SCRIPT}`);
  argv.push('-e', `PORT=${CONTAINER_PORT}`);
  argv.push('--memory=1g', '--cpus=1', cfg.image);
  return argv;
}

async function containerTaken(deps: ProvisionDeps, slug: string): Promise<boolean> {
  // `-a`: остановленный контейнер с этим именем так же занимает имя, и
  // `docker run` на него споткнётся.
  const out = await deps.run([
    'docker',
    'ps',
    '-a',
    '--filter',
    `name=^${slug}$`,
    '--format',
    '{{.Names}}',
  ]);
  return out
    .split('\n')
    .map((line) => line.trim())
    .includes(slug);
}

/**
 * Снимает за собой всё, что успел создать этот вызов, — и ничего сверх того.
 *
 * Возвращает список того, что снять не удалось. Пустой список — на хосте
 * чисто, слаг и порт снова свободны.
 */
async function cleanup(
  done: Step[],
  job: ProvisionJob,
  dir: string,
  deps: ProvisionDeps,
): Promise<string[]> {
  const nginxConfDir = deps.nginxConfDir ?? DEFAULTS.nginxConfDir;
  const left: string[] = [];

  if (done.includes('vhost')) {
    try {
      await deps.run(['rm', '-f', `${nginxConfDir}/${job.slug}.conf`]);
      // Файл убран, но vhost жив до перечитывания конфига — отказ reload
      // означает, что домен всё ещё смотрит на порт.
      await deps.run(['nginx', '-s', 'reload']);
    } catch (e: any) {
      left.push(`vhost ${job.slug} (${e?.message ?? e})`);
      // Дальше не идём сознательно: снять сейчас контейнер — значит вернуть
      // порт в оборот под живым vhost, и следующий продукт окажется доступен
      // по чужому домену.
      left.push(`контейнер ${job.slug} и ${dir} оставлены нарочно: порт держит живой vhost`);
      return left;
    }
  }

  if (done.includes('container')) {
    try {
      // Спрашиваем, есть ли что снимать, вместо `docker rm -f … || true`:
      // шаг помечен сделанным ДО запуска docker run, и в самом частом случае
      // (docker run отказал, не создав контейнера) `docker rm -f` завершится
      // ошибкой «No such container». С `|| true` это проглотилось бы вместе с
      // настоящими отказами, а без него — рвало бы цепочку и оставляло каталог
      // на каждом неудачном провижининге.
      if (await containerTaken(deps, job.slug)) {
        await deps.run(['docker', 'rm', '-f', job.slug]);
      }
    } catch (e: any) {
      left.push(`контейнер ${job.slug} (${e?.message ?? e})`);
      // Удалять каталог из-под живого контейнера нельзя: он останется
      // смонтированным на удалённый inode и продолжит отвечать из пустоты.
      left.push(`${dir} оставлен нарочно: на него смонтирован живой контейнер`);
      return left;
    }
  }

  if (done.includes('dir')) {
    try {
      await deps.removeDir(dir);
    } catch (e: any) {
      left.push(`${dir} (${e?.message ?? e})`);
    }
  }

  return left;
}

/**
 * Заводит продукт на хосте: чекаут с каркасом, первый коммит, контейнер, а для
 * сайта — публикация порта и vhost.
 *
 * Любой отказ подчищается: иначе слаги и порты кончаются молча — каталог
 * занят, контейнер висит, а продукт числится незаведённым.
 */
export async function provision(job: ProvisionJob, deps: ProvisionDeps): Promise<{ port?: number }> {
  const phase = deps.onPhase ?? (() => {});
  const productsDir = deps.productsDir ?? DEFAULTS.productsDir;
  const cfg = {
    image: deps.image ?? DEFAULTS.image,
    linkeonUrl: deps.linkeonUrl ?? DEFAULTS.linkeonUrl,
  };

  // --- Всё, что может отказать, — до первого изменения на хосте. ---
  if (!SLUG_RE.test(job.slug)) {
    throw new Error(`слаг не годится: ${JSON.stringify(job.slug)}`);
  }
  if (job.kind !== 'site' && job.kind !== 'bot') {
    throw new Error(`неизвестная форма продукта: ${JSON.stringify(job.kind)}`);
  }
  if (!job.runnerToken) {
    throw new Error('в задании нет токена раннера — продукт не получит ни одной задачи');
  }
  const secrets = validateSecrets(job.secrets);

  const files = skeletonFor(job.kind, job.name, job.slug);
  if (!(START_SCRIPT in files) || !START_SCRIPT_RE.test(START_SCRIPT)) {
    throw new Error(
      `PRODUCT_START_SCRIPT=${START_SCRIPT} — не файл каркаса: pm2 получит оболочку вместо процесса`,
    );
  }

  const oauthToken = (await deps.readHostSecret(deps.oauthTokenPath ?? DEFAULTS.oauthTokenPath)).trim();
  if (!oauthToken) {
    throw new Error('токен Claude на хосте пуст — контейнер поднялся бы, но не сделал бы ни хода');
  }

  const dir = `${productsDir}/${job.slug}`;
  if (await deps.exists(dir)) {
    // Отказ, а не «допишем поверх»: там может быть чекаут с правками клиента,
    // и подчистка унесла бы его.
    throw new Error(`${dir} уже занят — провижининг ничего не трогал`);
  }
  if (await containerTaken(deps, job.slug)) {
    throw new Error(`контейнер ${job.slug} уже есть — провижининг ничего не трогал`);
  }

  const port = job.kind === 'site' ? await deps.freePort() : undefined;

  // --- Дальше каждый шаг оставляет след, который надо будет снять. ---
  const done: Step[] = [];
  try {
    // Пометка ДО действия: writeFiles и docker run отказывают на середине —
    // каталог создан и пуст, контейнер создан и не стартовал. Пометка после
    // действия оставила бы ровно эти случаи неубранными.
    done.push('dir');
    await deps.writeFiles(dir, files);

    // Первый коммит обязателен до контейнера: entrypoint отказывается стартовать
    // без .git в чекауте, потому что без него не работает откат.
    await deps.run(['git', 'init', '-q'], { cwd: dir });
    await deps.run(['git', 'config', 'user.email', 'assistant@linkeon.io'], { cwd: dir });
    await deps.run(['git', 'config', 'user.name', 'Linkeon Assistant'], { cwd: dir });
    await deps.run(['git', 'add', '-A'], { cwd: dir });
    await deps.run(['git', 'commit', '-q', '-m', 'первичный каркас продукта'], { cwd: dir });
    // Агент внутри контейнера работает не от root (uid 1000): без этого он не
    // запишет в чекаут ни строчки.
    await deps.run(['chown', '-R', '1000:1000', dir]);
    phase(`чекаут ${dir} создан`);

    done.push('container');
    await deps.run(dockerRunArgv(job, dir, port, oauthToken, secrets, cfg));
    phase(`контейнер ${job.slug} поднят`);

    if (port !== undefined) {
      const timeoutMs = deps.waitPortTimeoutMs ?? DEFAULTS.waitPortTimeoutMs;
      if (!(await deps.waitPort(port, timeoutMs))) {
        throw new Error(
          `продукт не занял порт ${port} за ${Math.round(timeoutMs / 1000)} с — vhost смотрел бы в пустоту`,
        );
      }
      done.push('vhost');
      await deps.run([deps.vhostBin ?? DEFAULTS.vhostBin, job.slug, String(port)]);
      phase(`vhost ${job.slug} на порт ${port} заведён`);
    }

    return { port };
  } catch (e: any) {
    const left = await cleanup(done, job, dir, deps);
    if (left.length) {
      // Про остатки обязан узнать человек: слаг и порт после этого не свободны,
      // а повтор провижининга упрётся в занятое имя.
      phase(`ВНИМАНИЕ, на хосте осталось: ${left.join('; ')}`);
      if (e instanceof Error) (e as any).leftovers = left;
    } else {
      phase(`провижининг отменён, на хосте чисто: ${e?.message ?? e}`);
    }
    throw e;
  }
}

/**
 * Настоящие реализации для хоста продуктов. Всё общение с системой — здесь, и
 * больше нигде: сам `provision` ничего не импортирует из `child_process` и `fs`.
 */
export function hostDeps(overrides: Partial<ProvisionDeps> = {}): ProvisionDeps {
  // Собирается одним объектом, а не «база плюс переопределения»: freePort
  // пользуется run, и он обязан звать тот run, который в итоге оказался в
  // объекте, а не тот, что был в базе до подмены.
  const deps: ProvisionDeps = {
    // execFile, а не exec: см. шапку файла. Аргументы уезжают в программу как
    // есть, шелла в цепочке нет.
    run: async (argv: string[], opts?: { cwd?: string }) => {
      const [bin, ...args] = argv;
      const { stdout } = await execFileAsync(bin, args, {
        cwd: opts?.cwd,
        maxBuffer: 16 * 1024 * 1024,
      });
      return stdout;
    },

    writeFiles: async (dir: string, files: Record<string, string>) => {
      await mkdir(dir, { recursive: true });
      for (const [name, content] of Object.entries(files)) {
        await writeFile(join(dir, name), content, 'utf8');
      }
    },

    exists: async (path: string) => {
      try {
        await stat(path);
        return true;
      } catch {
        return false;
      }
    },

    removeDir: async (dir: string) => {
      await rm(dir, { recursive: true, force: true });
    },

    readHostSecret: async (path: string) => readFile(path, 'utf8'),

    /**
     * Свободный порт — тот, которого нет среди опубликованных у запущенных
     * контейнеров. Диапазон и способ те же, что в обкатанном скрипте.
     */
    freePort: async () => {
      const out = await deps.run(['docker', 'ps', '--format', '{{.Ports}}']);
      for (let port = 8001; port <= 8099; port++) {
        if (!out.includes(`:${port}->`)) return port;
      }
      throw new Error('свободных портов в диапазоне 8001-8099 нет');
    },

    waitPort: async (port: number, timeoutMs: number) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (await probe(port)) return true;
        if (Date.now() >= deadline) return false;
        await new Promise((r) => setTimeout(r, 500));
      }
    },
  };
  Object.assign(deps, overrides);
  return deps;
}

function probe(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' });
    const finish = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1000);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}
