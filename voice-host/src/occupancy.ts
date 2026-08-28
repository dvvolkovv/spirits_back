/**
 * Сколько ждём первого человека.
 *
 * Правило «нет живых участников → выходим» без этой отсрочки выкидывало бы
 * ассистента мгновенно: его вполне могут позвать раньше, чем соберутся люди,
 * и комната в этот момент пуста.
 */
export const LOBBY_MS = 15 * 60 * 1000;

/**
 * Грубый предохранитель на общую длительность.
 *
 * Продуктовое решение, не ограничение API: у звонка из интерфейса потолок час,
 * у встречи два — переговоры регулярно длиннее часа. Это ещё и потолок по
 * деньгам: Realtime тарифицируется всё время, пока ассистент в комнате.
 */
export const HARD_CAP_MS = 2 * 60 * 60 * 1000;

export type Verdict =
  /** остаёмся в комнате */
  | 'stay'
  /** за всё ожидание никто не пришёл — вход не состоялся */
  | 'never_started'
  /** люди были и разошлись */
  | 'empty'
  /** уперлись в потолок */
  | 'hard_cap';

/**
 * Кто живой в комнате и пора ли выходить.
 *
 * Чистая логика без таймеров и сети: воркер скармливает ей события и текущее
 * время, она отвечает вердиктом. Так правила выхода проверяются тестами, а не
 * двухчасовым сидением в реальной встрече.
 *
 * Участники считаются множеством, а не счётчиком: LiveKit может прислать
 * participantConnected дважды на переподключении, и счётчик после этого уже
 * никогда не дойдёт до нуля — ассистент остался бы в пустой комнате навсегда.
 */
export class Occupancy {
  private readonly humans = new Set<string>();
  private everHadHuman = false;

  constructor(private readonly startedAt: number) {}

  joined(identity: string): void {
    this.humans.add(identity);
    this.everHadHuman = true;
  }

  left(identity: string): void {
    this.humans.delete(identity);
  }

  get liveCount(): number {
    return this.humans.size;
  }

  verdict(now: number): Verdict {
    // Потолок проверяется первым: если истекли оба условия, причина выхода
    // должна называться честно, иначе в логах будет «встреча опустела» там,
    // где на самом деле сработал предохранитель.
    if (now - this.startedAt >= HARD_CAP_MS) return 'hard_cap';
    if (!this.everHadHuman) {
      return now - this.startedAt >= LOBBY_MS ? 'never_started' : 'stay';
    }
    return this.humans.size === 0 ? 'empty' : 'stay';
  }
}
