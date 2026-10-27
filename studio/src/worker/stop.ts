import type { EventEmitter } from 'node:events';

/**
 * Остановка рабочего процесса: дождаться текущего задания и выйти.
 *
 * Под PM2 — сообщением 'shutdown' (shutdown_with_message в ecosystem.config.cjs),
 * а не сигналом: SIGINT ловят Playwright и Remotion — убивают браузер и выходят
 * сами (process.exit(130)), и задание бросалось посреди съёмки или сборки
 * (проверено на ноде 27.10.2026). Сигналы — для ручных запусков.
 * @returns «пора выходить» — проверять между заданиями
 */
export function watchStop(proc: Pick<EventEmitter, 'on'>, log: (line: string) => void): () => boolean {
  let stopping = false;
  const stop = (why: string): void => {
    if (stopping) return;
    stopping = true;
    log(`worker: ${why} — закончу текущее задание и выйду`);
  };
  for (const sig of ['SIGTERM', 'SIGINT'] as const) proc.on(sig, () => stop(sig));
  proc.on('message', (m: unknown) => {
    if (m === 'shutdown') stop('pm2 shutdown');
  });
  return () => stopping;
}
