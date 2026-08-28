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

    // ПОДПИСЫВАЕМСЯ САМИ — вот это и было главной поломкой.
    //
    // Штатный RoomIO подписывается на дорожку одного связанного участника. Мы
    // его вход заменили своим, и подписку после этого не делает никто: в логах
    // задания было видно `"subscribed": false` у аудиодорожки собеседника, а
    // TrackSubscribed не приходил ни разу. Ассистент сидел во встрече глухим,
    // хотя дорожку видел. Живая встреча 27.08.2026.
    //
    // Идемпотентно: setSubscribed(true) на уже подписанной публикации ничего
    // не ломает.
    const subscribe = (p: RemoteParticipant): void => {
      for (const pub of p.trackPublications.values()) {
        // ВАЖНО: не пропускаем публикации с неизвестным kind.
        //
        // `TrackPublication.kind` объявлен как `TrackKind | undefined` — в
        // момент, когда мы подписываемся, данные публикации могут быть ещё не
        // заполнены. Прежнее условие `kind !== KIND_AUDIO` тогда отсекало
        // дорожку целиком, и в логе оставалось `"subscribed": false`, а
        // ассистент сидел глухим. Живая встреча 28.08.2026.
        //
        // Видео в наших комнатах не публикуется вовсе, так что подписаться на
        // лишнее мы не рискуем; а если оно появится — отфильтрует attach по
        // самой дорожке, где kind уже определён.
        if (pub.kind !== undefined && pub.kind !== TrackKind.KIND_AUDIO) continue;
        if (!pub.subscribed) {
          console.log(`подписываюсь на дорожку ${p.identity} (kind=${pub.kind ?? 'неизвестен'})`);
          pub.setSubscribed(true);
        }
        // Дорожка уже могла приехать до подписки — тогда события не будет.
        if (pub.track) this.attach(pub.track, p.identity);
      }
    };

    for (const p of this.room.remoteParticipants.values()) subscribe(p);

    // Участник вошёл позже нас или опубликовал микрофон не сразу.
    this.room.on(RoomEvent.ParticipantConnected, (p: RemoteParticipant) => subscribe(p));
    this.room.on(RoomEvent.TrackPublished, (_pub, p: RemoteParticipant) => subscribe(p));

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

  /** Уже читаемые дорожки — чтобы не открыть два потока на одну. */
  private readonly attached = new Set<string>();

  private attach(track: RemoteTrack, identity: string): void {
    if (track.kind !== TrackKind.KIND_AUDIO) return;
    // attach зовётся и напрямую при подписке, и из TrackSubscribed. Без этой
    // защиты на одну дорожку открылось бы два ридера, и кадры пошли бы в
    // микшер дважды — то есть громкость этого участника удвоилась бы.
    // sid у дорожки может быть не задан — ключ строим вместе с участником,
    // так он и уникальнее, и всегда определён.
    const key = `${identity}:${track.sid ?? 'no-sid'}`;
    if (this.attached.has(key)) return;
    this.attached.add(key);
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
        this.attached.delete(key);
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
