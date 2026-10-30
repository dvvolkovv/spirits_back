/**
 * Сторож ответа, по которому не пришёл response.done.
 *
 * Что было. Плагин OpenAI Realtime каждые maxSessionDuration (20 минут)
 * переоткрывает сокет — и перед этим ЖДЁТ конца текущего ответа:
 * `await currentGeneration._doneFut.await` без всякого срока (так и в 1.9.4).
 * Если response.done по ответу не пришёл, ожидание не кончается никогда: новый
 * сокет не открывается, и ассистент глохнет до конца встречи. Встречи
 * 20.10.2026 и 27.10.2026 оглохли ровно на 1199-й секунде, после чего первая
 * тянулась ещё 44 минуты, вторая — 1 ч 40 мин, до предохранителя на два часа.
 * Признак в логе — ОТСУТСТВИЕ строки «OpenAI Realtime API connection timeout»:
 * её пишет каждое переоткрытие, дошедшее до конца, и обе встречи её не
 * написали.
 *
 * Почему именно этот ответ остался без response.done, по логам того дня не
 * видно. Поэтому рядом и пишется жизненный цикл ответов (responseLog).
 *
 * Что делаем. Ответ, живущий дольше порога, закрываем штатным
 * closeCurrentGeneration плагина: он и каналы закрывает, и ожидание
 * переоткрытия отпускает. Стенд 28.10.2026 (потерянный response.done за 15 с
 * до переоткрытия): без сторожа переоткрытие не случилось вовсе, со сторожем —
 * через полсекунды после закрытия ответа, транскрипты пошли дальше.
 *
 * Поля плагина protected/private — берём их приведением типа. Держится это на
 * коде установленного SDK, и проверяется тестом по нему же
 * (stuck-generation.test.ts): поле пропадёт — тест упадёт до выката.
 */

/**
 * Порог, после которого ответ считается зависшим.
 *
 * response.done приходит, когда сервер ДОГЕНЕРИРОВАЛ ответ, а не когда тот
 * доиграл, — генерация идёт быстрее речи, и даже длинный ответ укладывается в
 * десятки секунд. Девяносто — с запасом против обрыва живой реплики. Цена
 * запаса — до полутора минут глухоты, если ответ завис прямо перед
 * переоткрытием; против двух часов это приемлемо.
 */
export const STALE_GENERATION_MS = 90_000;

/** Как часто сторож смотрит на ответ. */
export const GUARD_TICK_MS = 5_000;

/** Ровно та часть сессии плагина, которой пользуется сторож. */
export interface RealtimeInternals {
  currentGeneration?: { discarded?: boolean; _createdTimestamp?: number };
  closeCurrentGeneration(reason?: string): void;
  on?(event: string, cb: (ev: any) => void): unknown;
}

/**
 * Сессия плагина из AgentSession — или undefined, если форма поменялась.
 *
 * Берём заново на каждой проверке, а не один раз: при смене агента
 * AgentActivity пересоздаётся вместе со своей сессией.
 */
export function realtimeOf(session: unknown): RealtimeInternals | undefined {
  const rt = (session as any)?._activity?.realtimeSession;
  return rt && typeof rt.closeCurrentGeneration === 'function' ? (rt as RealtimeInternals) : undefined;
}

export type GuardResult = 'none' | 'fresh' | 'closed' | 'unavailable';

export class StuckGenerationGuard {
  private warnedUnavailable = false;

  constructor(
    private readonly getRt: () => RealtimeInternals | undefined,
    private readonly staleMs: number = STALE_GENERATION_MS,
    private readonly log: (line: string) => void = (l) => console.log(l),
  ) {}

  check(now: number): GuardResult {
    const rt = this.getRt();
    if (!rt) {
      // Один раз за сессию: строка нужна, чтобы при разборе было видно, что
      // сторожа не было, а не чтобы забить лог.
      if (!this.warnedUnavailable) {
        this.warnedUnavailable = true;
        this.log('[ответ] сессия плагина не видна — сторож ответа выключен');
      }
      return 'unavailable';
    }
    const gen = rt.currentGeneration;
    // Отброшенный ответ плагин при переоткрытии снимает сам, не дожидаясь.
    if (!gen || gen.discarded || typeof gen._createdTimestamp !== 'number') return 'none';
    const age = now - gen._createdTimestamp;
    if (age < this.staleMs) return 'fresh';
    this.log(`[ответ] ответ висит ${Math.round(age / 1000)}с без response.done — закрываю`);
    rt.closeCurrentGeneration('сторож: response.done не пришёл');
    return 'closed';
  }
}

/**
 * Жизненный цикл ответов — строкой в лог.
 *
 * Без этого «ответ завис» не отличить от «ответа не было»: агент пишет только
 * `Creating speech handle`, а пришли ли response.created и response.done, и с
 * каким статусом, не видно. Разбор 27.10.2026 упёрся ровно в это.
 */
export function attachResponseLog(rt: RealtimeInternals, log: (line: string) => void = (l) => console.log(l)): void {
  rt.on?.('openai_server_event_received', (ev: any) => {
    switch (ev?.type) {
      case 'response.created':
        log(`[ответ] начат ${ev.response?.id ?? '?'}`);
        break;
      case 'response.done':
        log(`[ответ] завершён ${ev.response?.id ?? '?'}: ${ev.response?.status ?? '?'}`);
        break;
      case 'error':
        log(`[ответ] ошибка Realtime: ${ev.error?.code ?? ev.error?.type ?? '?'} — ${ev.error?.message ?? ''}`);
        break;
    }
  });
}
