/**
 * Конфиг агента хоста продуктов. Отдельный от `src/config.ts` намеренно: тот
 * читает раннер, живущий ВНУТРИ контейнера продукта, и у него другое
 * окружение (CHECKOUT_PATH, CLAUDE_BIN, TURN_TIMEOUT_MS). Общий loadConfig
 * потребовал бы от агента задавать переменные, которые ему не нужны, и падать
 * без них.
 */

/**
 * Таймаут опроса. ЗДЕСЬ ОН НЕ 35 СЕКУНД, в отличие от раннера, и это главное
 * отличие двух конфигов.
 *
 * В раннере 35 секунд стоят по причине, а не по привычке: сервер держит
 * `products/runner/poll` до 30 секунд в long-poll, и таймаут короче окна рвал
 * бы штатный пустой ответ. У маршрута агента (`products/host/poll`,
 * host.controller.ts) такого окна НЕТ — он возвращается немедленно, в том
 * числе с `{ job: null }`. Скопировать сюда 35 секунд значило бы скопировать
 * число без его причины: у мгновенного маршрута это уже не «окно сервера плюс
 * запас», а просто срок, в течение которого заглохший TCP держит агента
 * втрое дольше необходимого.
 *
 * Триггер пересмотра назван прямо: если опрос агента станет длинным, он
 * станет таким на СЕРВЕРЕ, и эта константа обязана поменяться вместе с ним.
 */
export const DEFAULT_POLL_TIMEOUT_MS = 10_000;

/** Отчёт о завершении — обычный быстрый POST. Столько же, сколько у раннера. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Пауза между пустыми оборотами. Её держит АГЕНТ, потому что сервер не держит
 * ничего: `for (;;) await tick()` без сна — горячий цикл по API и по базе с
 * частотой сети, а каждый оборот там не бесплатный (claimJob это CTE с
 * `FOR UPDATE SKIP LOCKED` по двум таблицам).
 */
export const DEFAULT_POLL_INTERVAL_MS = 3_000;

/**
 * Сколько раз пытаться доставить отчёт о завершении.
 *
 * Отчёт — единственное, что сообщает серверу об уже СОВЕРШЁННОМ и необратимом:
 * контейнер поднят, порт занят, домен заведён. Одна попытка означает, что
 * сетевой моргок (в том числе наш же `pm2 restart` при выкате бэкенда) стирает
 * результат десятиминутной работы: задание остаётся в 'running', реаппер через
 * 10 минут хоронит продукт, а контейнер при этом живёт и держит слаг — повтор
 * упрётся в «контейнер уже есть» и потребует рук на хосте.
 *
 * Повтор безопасен, и это свойство СЕРВЕРА, а не удача: `completeJob` закрывает
 * задание условием `AND status = 'running'`, поэтому второй такой же отчёт —
 * no-op с предупреждением в лог, и повторный отчёт после обрыва связи там
 * прямо назван законным путём.
 *
 * Шесть попыток и пять пауз по 10 секунд — в худшем случае ДО 110 СЕКУНД, а не
 * «около минуты»: каждая попытка это ещё и свой requestTimeoutMs, и повисший
 * запрос выбирает все десять секунд (6 × 10 запроса + 5 × 10 паузы). Всё это
 * время агент не опрашивает очередь.
 *
 * Потолок выбран снизу перезапуском API (`pm2 restart` — единицы секунд, выкат
 * с прогревом — десятки), сверху серверным сроком заведения в 10 минут: отчёт,
 * приехавший после того, как реаппер закрыл задание, уже никого не спасёт (тот
 * же `AND status='running'` сделает его no-op), а держать агента дольше
 * вредно — пока он досылает, на хосте не заводится ни один другой продукт.
 */
export const DEFAULT_REPORT_ATTEMPTS = 6;
export const DEFAULT_REPORT_RETRY_MS = 10_000;

