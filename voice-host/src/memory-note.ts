/**
 * Память процесса — для строки [вход].
 *
 * SDK пишет память процесса встречи только выше гигабайта, а утечка до
 * 29.10.2026 туда добиралась лишь к 47-й минуте: короткий разговор проверить
 * было нечем. Строка [вход] и так выходит раз в 5 с — по ней видно кривую.
 *
 * Куча и буферы — отдельно: утечки SDK были именно в них (события со звуком
 * в куче, кадры в буферах), и по ним видно, какая из двух вернулась.
 */
type Usage = Pick<NodeJS.MemoryUsage, 'rss' | 'heapUsed' | 'arrayBuffers'>;

const MB = 1024 * 1024;

export function memoryNote(usage: Usage = process.memoryUsage()): string {
  const mb = (n: number) => Math.round(n / MB);
  return `память: rss ${mb(usage.rss)} МБ (куча ${mb(usage.heapUsed)}, буферы ${mb(usage.arrayBuffers)})`;
}
