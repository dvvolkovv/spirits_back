/**
 * Правила ключей владельца продукта — ОДНО место на сервере.
 *
 * Их зовут двое: заведение (ProvisioningService.create — форма Студии и
 * карточка бота) и смена ключей (ProductKeysService, очередь 2). Пока правила
 * жили инлайном в create(), вторая точка входа была бы копией, а копии в этом
 * модуле расходятся молча: карточка пропустила бы имя, на котором заведение
 * отказывает, и отказ всплыл бы уже у агента машины, после пересоздания
 * контейнера.
 *
 * Имена секретов становятся переменными окружения контейнера: 'A B' и 'A=1'
 * там либо теряются, либо подменяют соседнюю переменную.
 *
 * Потолки набора: без них десять мегабайт уезжают в шифротекст, в строку
 * продукта, в тело задания и дальше в env контейнера — а предел размера
 * окружения живёт в ядре хоста (ARG_MAX), и отказ был бы на чужой машине без
 * объяснения. 8 КиБ на значение — с запасом под PEM (RSA-4096 около 3.2 КиБ)
 * и JSON сервис-аккаунта; 64 имени и 64 символа на имя — предел разумного.
 */
export const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const SECRET_NAME_MAX = 64;
export const SECRET_VALUE_MAX = 8192;
export const SECRET_COUNT_MAX = 64;

/**
 * Занятые имена — ТРИ КОПИИ ОДНОЙ ПРОВЕРКИ: эта, `isReservedEnvName` агента
 * машины (product-runner/src/host/provision.ts — там же объяснение каждого
 * имени, это последний рубеж перед `docker run -e`) и форма кабинета
 * (spirits_front/src/components/products/secretNames.ts). Разъехаться им
 * нельзя: имя, которое сервер принял, а агент отверг, роняет заведение или
 * смену ключей уже после записи. Сторож — общая таблица в трёх спеках.
 *
 * OWNER_TG_ID (очередь 2) — Telegram владельца, его кладёт в окружение бота
 * сама платформа. Ключ владельца с этим именем подменил бы, кому бот
 * отвечает данными владельца.
 */
const RESERVED_SECRET_NAMES = [
  'LINKEON_URL', 'RUNNER_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'PRODUCT_START_SCRIPT',
  'CHECKOUT_PATH', 'CLAUDE_BIN', 'PORT', 'HOME', 'PATH', 'NODE_OPTIONS',
  'SHELL', 'USER', 'BASH_ENV', 'ENV', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'POLL_INTERVAL_MS', 'TURN_TIMEOUT_MS', 'POLL_TIMEOUT_MS', 'REQUEST_TIMEOUT_MS',
  'OWNER_TG_ID',
];
const RESERVED_SECRET_PREFIXES = [
  'ANTHROPIC_', 'CLAUDE_', 'NODE_', 'NPM_CONFIG_', 'LD_', 'GIT_', 'PM2_', 'SSL_', 'DOTENV_',
];
const RESERVED_SECRET_EXCEPTIONS = ['NODE_ENV'];

/** Без учёта регистра: `https_proxy` читают так же, как `HTTPS_PROXY`. */
export function isReservedSecretName(name: string): boolean {
  const upper = name.toUpperCase();
  if (RESERVED_SECRET_EXCEPTIONS.includes(upper)) return false;
  return RESERVED_SECRET_NAMES.includes(upper) || RESERVED_SECRET_PREFIXES.some((p) => upper.startsWith(p));
}

/** Сколько символов негодного имени показывается в тексте отказа и в field. */
const SHOWN_NAME_HEAD = 8;

/** Нулевой байт: argv его не переживёт, агент машины такое значение отвергает. */
const NUL = String.fromCharCode(0);

/**
 * Имя ключа для текста отказа и field. Имя, не прошедшее форму или длину, —
 * только обрезком: в поле имени по ошибке вставляют само значение (токен,
 * PEM), а текст отказа уходит в result карточки, в журнал и в ответ
 * ассистенту. Первые SHOWN_NAME_HEAD символов (по кодовым точкам — суррогатная
 * пара не рвётся) и «…»; управляющие и невидимые — «?», поэтому и после
 * JSON.stringify обрезок не длиннее двадцати символов. Годное по форме имя
 * (в том числе занятое платформой) — как есть: оно не длиннее
 * SECRET_NAME_MAX, и человеку нужно целиком.
 */
export function shownSecretName(name: string): string {
  if (SECRET_NAME_RE.test(name) && name.length <= SECRET_NAME_MAX) return name;
  const chars = Array.from(name);
  const head = chars.slice(0, SHOWN_NAME_HEAD).join('').replace(/\p{C}/gu, '?');
  return chars.length > SHOWN_NAME_HEAD ? `${head}…` : head;
}

export interface SecretProblem {
  /**
   * Текст для человека — тот, что create() отдавал до выноса; негодное имя в
   * нём — обрезком (shownSecretName).
   */
  message: string;
  /** Имя ключа, к которому относится отказ (карточка подсвечивает поле); негодное — обрезком. */
  field?: string;
}

/**
 * Первая причина, по которой набор ключей не годится, или null.
 *
 * Порядок проверок — прежний порядок create(): сначала число, затем по
 * каждому ключу имя, длина имени, занятость, значение. Тип значения
 * проверяется ДО длины: у не-строки .length либо нет, либо он про другое.
 * Пустая строка — отказ: переменная без значения доезжает до контейнера, и бот
 * читает её как «ключа нет». Нулевой байт — отказ здесь, а не у агента
 * машины: там он всплыл бы уже после записи (заведение — failed на машине,
 * смена ключей — rekey_failed). Перенос строки законен (PEM).
 */
export function secretsProblem(secrets: Record<string, unknown>): SecretProblem | null {
  const entries = Object.entries(secrets ?? {});
  if (entries.length > SECRET_COUNT_MAX) return { message: `секретов больше ${SECRET_COUNT_MAX}` };
  for (const [name, value] of entries) {
    if (!SECRET_NAME_RE.test(name)) {
      const shown = shownSecretName(name);
      return { message: `имя секрета ${JSON.stringify(shown)} не переменная окружения`, field: shown };
    }
    if (name.length > SECRET_NAME_MAX) {
      return { message: `имя секрета длиннее ${SECRET_NAME_MAX} символов`, field: shownSecretName(name) };
    }
    if (isReservedSecretName(name)) {
      return { message: `имя секрета ${name} занято платформой — назовите ключ иначе`, field: name };
    }
    if (typeof value !== 'string' || value === '') {
      return { message: `секрет ${name}: значение должно быть непустой строкой`, field: name };
    }
    if (value.length > SECRET_VALUE_MAX) {
      return { message: `секрет ${name}: значение длиннее ${SECRET_VALUE_MAX} символов`, field: name };
    }
    if (value.includes(NUL)) {
      return { message: `секрет ${name}: значение содержит недопустимый символ`, field: name };
    }
  }
  return null;
}
