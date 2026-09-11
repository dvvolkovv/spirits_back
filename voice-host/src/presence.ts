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

/**
 * Имя участника в сравнимом виде.
 *
 * Своего бота мы узнаём по имени, а не по идентификатору: `participant_uuid`
 * у Attendee выдаётся встречей и заранее нам неизвестен. Побайтовое сравнение
 * для этого слишком хрупко — имя собирается из `ownerName`, то есть из
 * профиля пользователя, и по пути через Meet может измениться: схлопнутся
 * двойные пробелы, приедет неразрывный пробел вместо обычного, разъедется
 * нормализация юникода (NFC против NFD — «й» бывает одним символом и двумя).
 *
 * Цена ошибки несимметрична. Не узнали себя — бот считается участником:
 * `count` в разговоре один-на-один никогда не станет единицей, `solo` не
 * включится, и строгий гейт по имени будет работать там, где по замыслу
 * ассистент отвечает свободно. Плюс его собственная речь может попасть в
 * `speaker`. Поэтому нормализуем обе стороны и сравниваем без учёта регистра.
 *
 * Обрезку длинного имени это не лечит — если Meet укоротит подпись, ключи всё
 * равно разойдутся. Дословное имя бота из встречи выясняет спайк (вопрос 4);
 * если у Attendee найдётся стабильный признак «это бот», перейдём на него.
 */
function nameKey(name: string): string {
  return String(name ?? '')
    .normalize('NFC')
    // Любой пробельный символ, включая неразрывный, считаем обычным пробелом.
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
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

  /** Имя собственного бота, приведённое к сравнимому виду. */
  private readonly selfKey?: string;

  /**
   * @param selfName имя, под которым в встрече сидит наш же бот. Attendee
   *   присылает его в join_leave наравне с людьми, и без исключения себя
   *   комната никогда не выглядела бы пустой: правила выхода не срабатывали
   *   бы, а гейт по имени не переходил бы в solo.
   */
  constructor(selfName?: string) {
    this.selfKey = selfName ? nameKey(selfName) : undefined;
  }

  /** Он ли это. Сравнение по нормализованному ключу, а не побайтово. */
  private isSelf(name: string): boolean {
    return !!this.selfKey && nameKey(name) === this.selfKey;
  }

  apply(e: ParticipantEvent): void {
    if (this.isSelf(e.name)) return;
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
    if (this.isSelf(name)) return;
    if (speaking) {
      // Говорящий заведомо ВО ВСТРЕЧЕ, и это единственный надёжный признак
      // присутствия, который у нас есть. Meet может отдать сидящего человека
      // со `status: 8`, Attendee переводит это в `leave` — и состав пустеет
      // под живым разговором (живая встреча 09.09.2026). Речь возвращает
      // человека обратно.
      if (!this.people.has(uuid)) this.people.set(uuid, name);
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
