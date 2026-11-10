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
 * Признак — именно «речь началась и не кончилась», а не «давно нет событий».
 * В тишине встречи модель законно молчит минутами, и сторож по общей тишине
 * переоткрывал бы сокет каждые несколько минут, каждый раз заново заливая
 * весь разговор. Отрезок речи без паузы сервер закрывает за доли секунды
 * тишины; два часа живого монолога без вдоха не бывает.
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
 * Плагин повторяет открытие до трёх раз с таймаутом 10 с и паузой 2 с —
 * худший штатный путь около 40 с.
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
  private speechSince: number | undefined;
  private lastServerEventAt = 0;
  private forcedAt: number | undefined;

  constructor(
    private readonly rt: ReconnectableRt,
    private readonly now: () => number = Date.now,
    private readonly log: (line: string) => void = (l) => console.log(l),
  ) {
    rt.on?.('openai_server_event_received', (ev: any) => {
      const t = this.now();
      this.lastServerEventAt = t;
      if (ev?.type === 'input_audio_buffer.speech_started') this.speechSince = t;
      else if (ev?.type === 'input_audio_buffer.speech_stopped') this.speechSince = undefined;
    });
  }

  check(): InputWatchResult {
    const now = this.now();
    if (this.forcedAt !== undefined) {
      if (this.lastServerEventAt > this.forcedAt) {
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
    this.rt.lkForceReconnect('сторож приёма: речь началась и не кончилась');
    return 'forced';
  }
}