/**
 * ОБЩИЙ срок на всё развёртывание — вторая линия, а не первая.
 *
 * Первая линия — срок одной программы в `hostDeps.run` (DEFAULTS.runTimeoutMs
 * в provision.ts): она снимает заклинивший `docker run`, после чего
 * отрабатывает обычная подчистка и хост остаётся чистым. Здесь — то, чего
 * первая линия закрыть не может: зависшая файловая операция, ошибка в самом
 * `provision`, цепочка медленных, но не зависших шагов.
 *
 * По этому сроку отменять НЕЧЕГО: агент перестаёт ждать, но `provision`
 * продолжает работать в фоне, подчистка не вызывалась, и состояние хоста
 * неизвестно. Это прямо сказано в тексте отказа — иначе владелец прочитает
 * «сорвалось» как «на хосте чисто» и упрётся в занятый слаг.
 *
 * Восемь минут: меньше серверного срока заведения в 10 минут (отчёт по
 * закрытому заданию — no-op и ничего не изменит) и заметно больше суммы
 * нормальных шагов, где самый долгий — ожидание ответа продукта в 60 секунд.
 */
export const DEFAULT_PROVISION_TIMEOUT_MS = 8 * 60 * 1000;

export interface HostConfig {
  linkeonUrl: string;
  /** Обязан совпадать с PRODUCT_HOST_TOKEN в окружении бэкенда. */
  hostToken: string;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  requestTimeoutMs: number;
  reportAttempts: number;
  reportRetryMs: number;
  /**
   * Необязательное поле с умолчанием в месте использования — ровно как
   * pollTimeoutMs у раннера. Так конфиг, собранный где-то ещё (тест, чужой
   * вызов), не остаётся БЕЗ срока: `?? DEFAULT_PROVISION_TIMEOUT_MS` в runJob
   * действует и тогда, когда поля нет вовсе.
   */
  provisionTimeoutMs?: number;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  // `!value`, а не `value === undefined`: пустая строка в env-файле
  // (`HOST_TOKEN=`) — это самый частый вид «задал, но не задал». Пропущенная
  // сюда, она даёт вечный 401 без единой подсказки, потому что HostGuard
  // отвергает пустой токен молча.
  if (!value) throw new Error(`${key} не задан — агент хоста не может стартовать`);
  return value;
}

/**
 * Число из окружения — с отказом, а не с молчаливым умолчанием.
 *
 * `Number(env.X ?? 3000)` из раннера на опечатке даёт NaN, а `setTimeout(NaN)`
 * — это `setTimeout(0)`, то есть ровно тот горячий цикл, ради предотвращения
 * которого пауза и существует. Отказ при старте виден в журнале первой же
 * строкой; молчаливая подмена на умолчание прячет опечатку оператора, а
 * молчаливый NaN превращает её в нагрузку на прод.
 */
function positiveNumber(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${key}=${JSON.stringify(raw)} — не положительное число`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HostConfig {
  return {
    // Хвостовой слеш дал бы https://host//webhook/... — nginx такие пути не
    // всегда нормализует.
    linkeonUrl: required(env, 'LINKEON_URL').replace(/\/+$/, ''),
    hostToken: required(env, 'HOST_TOKEN'),
    pollIntervalMs: positiveNumber(env, 'POLL_INTERVAL_MS', DEFAULT_POLL_INTERVAL_MS),
    pollTimeoutMs: positiveNumber(env, 'POLL_TIMEOUT_MS', DEFAULT_POLL_TIMEOUT_MS),
    requestTimeoutMs: positiveNumber(env, 'REQUEST_TIMEOUT_MS', DEFAULT_REQUEST_TIMEOUT_MS),
    reportAttempts: positiveNumber(env, 'REPORT_ATTEMPTS', DEFAULT_REPORT_ATTEMPTS),
    reportRetryMs: positiveNumber(env, 'REPORT_RETRY_MS', DEFAULT_REPORT_RETRY_MS),
    provisionTimeoutMs: positiveNumber(env, 'PROVISION_TIMEOUT_MS', DEFAULT_PROVISION_TIMEOUT_MS),
  };
}
