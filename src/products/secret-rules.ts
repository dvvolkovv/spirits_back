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

export interface SecretProblem {
  /** Текст для человека — дословно тот, что create() отдавал до выноса. */
  message: string;
  /** Имя ключа, к которому относится отказ (карточка подсвечивает поле). */
  field?: string;
}

/**
 * Первая причина, по которой набор ключей не годится, или null.
 *
 * Порядок проверок — прежний порядок create(): сначала число, затем по
 * каждому ключу имя, длина имени, занятость, значение. Тип значения
 * проверяется ДО длины: у не-строки .length либо нет, либо он про другое.
 * Пустая строка — отказ: переменная без значения доезжает до контейнера, и бот
 * читает её как «ключа нет».
 */
export function secretsProblem(secrets: Record<string, unknown>): SecretProblem | null {
  const entries = Object.entries(secrets ?? {});
  if (entries.length > SECRET_COUNT_MAX) return { message: `секретов больше ${SECRET_COUNT_MAX}` };
  for (const [name, value] of entries) {
    if (!SECRET_NAME_RE.test(name)) {
      return { message: `имя секрета ${JSON.stringify(name)} не переменная окружения`, field: name };
    }
    if (name.length > SECRET_NAME_MAX) {
      return { message: `имя секрета длиннее ${SECRET_NAME_MAX} символов`, field: name };
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
  }
  return null;
}
