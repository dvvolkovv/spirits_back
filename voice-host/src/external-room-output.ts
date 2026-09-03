import { voice } from '@livekit/agents';
import {
  AudioSource,
  LocalAudioTrack,
  Room,
  TrackPublishOptions,
  TrackSource,
} from '@livekit/rtc-node';
import type { AudioFrame } from '@livekit/rtc-node';

/**
 * Голос ассистента — в чужую комнату.
 *
 * Зеркало MixedRoomAudioInput: тот берёт звук участников из комнаты, этот
 * отдаёт туда речь ассистента. Вместе они позволяют вести встречу в комнате
 * Taler ID, не поднимая отдельный процесс-мост: сессия остаётся нашей, а оба
 * её конца смотрят наружу.
 *
 * Подмена штатная — `AgentOutput.audio` объявлен сеттером в
 * `@livekit/agents@1.7.0`, ровно как и вход.
 *
 * ВАЖНО: подставлять до `session.start()`. На своих комнатах порядок уже стоил
 * дня отладки — вход, поставленный после старта, молча игнорировался с
 * записью `input.audio is already set, ignoring` в лог. Здесь та же ловушка.
 */

/** Realtime отдаёт 48 кГц моно; частота источника обязана совпадать. */
const SAMPLE_RATE = 48_000;
const CHANNELS = 1;

export class ExternalRoomAudioOutput extends voice.AudioOutput {
  private source: AudioSource | null = null;
  private track: LocalAudioTrack | null = null;
  private publishing: Promise<void> | null = null;
  /** Считаем кадры: немой ассистент иначе не отличить от «никто не говорил». */
  private frames = 0;
  /** Идёт ли сейчас сегмент речи — от первого кадра до flush/clearBuffer. */
  private segmentOpen = false;
  /** Сколько миллисекунд отдано в этом сегменте: уходит в playbackPosition. */
  private playedMs = 0;

  constructor(private readonly room: Room, private readonly name = 'assistant') {
    super(SAMPLE_RATE);
  }

  /**
   * Публикация дорожки ленивая и ровно одна.
   *
   * Ленивая — потому что комната к моменту создания объекта может быть ещё не
   * подключена. Одна — потому что captureFrame зовётся десятки раз в секунду,
   * и без этой защиты мы опубликовали бы дорожку на каждый кадр.
   */
  private ensurePublished(): Promise<void> {
    if (this.publishing) return this.publishing;
    this.publishing = (async () => {
      const source = new AudioSource(SAMPLE_RATE, CHANNELS);
      const track = LocalAudioTrack.createAudioTrack(this.name, source);
      const opts = new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE });
      await this.room.localParticipant!.publishTrack(track, opts);
      this.source = source;
      this.track = track;
      console.log('[выход] дорожка ассистента опубликована в чужой комнате');
    })();
    return this.publishing;
  }

  async captureFrame(frame: AudioFrame): Promise<void> {
    await super.captureFrame(frame);
    await this.ensurePublished();
    if (!this.source) return;
    // Первый кадр сегмента — сигнал о начале воспроизведения. Его ждёт
    // сессия, чтобы понять, что реплика пошла в эфир.
    if (!this.segmentOpen) {
      this.segmentOpen = true;
      this.playedMs = 0;
      this.onPlaybackStarted(Date.now());
    }
    await this.source.captureFrame(frame);
    // Длительность кадра — по числу сэмплов: она уходит в playbackPosition.
    this.playedMs += (frame.samplesPerChannel / SAMPLE_RATE) * 1000;
    if (++this.frames % 250 === 0) {
      console.log(`[выход] кадров ассистента: ${this.frames}`);
    }
  }

  /**
   * Реплика досказана.
   *
   * Контракт SDK требует явно сообщить о конце сегмента: «Developers building
   * audio sinks MUST call this method when a playback/segment is finished».
   * Без этого `waitForPlayout` не разрешается, сессия считает реплику
   * незавершённой и НЕ добавляет её в разговор.
   *
   * Живая встреча 03.09.2026: ассистент говорил, человек его слышал, а в
   * транскрипте лежали девять реплик — все девять человеческие. Собственных
   * слов он не помнил и на вопрос «что ответили коллеги» отвечал так, будто
   * ничего не звучало.
   */
  flush(): void {
    super.flush();
    if (!this.segmentOpen) return;
    this.segmentOpen = false;
    const played = this.playedMs;
    // Ждём, пока источник действительно доиграет очередь: сообщить о конце
    // раньше времени — значит дать сессии начать следующую реплику поверх
    // недоговорённой.
    void (this.source?.waitForPlayout() ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.onPlaybackFinished({ playbackPosition: played, interrupted: false }));
  }

  /**
   * Ассистента перебили — сбросить недосказанное.
   *
   * Метод обязательный: без него в очереди источника остаётся звук уже
   * отменённой реплики, и она договаривается поверх нового собеседника. На
   * встрече, где перебивают постоянно, это слышно сразу.
   */
  clearBuffer(): void {
    this.source?.clearQueue();
    // Перебивание тоже закрывает сегмент — но как прерванный. Без этого
    // сессия ждала бы конца реплики, которой уже не будет.
    if (this.segmentOpen) {
      this.segmentOpen = false;
      this.onPlaybackFinished({ playbackPosition: this.playedMs, interrupted: true });
    }
  }

  /** Снять публикацию. Зовётся при закрытии сессии. */
  async close(): Promise<void> {
    try {
      if (this.track) await this.room.localParticipant?.unpublishTrack(this.track.sid!);
    } catch (e: any) {
      // Комната к этому моменту может быть уже разорвана — это не ошибка.
      console.log(`[выход] снятие дорожки: ${e?.message}`);
    }
    try {
      await this.source?.close();
    } catch {}
    this.source = null;
    this.track = null;
    this.publishing = null;
  }
}
