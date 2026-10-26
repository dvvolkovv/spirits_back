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
 * ## `sleep 12` из скрипта, и почему опрос ПОРТА его не заменяет
 *
 * В скрипте между `docker run` и `product-vhost` стоит `sleep 12`. Он там не
 * «на всякий случай»: `docker run -d` возвращается, как только контейнер
 * создан, а внутри ещё должен отработать entrypoint, подняться pm2 и начать
 * слушать приложение. vhost, заведённый раньше этого момента, ошибки не даёт —
 * `proxy_pass` на литеральный `127.0.0.1:PORT` nginx принимает молча, — и
 * именно поэтому промах тихий: домен отдаёт 502, `promoteReady` не видит
 * публичного 200, продукт висит в `provisioning` до таймаута и падает, хотя
 * контейнер живой. Таймер тут — заглушка вместо условия, и врёт он в обе
 * стороны: двенадцать секунд впустую в норме и мало на загруженном хосте.
 *
 * Заменено ожиданием по факту. **Но спрашивать порт нельзя**, и это не теория:
 * порт хоста занимает `docker-proxy`, и занимает в момент `docker run` —
 * задолго до того, как внутри контейнера что-нибудь поднимется. Замерено на
 * живом докере с умолчаниями (`EnableUserlandProxy: true`):
 *
 *     docker run -d -p 127.0.0.1:18099:3000 redis:7-alpine sh -c 'sleep 60'
 *     connect 127.0.0.1:18099 → CONNECT OK
 *
 * Внутри не слушает никто, а TCP-connect проходит. Первая редакция этого файла
 * именно так и проверяла — и получался `sleep 0`, строго хуже заменённого
 * `sleep 12`, с тем же тихим промахом. Поэтому `probe` спрашивает
 * `GET /health` и требует 200 с полем `sha`, как `checkHealth` в `deploy.ts`:
 * пустую трубу docker-proxy от поднявшегося продукта отличает только ответ
 * самого приложения. Не дождались за отведённое время — отказ провижининга с
 * подчисткой, а не vhost вслепую.
 *
 * ## Что проверено на живом хосте, а не предположено
 *
 * `product-vhost` (`/usr/local/bin/product-vhost` на хосте продуктов) прочитан
 * целиком, а не угадан по имени: подчистка обязана снимать ровно тот файл,
 * который он пишет, иначе отрапортует «на хосте чисто» при живом домене.
 * Оттуда три факта, на которых стоит этот файл:
 *
 * - конфиг называется `/etc/nginx/sites-products/<slug>.conf` — то же имя,
 *   которое удаляет `cleanup`;
 * - перечитывает он `systemctl reload nginx`, и подчистка зовёт то же самое:
 *   механизм, которым конфиг завели, — тот же, которым его снимают;
 * - TLS берётся из общего `snippets/products-ssl.conf`, сертификат на каждый
 *   продукт не выпускается. Значит `sleep 12` ждал именно приложение, а не
 *   валидацию сертификата, — и ожидание по факту заменяет его полностью.
 *
 * Ещё оттуда: `nginx -t … && systemctl reload nginx` стоит ПОСЛЕ записи файла,
 * то есть при отказе проверки конфиг уже лежит, а nginx ещё не перечитан.
 * Ровно этот случай и разбирает подчистка.
 */
import { execFile } from 'child_process';
import { lstat, mkdir, readFile, realpath, rm, stat, writeFile } from 'fs/promises';
import { join } from 'path';
import { promisify } from 'util';
import { ProductKind, skeletonFor } from './skeleton';
import { assertDomainName, vhostArgv } from './vhost';

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
  // Дальше — не наши переменные, а те, что меняют поведение процессов
  // платформы в контейнере. Окружение у раннера, ассистента правок (claude),
  // pm2 и git общее с продуктом: прокси увёл бы запросы ассистента вместе с
  // OAuth-токеном на чужой адрес, BASH_ENV подсунул бы свой файл в каждую
  // команду ассистента.
  'SHELL',
  'USER',
  'BASH_ENV',
  'ENV',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  // Настройки самого раннера (src/config.ts). `POLL_INTERVAL_MS=5m` из ключа,
  // заведённого для кода продукта, дал бы NaN — и опрос сервера почти без
  // паузы; TURN_TIMEOUT_MS длиннее серверных 30 минут — отчёт по ходу,
  // который сервер уже снял. Что раннер читает из окружения, сторожит тест.
  'POLL_INTERVAL_MS',
  'TURN_TIMEOUT_MS',
  'POLL_TIMEOUT_MS',
  'REQUEST_TIMEOUT_MS',
  // Владелец бота (очередь 2): Telegram-идентификатор, который кладёт сама
  // платформа из привязки владельца. Ключ клиента с этим именем подменил бы,
  // кому бот отвечает данными владельца. Третья копия — secret-rules.ts на
  // сервере и secretNames.ts в кабинете.
  'OWNER_TG_ID',
];

