/**
 * Сервер держит соединение до 30 секунд в long-poll, прежде чем ответить
 * `turn: null`. Таймаут запроса обязан быть заметно больше этого окна —
 * иначе раннер обрывает штатный пустой ответ ещё до того, как сервер успел
 * на него ответить, и long-poll вырождается в частый short-poll с
 * постоянными abort. 35 секунд — окно сервера плюс запас на сетевую
 * задержку и время сервера на сборку ответа.
 */
export const DEFAULT_POLL_TIMEOUT_MS = 35_000;

/**
 * sendEvents и complete — обычные быстрые запросы, никакого long-poll в них
 * нет. Десять секунд — щедрый запас на медленную сеть клиентской VM, но не
 * настолько долго, чтобы повисший `complete` держал цикл раннера дольше,
 * чем разумно ждать признаков жизни от простого POST.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export interface RunnerConfig {
  linkeonUrl: string;
  runnerToken: string;
  checkoutPath: string;
  pollIntervalMs: number;
  turnTimeoutMs: number;
  claudeBin: string;
  /** Таймаут long-poll запроса к /products/runner/poll. См. DEFAULT_POLL_TIMEOUT_MS. */
  pollTimeoutMs: number;
  /** Таймаут обычных запросов (sendEvents, complete). См. DEFAULT_REQUEST_TIMEOUT_MS. */
  requestTimeoutMs: number;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`${key} не задан — раннер не может стартовать`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  return {
    // Хвостовой слеш дал бы https://host//webhook/... — nginx такие пути не
    // всегда нормализует.
    linkeonUrl: required(env, 'LINKEON_URL').replace(/\/+$/, ''),
    runnerToken: required(env, 'RUNNER_TOKEN'),
    checkoutPath: required(env, 'CHECKOUT_PATH'),
    pollIntervalMs: Number(env.POLL_INTERVAL_MS ?? 3000),
    // Меньше серверного порога снятия зависших ходов (30 минут): иначе раннер
    // отчитается по ходу, который сервер уже закрыл, и работа окажется
    // выполненной и не оплаченной.
    turnTimeoutMs: Number(env.TURN_TIMEOUT_MS ?? 20 * 60 * 1000),
    // Бэкенд зовёт /usr/bin/claude, а не тот claude, что первым найдётся в
    // PATH шелла. На клиентской VM путь может отличаться — выносим в env.
    claudeBin: env.CLAUDE_BIN ?? '/usr/bin/claude',
    pollTimeoutMs: Number(env.POLL_TIMEOUT_MS ?? DEFAULT_POLL_TIMEOUT_MS),
    requestTimeoutMs: Number(env.REQUEST_TIMEOUT_MS ?? DEFAULT_REQUEST_TIMEOUT_MS),
  };
}
