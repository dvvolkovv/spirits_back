/**
 * Повтор POST /chat к релею, пока тот за шлагбаумом выката.
 *
 * Откуда («Затыки недели» 16.11.2026, пункт aa27b1d5): deploy-relay.sh ставит
 * маркер, после которого релей отвечает 503 на новые ходы, а на время рестарта
 * nginx отдаёт 502. Бэк на этом падал: человек получал пустой ответ, рутина —
 * терялась. Теперь все пять мест вызова (веб, загрузка, agentReply, clean-ask,
 * блог) идут через этот помощник.
 *
 * Повторяем ТОЛЬКО 502, 503 и ECONNREFUSED: в этих случаях релей ход точно не
 * начинал. ECONNRESET, 504, 500 и таймаут — нет: ход мог начаться и списаться.
 *
 * Форма multipart — поток, второй раз её не отправить, поэтому на вход —
 * фабрика запроса, а не готовый запрос. Ожидание дробится на шаги по секунде:
 * если за это время пришло новое сообщение той же сессии (shouldStop), ход
 * сдаётся как перебитый (superseded), а не висит до конца бюджета.
 */
export const RELAY_DRAIN_DELAYS_MS: readonly number[] = [2000, 4000, 8000, 15000, 30000, 30000, 30000, 30000];

export class RelayDrainingError extends Error {
  constructor(public readonly superseded: boolean, public readonly attempts: number) {
    super(superseded ? 'relay draining: superseded' : 'relay draining: budget exhausted');
    this.name = 'RelayDrainingError';
  }
}

export function isRelayDrainingError(err: any): boolean {
  const status = err?.response?.status;
  return status === 502 || status === 503 || err?.code === 'ECONNREFUSED';
}

export interface DrainRetryOpts {
  /** true — ход перебит новым сообщением той же сессии: сдаться. */
  shouldStop?: () => boolean;
  /** Перед каждым ожиданием: номер повтора (с 1) и задержка. */
  onRetry?: (attempt: number, delayMs: number) => void;
  delaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Отказ при responseType: 'stream' держит открытое тело — закрываем, чтобы
// не копить сокеты на каждом повторе.
function closeBody(err: any) {
  const d = err?.response?.data;
  if (d && typeof d.destroy === 'function') { try { d.destroy(); } catch {} }
}

export async function postRelayWithDrainRetry<T>(makePost: () => Promise<T>, opts: DrainRetryOpts = {}): Promise<T> {
  const delays = opts.delaysMs ?? RELAY_DRAIN_DELAYS_MS;
  const sleep = opts.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    if (attempt > 0 && opts.shouldStop?.()) throw new RelayDrainingError(true, attempt);
    try {
      return await makePost();
    } catch (err) {
      if (!isRelayDrainingError(err)) throw err;
      closeBody(err);
      if (attempt >= delays.length) throw new RelayDrainingError(false, attempt + 1);
      const delay = delays[attempt];
      opts.onRetry?.(attempt + 1, delay);
      for (let waited = 0; waited < delay; ) {
        const step = Math.min(1000, delay - waited);
        await sleep(step);
        waited += step;
        if (opts.shouldStop?.()) throw new RelayDrainingError(true, attempt + 1);
      }
    }
  }
}
