/**
 * Сторож приёма: модель замолчала посреди речи.
 *
 * Что было. Встреча 10.11.2026: в 06:52:22 модель прислала «речь началась» —
 * и больше ничего до конца встречи в 07:18. Звук шёл, люди звали Романа по
 * имени, а гейту было нечего решать: расшифровок не приходило. Причина в тот
 * раз — сокет, который плагин не смог переоткрыть (правка SDK
 * realtime-connect-retry), но и после неё сокет может замолчать иначе, а
 * сторож ответа (stuck-generation.ts) видит только зависший ОТВЕТ.
 *
 * Признак — «речь началась, и после этого от сервера НИЧЕГО», а не «давно
 * нет событий». В тишине встречи модель законно молчит минутами, и сторож по
 * общей тишине переоткрывал бы сокет каждые несколько минут, каждый раз
 * заново заливая весь разговор. Отрезок речи без паузы сервер закрывает за
 * доли секунды тишины; двух минут живого монолога без вдоха не бывает.
 *
 * «Речь началась» без конца бывает и законно — тогда отметку снимаем: сокет
 * сменили (новая сессия сервера), буфер очищен посреди речи, или после неё
 * модель что-то прислала, то есть жива (звук мог оборваться на полуслове).
 * Ложное переоткрытие не бесплатно: обрывает ответ Романа на полуслове.
 *
 * Что делаем. Переоткрываем сокет ручкой плагина lkForceReconnect (правка SDK
 * realtime-force-reconnect) — тем же путём, что плановое переоткрытие раз в
 * 20 минут. Не помогло за RECOVERY_MS или ручки нет — сессия мертва, и
 * вызывающий её закрывает: глухой ассистент на встрече хуже ушедшего, а
 * закрытие хотя бы сохраняет транскрипт и видно людям.
 */

/**
 * Сколько речь может длиться без конца, прежде чем сочтём модель зависшей.
 *
 * 10.11.2026 самые длинные отрезки без паузы — 36–38 с. Две минуты — с
 * тройным запасом; цена запаса — две минуты глухоты против получаса.
 */
export const STUCK_SPEECH_MS = 120_000;

/**
 * Сколько ждём первого события сервера после переоткрытия.
 *
 * Плагин повторяет открытие с таймаутом 10 с и паузами 0,1 и 2 с; сама
 * ручка съедает одну попытку, и до отказа остаются три открытия — худший
 * штатный путь около 35 с.
 */
export const RECOVERY_MS = 60_000;

/** Как часто сторож смотрит. */
export const INPUT_WATCH_TICK_MS = 5_000;

/** Ровно та часть сессии плагина, которой пользуется сторож. */
export interface ReconnectableRt {
  on?(event: string, cb: (ev: any) => void): unknown;
  lkForceReconnect?(reason: string): void;
}

export type InputWatchResult = 'ok' | 'forced' | 'waiting' | 'recovered' | 'dead';

export class InputWatch {
  /** Когда пришло «речь началась», после которого сервер не прислал ничего. */
  private speechSince: number | undefined;
  private forcedAt: number | undefined;
  /**
   * Новая сессия после переоткрытия. Любое событие сервера выздоровлением не
   * считаем: ручка может не сработать (плагин ждёт конец ответа или сокета
   * уже нет), а старый сокет до закрытия успевает что-то прислать.
   */
  private reopened = false;

  constructor(
    private readonly rt: ReconnectableRt,
    private readonly now: () => number = Date.now,
    private readonly log: (line: string) => void = (l) => console.log(l),
  ) {
    rt.on?.('openai_server_event_received', (ev: any) => {
      if (ev?.type === 'session.created') this.reopened = true;
      this.speechSince = ev?.type === 'input_audio_buffer.speech_started' ? this.now() : undefined;
    });
    rt.on?.('session_reconnected', () => {
      this.reopened = true;
      this.speechSince = undefined;
    });
  }

  check(): InputWatchResult {
    const now = this.now();
    if (this.forcedAt !== undefined) {
      if (this.reopened) {
        this.forcedAt = undefined;
        this.log('[вход] после переоткрытия модель снова на связи');
        return 'recovered';
      }
      if (now - this.forcedAt < RECOVERY_MS) return 'waiting';
      this.log(`[вход] переоткрытие не помогло: модель молчит ${Math.round((now - this.forcedAt) / 1000)}с — сессия мертва`);
      return 'dead';
    }
    if (this.speechSince === undefined || now - this.speechSince < STUCK_SPEECH_MS) return 'ok';

    const silentS = Math.round((now - this.speechSince) / 1000);
    this.speechSince = undefined;
    if (typeof this.rt.lkForceReconnect !== 'function') {
      this.log(`[вход] модель молчит ${silentS}с посреди речи, а ручки переоткрытия нет — сессия мертва`);
      return 'dead';
    }
    this.log(`[вход] модель молчит ${silentS}с посреди речи — переоткрываю сокет`);
    this.forcedAt = now;
    this.reopened = false;
    this.rt.lkForceReconnect('сторож приёма: речь началась и не кончилась');
    return 'forced';
  }
}
