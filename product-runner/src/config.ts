export interface RunnerConfig {
  linkeonUrl: string;
  runnerToken: string;
  checkoutPath: string;
  pollIntervalMs: number;
  turnTimeoutMs: number;
  claudeBin: string;
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
  };
}