/**
 * Занятые целиком семейства. ANTHROPIC_* и CLAUDE_* читает ассистент правок
 * (ANTHROPIC_BASE_URL — тот же увод запросов с токеном, что и прокси), NODE_* —
 * node раннера и самого claude (NODE_TLS_REJECT_UNAUTHORIZED,
 * NODE_EXTRA_CA_CERTS), NPM_CONFIG_* — npm, LD_* — загрузчик, GIT_* — git
 * раннера, PM2_* — pm2, SSL_* — проверку сертификатов. DOTENV_* читает
 * `dotenv/config` на старте раннера: DOTENV_CONFIG_PATH на файл из чекаута
 * подмешал бы в окружение раннера — а с ним и ассистента — что угодно, хоть
 * ANTHROPIC_BASE_URL.
 */
const RESERVED_ENV_PREFIXES = ['ANTHROPIC_', 'CLAUDE_', 'NODE_', 'NPM_CONFIG_', 'LD_', 'GIT_', 'PM2_', 'SSL_', 'DOTENV_'];

/** Законное имя внутри занятого семейства: режим node для кода продукта. */
const RESERVED_ENV_EXCEPTIONS = ['NODE_ENV'];

/**
 * Занято ли имя. Без учёта регистра: `https_proxy` и `npm_config_registry`
 * читают в нижнем регистре так же, как в верхнем.
 *
 * ТРИ КОПИИ ОДНОЙ ПРОВЕРКИ. Эта — последний рубеж перед `docker run -e`.
 * Вторая — `isReservedSecretName` на сервере (`src/products/secret-rules.ts`):
 * она отвечает 400 до записи продукта. Третья — в форме кабинета
 * (`spirits_front/src/components/products/secretNames.ts`), ради объяснения на
 * месте. Разъехаться им нельзя: имя, которое сервер принял, а хост отверг,
 * роняет заведение в failed уже после записи продукта — так и было, пока
 * проверка жила только здесь.
 */
export function isReservedEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  if (RESERVED_ENV_EXCEPTIONS.includes(upper)) return false;
  return RESERVED_ENV.includes(upper) || RESERVED_ENV_PREFIXES.some((p) => upper.startsWith(p));
}

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

/**
 * Порт внутри контейнера. Снаружи он публикуется только у сайта.
 *
 * Экспортируется ради sleep.ts по той же причине, что и DEFAULTS ниже:
 * пробуждение спрашивает у docker публикацию ИМЕННО этого порта
 * (`HostConfig.PortBindings["3000/tcp"]`), и копия числа там однажды разошлась
 * бы с этой — восстановление порта молча перестало бы находить хоть что-то, а
 * обе батареи остались бы зелёными.
 */
export const CONTAINER_PORT = 3000;

// Экспортируется ради sleep.ts: имя программы vhost и срок ожидания порта
// обязаны быть ОДНИ на заведение и на пробуждение. Две копии однажды
// разошлись бы, и пробуждение звало бы не тот скрипт (или ждало не столько),
// оставаясь при этом зелёным в обеих батареях.
export const DEFAULTS = {
  productsDir: '/srv/products',
  image: 'linkeon-product:base',
  linkeonUrl: 'https://my.linkeon.io',
  oauthTokenPath: '/root/.secrets/claude-oauth-token',
  vhostBin: 'product-vhost',
  nginxConfDir: '/etc/nginx/sites-products',
  waitPortTimeoutMs: 60_000,
  /** Сколько ждать один ответ /health, прежде чем считать пробу неудачной. */
  probeTimeoutMs: 2_000,
  /** Пауза между пробами. */
  probeEveryMs: 500,
  /**
   * Срок ОДНОЙ программы. Довод тот же, что у таймаутов HTTP в api.ts: без
   * срока заклинивший `docker run` (замерший dockerd, отвалившееся сетевое
   * монтирование) вешает единственного агента машины навсегда — процесс жив,
   * просто ничего не делает, продукты не заводятся, и в журнале при этом ни
   * строки.
   *
   * Срок стоит ЗДЕСЬ, а не только общим сроком снаружи, по одной причине:
   * снятый по сроку шаг — это обычный отказ шага, его ловит catch в
   * `provision`, и хост подчищается ровно так же, как при любом другом отказе.
   * Внешний срок отменить ничего не может и оставляет состояние хоста
   * неизвестным.
   *
   * Пять минут — с запасом на `docker run` с вытягиванием образа по медленному
   * каналу и заметно меньше серверного срока заведения в 10 минут.
   */
  runTimeoutMs: 300_000,
};

