import { voice } from '@livekit/agents';
import {
  AudioFrame,
  AudioStream,
  RoomEvent,
  TrackKind,
  type RemoteParticipant,
  type RemoteTrack,
  type Room,
} from '@livekit/rtc-node';
import { ReadableStream } from 'node:stream/web';
import { Mixer, SAMPLE_RATE, SAMPLES_PER_TICK, TICK_MS } from './mixer.js';

/**
 * Вход сессии, собранный из ВСЕХ участников комнаты.
 *
 * Подставляется вместо штатного через `session.input.audio`. Штатный не
 * годится по двум причинам, обе видны прямо в типах SDK:
 *
 *   1. `RoomInputOptions.participantIdentity` — «If not provided, link to the
 *      first participant». В комнате на пятерых ассистент слышал бы только
 *      того, кто вошёл первым.
 *   2. `closeOnDisconnect` закрывает сессию, когда отключился именно
 *      связанный участник. Первый вышедший обрывал бы встречу всем.
 *
 * Сведение — суммой сэмплов, а не перемежением кадров: почему именно так,
 * подробно в mixer.ts.
 */
export class MixedRoomAudioInput extends voice.AudioInput {
  private mixer = new Mixer();
  private ticker?: ReturnType<typeof setInterval>;
  private closed = false;
  private push: (frame: AudioFrame) => void = () => {};

  constructor(private readonly room: Room) {
    super();

    const source = new ReadableStream<AudioFrame>({
      start: (controller) => {
        this.push = (frame) => {
          if (this.closed) return;
          try {
            controller.enqueue(frame);
          } catch {
            // Поток уже закрыт — тик мог опередить close(). Это не ошибка.
          }
        };
      },
    });
    this.multiStream.addInputStream(source);

    // Уже сидящие в комнате до нашего входа: TrackSubscribed по ним не придёт,
    // и без этого прохода начавшаяся раньше встреча звучала бы тишиной.
    for (const p of this.room.remoteParticipants.values()) {
      for (const pub of p.trackPublications.values()) {
        if (pub.track) this.attach(pub.track, p.identity);
      }
    }

    this.room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub, p: RemoteParticipant) => {
      this.attach(track, p.identity);
    });
    this.room.on(RoomEvent.ParticipantDisconnected, (p: RemoteParticipant) => {
      this.mixer.remove(p.identity);
    });

    this.ticker = setInterval(() => {
      if (this.closed) return;
      this.push(new AudioFrame(this.mixer.tick(), SAMPLE_RATE, 1, SAMPLES_PER_TICK));
    }, TICK_MS);

    // unref обязателен: без него таймер держит event loop, процесс задания не
    // может завершиться, и фреймворк через минуту убивает его как «job is
    // unresponsive» — вместе с недоотправленным complete. Так дважды терялся
    // транскрипт (25 и 26.08.2026).
    this.ticker.unref?.();
  }

  private attach(track: RemoteTrack, identity: string): void {
    if (track.kind !== TrackKind.KIND_AUDIO) return;
    void (async () => {
      const reader = new AudioStream(track, SAMPLE_RATE, 1).getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done || this.closed) break;
          if (value) this.mixer.push(identity, value.data);
        }
      } catch (e) {
        console.error(`поток участника ${identity} оборвался`, e);
      } finally {
        try { reader.releaseLock(); } catch { /* поток уже отдан */ }
        this.mixer.remove(identity);
      }
    })();
  }

  override async close(): Promise<void> {
    this.closed = true;
    if (this.ticker) clearInterval(this.ticker);
    await super.close();
  }
}
