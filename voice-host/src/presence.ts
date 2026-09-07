/**
 * Кто во встрече на площадке без LiveKit.
 *
 * На своих комнатах и в Taler ID состав берётся из `room.remoteParticipants`.
 * В Meet разговор идёт вне LiveKit, наша комната пуста, и `remoteParticipants`
 * там всегда нулевой — то есть источник состава нужен другой. Им становятся
 * вебхуки Attendee, доезжающие сюда по дата-каналу.
 *
 * Класс чистый: ни сети, ни таймеров. Воркер скармливает события, он отвечает
 * составом, флагом «наедине» и текущим говорящим. Именно поэтому это
 * единственная часть моста, покрытая тестами полностью.
 */
export interface ParticipantEvent {
  event: 'join' | 'leave';
  uuid: string;
  name: string;
}

export class Presence {
  /** uuid → имя. Множество, а не счётчик: вебхуки повторяются при retry. */
  private readonly people = new Map<string, string>();
  private speakingUuid?: string;
  /**
   * Имя говорящего из самого события.
   *
   * Нужно потому, что `speech_start` может опередить `join`: события идут
   * разными вебхуками и порядок между ними не гарантирован. Без запаса имени
   * первая реплика встречи осталась бы без разметки говорящего.
   */
  private speakingName?: string;

  /**
   * @param selfName имя, под которым в встрече сидит наш же бот. Attendee
   *   присылает его в join_leave наравне с людьми, и без исключения себя
   *   комната никогда не выглядела бы пустой: правила выхода не срабатывали
   *   бы, а гейт по имени не переходил бы в solo.
   */
  constructor(private readonly selfName?: string) {}

  apply(e: ParticipantEvent): void {
    if (this.selfName && e.name === this.selfName) return;
    if (e.event === 'join') {
      this.people.set(e.uuid, e.name);
      return;
    }
    this.people.delete(e.uuid);
    // Вышедший не может оставаться говорящим: иначе разметка транскрипта
    // приписывала бы реплики человеку, которого в встрече уже нет.
    if (this.speakingUuid === e.uuid) {
      this.speakingUuid = undefined;
      this.speakingName = undefined;
    }
  }

  speech(uuid: string, name: string, speaking: boolean): void {
    if (this.selfName && name === this.selfName) return;
    if (speaking) {
      this.speakingUuid = uuid;
      this.speakingName = name;
      return;
    }
    // Гасим только если замолчал именно текущий: события двух участников
    // приходят вперемешку, и чужое «замолчал» иначе стирало бы говорящего.
    if (this.speakingUuid === uuid) {
      this.speakingUuid = undefined;
      this.speakingName = undefined;
    }
  }

  get count(): number {
    return this.people.size;
  }

  get names(): string[] {
    return [...this.people.values()];
  }

  /**
   * Наедине ассистент отвечает без обращения по имени.
   *
   * Ровно ноль — это НЕ наедине: пустая встреча означает, что люди ещё не
   * собрались, и включать свободный режим там нельзя.
   */
  get solo(): boolean {
    return this.people.size === 1;
  }

  /**
   * Имя говорящего. Сначала из состава, потом из самого события — на случай,
   * когда `speech_start` опередил `join`.
   */
  get speaker(): string | undefined {
    if (!this.speakingUuid) return undefined;
    return this.people.get(this.speakingUuid) ?? this.speakingName;
  }
}