export interface ProvisionJob {
  slug: string;
  kind: ProductKind;
  name: string;
  runnerToken: string;
  secrets: Record<string, string>;
  /**
   * Свои имена продукта. Сервер кладёт их в КАЖДОЕ задание: повтор заведения
   * поверх продукта с живым своим доменом без них переписал бы конфиг и снял
   * бы домен клиента. Необязательное — сервер старше агента поля не шлёт.
   */
  customNames?: string[];
  /**
   * Telegram-идентификатор владельца — только у бота и только при привязанном
   * Telegram (очередь 2). Уходит в окружение `OWNER_TG_ID`, чтобы бот узнавал
   * владельца сам, без chat_id в тексте правки. Необязательное: сервер старше
   * агента поля не шлёт, а у владельца без привязки его нет.
   */
  ownerTgId?: string;
}

/** Что лежит по пути без перехода по ссылке (ProvisionDeps.pathKind). */
export type PathKind = 'absent' | 'dir' | 'symlink' | 'other';

/** Запуск программы БЕЗ шелла. Возвращает stdout. */
export type Run = (argv: string[], opts?: { cwd?: string }) => Promise<string>;

export interface ProvisionDeps {
  run: Run;
  writeFiles: (dir: string, files: Record<string, string>) => Promise<void>;
  freePort: () => Promise<number>;
  /** Есть ли что-то по пути — файл, каталог, что угодно. */
  exists: (path: string) => Promise<boolean>;
  removeDir: (dir: string) => Promise<void>;
  /**
   * Настоящий путь, как `fs.realpath`: ссылки раскрыты, `..` снят; нет пути —
   * отказ с кодом ENOENT. Нужен стиранию (purge.ts): удаляется ровно
   * `/srv/products/<слаг>`, а не то, куда ведёт ссылка по дороге. Обязательное,
   * а не с умолчанием на fs: забытое в сборке зависимостей, оно молча шло бы
   * по настоящей ФС — и из тестов на симуляторе тоже.
   */
  realpath: (path: string) => Promise<string>;
  /**
   * Что лежит по пути, как `lstat`, — БЕЗ перехода по ссылке: битая ссылка —
   * это 'symlink', а не «ничего нет». Нет пути — 'absent'; любой другой отказ
   * (ENOTDIR, EACCES) — исключение. Нужен стиранию (purge.ts): «каталога уже
   * нет» и «на месте каталога ссылка» обязаны различаться. Обязательное — по
   * той же причине, что realpath.
   */
  pathKind: (path: string) => Promise<PathKind>;
  readHostSecret: (path: string) => Promise<string>;
  /** Отвечает ли порт. Ожидание по факту вместо `sleep 12`. */
  waitPort: (port: number, timeoutMs: number) => Promise<boolean>;
  /**
   * Ответил ли продукт на /health ИЗНУТРИ контейнера (бот порта не публикует).
   * Необязательное: по умолчанию — `docker exec … node -e` через этот же run
   * (rekey.ts, waitInsideVia), подмена — только для тестов.
   */
  waitInside?: (slug: string, timeoutMs: number) => Promise<boolean>;
  /**
   * Пауза смены ключей перед повторным взглядом (rekey.ts): второй ответ
   * /health нового контейнера и состояние старого после отката. По умолчанию
   * 3 с — как `sleep 3` в do_restore product-image-roll.sh; ноль — в тестах.
   */
  settleMs?: number;

  productsDir?: string;
  image?: string;
  linkeonUrl?: string;
  oauthTokenPath?: string;
  vhostBin?: string;
  nginxConfDir?: string;
  waitPortTimeoutMs?: number;
  /** Срок одной программы. См. DEFAULTS.runTimeoutMs. */
  runTimeoutMs?: number;
  /** Куда докладывать ход дела и, главное, что осталось на хосте после отказа. */
  onPhase?: (message: string) => void;
}

