/**
 * Когда гасить микрофон бота при уходе в режим слушателя.
 *
 * Не сразу. Войдя в режим, ассистент вслух подтверждает его и называет
 * формулу возврата — «скажите „Роман, вопрос к тебе“». Без неё его потом не
 * поднять (14.09.2026). А кнопку жали в тот же момент, когда запускался этот
 * ответ: 27.10.2026 микрофон погас через секунду после «помолчи», и формулу не
 * услышал никто.
 *
 * Поэтому гасим, когда ДОЗВУЧАЛА речь, начавшаяся после команды. Именно
 * начавшаяся: если «помолчи» сказали, пока ассистент договаривал прошлую
 * реплику, её конец подтверждением не является. Подтверждение может и вовсе
 * уйти в очередь (replyOrDefer), поэтому привязка к состоянию агента, а не к
 * таймеру.
 *
 * Запасной срок — на случай, когда подтверждение так и не прозвучало: 27.10 по
 * нему не пришло ни звука, и ждать речи бесконечно значило бы не погасить
 * микрофон вовсе.
 *
 * Включаем, наоборот, СРАЗУ: ответ на «вопрос к тебе» идёт следом, и его
 * начало иначе ушло бы в выключенный микрофон.
 */

/** Сколько ждём подтверждения, прежде чем погасить микрофон без него. */
export const LISTEN_MUTE_FALLBACK_MS = 15_000;

/** Состояние агента — в том виде, в каком его отдаёт AgentStateChanged. */
export type AgentStateName = 'initializing' | 'idle' | 'listening' | 'thinking' | 'speaking' | string;

export class ListenMute {
  /** off — микрофон включён; waiting — ждём подтверждения; muted — погашен. */
  private phase: 'off' | 'waiting' | 'muted' = 'off';
  /** В ожидании уже началась новая речь — её конец и есть подтверждение. */
  private spokeSinceEnter = false;
  private agentSpeaking = false;
  private cancelFallback: (() => void) | null = null;

  /**
   * @param send команда боту: true — выключить микрофон, false — включить
   * @param schedule таймер; отдаёт функцию отмены. Подменяется в тестах.
   */
  constructor(
    private readonly send: (on: boolean) => void,
    private readonly schedule: (fn: () => void, ms: number) => () => void = (fn, ms) => {
      const t = setTimeout(fn, ms);
      // unref: таймер не должен держать процесс задания после конца встречи.
      t.unref?.();
      return () => clearTimeout(t);
    },
  ) {}

  /** Ассистент ушёл в режим слушателя. */
  enter(): void {
    if (this.phase !== 'off') return;
    this.phase = 'waiting';
    // Говорит прямо сейчас — это прошлая реплика, не подтверждение.
    this.spokeSinceEnter = false;
    this.cancelFallback = this.schedule(() => this.mute(), LISTEN_MUTE_FALLBACK_MS);
  }

  /** Ассистент вернулся в разговор. */
  leave(): void {
    this.cancelFallback?.();
    this.cancelFallback = null;
    this.phase = 'off';
    this.send(false);
  }

  /** Новое состояние агента. */
  state(next: AgentStateName): void {
    const wasSpeaking = this.agentSpeaking;
    this.agentSpeaking = next === 'speaking';
    if (this.phase !== 'waiting') return;
    if (this.agentSpeaking && !wasSpeaking) {
      this.spokeSinceEnter = true;
      return;
    }
    if (wasSpeaking && !this.agentSpeaking && this.spokeSinceEnter) this.mute();
  }

  private mute(): void {
    if (this.phase !== 'waiting') return;
    this.cancelFallback?.();
    this.cancelFallback = null;
    this.phase = 'muted';
    this.send(true);
  }
}
