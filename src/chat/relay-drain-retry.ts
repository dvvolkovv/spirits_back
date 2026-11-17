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
 *
 * Допущение: между бэком и релеем нет HTTP-посредника, кроме nginx самого
 * релея; буферизующий прокси или CDN мог бы вернуть 502 уже после того, как
 * релей начал ход, и тогда повтор стал бы небезопасным.
 */
export const RELAY_DRAIN_DELAYS_MS: readonly number[] = [2000, 4000, 8000, 15000, 30000, 30000, 30000, 30000];

/**
 * Короткое расписание (~59 с вместо ~149 с) — для вызовов под собственным
 * таймаутом (консультация специалиста и голосовые документы/заметки в звонке).
 * Их withTimeout только гонится с ходом и не отменяет его: при полном
 * расписании вызывающий уже сдался бы, а ход после выката всё равно сходил бы
 * в модель — без списания, с выброшенным ответом. ~59 с оставляют в таймауте
 * вызова место на саму генерацию.
 */
export const RELAY_DRAIN_DELAYS_SHORT_MS: readonly number[] = [2000, 4000, 8000, 15000, 30000];

/** Чем релей отказал: 503 — шлагбаум выката, 502 и ECONNREFUSED — процесс или nginx не отвечают. */
export type RelayRefusal = 502 | 503 | 'ECONNREFUSED';

export class RelayDrainingError extends Error {
  /**
   * lastRefusal — отказ последней неудачной попытки. Человеку исход один
   * («ассистент обновляется»), а по нему журнал и телеметрия отличают выкат
   * (503) от аварии: релей в цикле падений (nginx 502) или лежит сам nginx
   * (ECONNREFUSED).
   */
  constructor(
    public readonly superseded: boolean,
    public readonly attempts: number,
    public readonly lastRefusal?: RelayRefusal,
  ) {
    super(superseded ? 'relay draining: superseded' : 'relay draining: budget exhausted');
    this.name = 'RelayDrainingError';
  }
}

/**
 * Журнал исхода хода, который так и не дошёл до релея (веб и загрузка).
 * Выкат (503) и перебитый ход — штатные исходы, warn. Не дождались на 502 или
 * ECONNREFUSED — авария релея, error: иначе она тонула бы среди выкатов. Без
 * relaySid (в ключе сессии номер телефона) и без текста человека.
 */
export function logRelayDrainOutcome(
  logger: { warn(message: string): void; error(message: string): void },
  err: RelayDrainingError,
): void {
  if (err.superseded) {
    logger.warn('шлагбаум релея: перебит');
  } else if (err.lastRefusal === 502 || err.lastRefusal === 'ECONNREFUSED') {
    logger.error(`релей недоступен: не дождались (${err.lastRefusal})`);
  } else {
    logger.warn(err.lastRefusal ? `шлагбаум релея: не дождались (${err.lastRefusal})` : 'шлагбаум релея: не дождались');
  }
}

/** Отказ из ошибки, уже признанной isRelayDrainingError. */
function refusalOf(err: unknown): RelayRefusal {
  const status = (err as { response?: { status?: unknown } }).response?.status;
  return status === 502 || status === 503 ? status : 'ECONNREFUSED';
}

/**
 * Сырой отказ транспорта (ошибка axios или errno), после которого повтор
 * безопасен. Экземпляр RelayDrainingError эта функция НЕ распознаёт — для него
 * `instanceof RelayDrainingError`.
 */
export function isRelayDrainingError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { response?: { status?: unknown }; code?: unknown };
  const status = e.response?.status;
  return status === 502 || status === 503 || e.code === 'ECONNREFUSED';
}

/**
 * Колбэки shouldStop и onRetry не должны бросать: исключение из них уйдёт
 * наружу как есть, без обёртки в RelayDrainingError.
 */
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
  let last: RelayRefusal | undefined;
  for (let attempt = 0; ; attempt++) {
    if (attempt > 0 && opts.shouldStop?.()) throw new RelayDrainingError(true, attempt, last);
    try {
      return await makePost();
    } catch (err) {
      if (!isRelayDrainingError(err)) throw err;
      closeBody(err);
      last = refusalOf(err);
      // Пока шла HTTP-попытка, сессию мог занять новый ход: перебитому ходу —
      // ни заглушки «бюджет исчерпан», ни onRetry, сессия уже не его.
      if (opts.shouldStop?.()) throw new RelayDrainingError(true, attempt + 1, last);
      if (attempt >= delays.length) throw new RelayDrainingError(false, attempt + 1, last);
      const delay = delays[attempt];
      opts.onRetry?.(attempt + 1, delay);
      for (let waited = 0; waited < delay; ) {
        const step = Math.min(1000, delay - waited);
        await sleep(step);
        waited += step;
        if (opts.shouldStop?.()) throw new RelayDrainingError(true, attempt + 1, last);
      }
    }
  }
}