/** Что успели создать — в порядке создания. Подчистка идёт по этому списку назад. */
type Step = 'dir' | 'container' | 'vhost';

// Экспорт — ради rekey.ts и purge.ts: проверка одна на все хостовые шаги.
export function validateSecrets(raw: Record<string, string> | undefined): Array<[string, string]> {
  const entries = Object.entries(raw ?? {});
  for (const [key, value] of entries) {
    if (!SECRET_KEY_RE.test(key)) {
      // Значение в сообщение не попадает: провижининг докладывается в кабинет
      // и в журнал, а секрет клиента там оказаться не должен.
      throw new Error(`имя секрета не годится: ${JSON.stringify(key)}`);
    }
    if (isReservedEnvName(key)) {
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

/** Идентификатор Telegram — целое число; 20 знаков с запасом над bigint. */
const OWNER_TG_ID_RE = /^\d{1,20}$/;

/**
 * OWNER_TG_ID для этого задания или undefined. Только боту: сайту владелец
 * в Telegram ни к чему, а лишняя переменная в общем окружении — лишнее, что
 * может прочитать код продукта. Не число — отказ: зовётся до первого
 * изменения на хосте. Экспорт — ради смены ключей (rekey.ts).
 *
 * Пустая строка — то же, что нет поля. Ею сервер говорит «привязки нет»:
 * смена ключей по ней СНИМАЕТ переменную, и эта ветка живёт в rekey.ts
 * отдельно, до вызова сюда. Заведению снимать нечего, а отказ на '' сорвал
 * бы заведение каждого бота, стоит серверу прислать её и при заведении.
 */
export function ownerTgIdFor(job: { kind: ProductKind; ownerTgId?: string | null }): string | undefined {
  if (job.kind !== 'bot' || job.ownerTgId === undefined || job.ownerTgId === null || job.ownerTgId === '') return undefined;
  if (typeof job.ownerTgId !== 'string' || !OWNER_TG_ID_RE.test(job.ownerTgId)) {
    throw new Error(`OWNER_TG_ID не число: ${JSON.stringify(job.ownerTgId)}`);
  }
  return job.ownerTgId;
}

function dockerRunArgv(
  job: ProvisionJob,
  dir: string,
  port: number | undefined,
  oauthToken: string,
  secrets: Array<[string, string]>,
  cfg: { image: string; linkeonUrl: string },
  ownerTgId?: string,
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
  if (ownerTgId !== undefined) argv.push('-e', `OWNER_TG_ID=${ownerTgId}`);
  argv.push('--memory=1g', '--cpus=1', cfg.image);
  return argv;
}

// Экспорт — ради rekey.ts и purge.ts: проверка одна на все хостовые шаги.
export async function containerTaken(deps: ProvisionDeps, slug: string): Promise<boolean> {
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
      // Тем же механизмом, которым product-vhost конфиг заводил: он читан на
      // хосте и делает `nginx -t … && systemctl reload nginx`.
      await deps.run(['systemctl', 'reload', 'nginx']);
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
  const ownerTgId = ownerTgIdFor(job);
  // Имена проверяются здесь же, до первого изменения: иначе мусорное имя
  // всплыло бы только на product-vhost — после `docker run`, ценой подчистки
  // исправного контейнера.
  for (const name of job.customNames ?? []) assertDomainName(name);

  // Имена ключей — в инструкцию ассистенту, значения — только в `-e` ниже.
  // Берутся из проверенного набора, а не из job.secrets: имя не по форме сюда
  // не доходит вовсе (validateSecrets уже бросил бы).
  const files = skeletonFor(job.kind, job.name, job.slug, secrets.map(([key]) => key));
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
    await deps.run(dockerRunArgv(job, dir, port, oauthToken, secrets, cfg, ownerTgId));
    phase(`контейнер ${job.slug} поднят`);

    if (port !== undefined) {
      const timeoutMs = deps.waitPortTimeoutMs ?? DEFAULTS.waitPortTimeoutMs;
      if (!(await deps.waitPort(port, timeoutMs))) {
        throw new Error(
          `продукт не ответил на http://127.0.0.1:${port}/health за ${Math.round(timeoutMs / 1000)} с`
            + ' — vhost смотрел бы в пустоту',
        );
      }
      done.push('vhost');
      await deps.run(vhostArgv(deps.vhostBin ?? DEFAULTS.vhostBin, job.slug, port, job.customNames ?? []));
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
      // Срок читается из deps, а не из замыкания над DEFAULTS: hostDeps
      // собирает объект и лишь затем накладывает overrides, и брать значение
      // надо в момент ВЫЗОВА — иначе подмена в тестах и на стенде молча не
      // действует (та же причина, по которой freePort зовёт deps.run).
      const timeout = deps.runTimeoutMs ?? DEFAULTS.runTimeoutMs;
      try {
        const { stdout } = await execFileAsync(bin, args, {
          cwd: opts?.cwd,
          maxBuffer: 16 * 1024 * 1024,
          timeout,
          // SIGKILL, а не SIGTERM по умолчанию: снимаем мы именно ЗАКЛИНИВШИЙ
          // шаг, а он по определению может не отреагировать на вежливый
          // сигнал — и тогда срок не сработал бы вовсе.
          killSignal: 'SIGKILL',
        });
        return stdout;
      } catch (e: any) {
        // Снятое по сроку отличается от «программа вернула ошибку» только
        // полем killed: сообщение у обоих начинается с «Command failed». Без
        // этой строки владелец читает в карточке отказ без причины там, где
        // причина — зависший шаг.
        if (e?.killed) {
          throw new Error(
            `${bin} не уложился в ${Math.round(timeout / 1000)} с и снят по сроку: ${e.message}`,
          );
        }
        throw e;
      }
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
      // Ссылки внутри каталога (их может завести код продукта — каталог
      // смонтирован в контейнер на запись) `rm` удаляет как ссылки и по ним не
      // ходит: проверено на настоящей ФС в purge.spec.ts.
      await rm(dir, { recursive: true, force: true });
    },

    realpath: (path: string) => realpath(path),

    pathKind: async (path: string) => {
      try {
        const st = await lstat(path);
        return st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'dir' : 'other';
      } catch (e: any) {
        if (e?.code === 'ENOENT') return 'absent';
        throw e;
      }
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
        await new Promise((r) => setTimeout(r, DEFAULTS.probeEveryMs));
      }
    },
  };
  Object.assign(deps, overrides);
  return deps;
}

/**
 * Поднялся ли ПРОДУКТ на порту — не «принимает ли кто-нибудь соединение».
 *
 * Разница здесь не оттенок: порт держит docker-proxy с момента `docker run`, и
 * TCP-connect проходит, когда внутри контейнера ещё пусто (см. шапку файла).
 * Поэтому спрашиваем то единственное, что умеет ответить только само
 * приложение: `/health` с 200 и полем `sha`.
 *
 * Признака ровно два, и оба обязаны быть: код 200 (продукт на прогреве и
 * nginx отдают 502/503, и пускать на них домен нельзя) и разобранный JSON с
 * непустым `sha` (иначе на порту что-то постороннее).
 *
 * Отдельных проверок на `text/html` и `<!doctype`, которые есть в
 * `checkHealth`, здесь нет намеренно. Там они несут вес, потому что при
 * отсутствии ожидаемого sha любой 2xx считается здоровьем, и SPA-фолбэк с
 * index.html прошёл бы. Здесь требуется разбор JSON с полем `sha` — HTML этого
 * не переживает ни с каким заголовком, так что обе проверки не могли бы
 * изменить ни одного исхода. Мутация, снимающая их, и не краснела: это был
 * эквивалентный мутант, то есть строки, которые нечем измерить и незачем
 * держать. Проверено тестами «200 с HTML» и «HTML без content-type»: оба
 * остаются красными на любом HTML-ответе.
 *
 * Значение `sha` НЕ сверяется с коммитом каркаса. При выкате такая сверка
 * обязательна (`checkHealth` в `deploy.ts` ловит ею сироту, отвечающую старым
 * кодом), но здесь чекаут только что создан и в нём ровно один коммит —
 * сверять не с чем, а расхождение вычисления sha внутри контейнера стало бы
 * ложным отказом, который снёс бы исправно поднявшийся продукт.
 */
async function probe(port: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULTS.probeTimeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: controller.signal,
      redirect: 'manual',
    } as any);
    if (res.status !== 200) return false;
    const body = await res.text();
    let sha: unknown;
    try {
      sha = JSON.parse(body)?.sha;
    } catch {
      return false;
    }
    return typeof sha === 'string' && sha.length > 0;
  } catch {
    // Соединение отвергнуто, оборвано или молчит дольше отведённого: с той
    // стороны docker-proxy, а не продукт.
    return false;
  } finally {
    clearTimeout(timer);
  }
}
