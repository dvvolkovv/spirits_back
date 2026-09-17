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
import { ReadableStream, TransformStream } from 'node:stream/web';
import { createWriteStream, readFileSync } from 'node:fs';
import { Mixer, TICK_MS } from './mixer.js';

/**
 * Частота, на которой работает Realtime, — и единственная, на которой его
 * можно кормить.
 *
 * Плагин OpenAI объявляет сессии `SAMPLE_RATE = 24000` и НЕ пересчитывает
 * приходящие кадры: `resampleAudio(frame) { yield frame; }`. Штатный вход SDK
 * поэтому сам приводит дорожки к 24 кГц (`resampleStream({ outputRate })`,
 * умолчание `audioSampleRate: 24000`), а наш собственный вход отдавал 48 кГц
 * — и API слушал наш звук как 24 кГц, то есть ВДВОЕ ЗАМЕДЛЕННЫМ, на октаву
 * ниже.
 *
 * Отсюда всё, что мы ловили три дня: гул вместо согласных (переходов через
 * ноль в семнадцать раз меньше, чем в исходнике), галлюцинации распознавания
 * на случайных языках и «ассистент слышит одного через раз» — до текста
 * доживало только то, что случайно выдерживало замедление. Синтетический
 * стенд 16.09.2026: тот же звук, поданный в отдельную сессию с правильной
 * частотой, распознаётся весь (7 реплик из 9), а живая сессия видела две.
 */
const INPUT_SAMPLE_RATE = 24_000;

/** Сэмплов в тике на нашей частоте: 24000 × 20 мс. */
const INPUT_SAMPLES_PER_TICK = (INPUT_SAMPLE_RATE * TICK_MS) / 1000;

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
  private mixer = new Mixer(true, INPUT_SAMPLES_PER_TICK);
  private ticker?: ReturnType<typeof setInterval>;
  private closed = false;
  private push: (frame: AudioFrame) => void = () => {};
  /** Сколько кадров реально пришло от участников — для диагностики. */
  private framesIn = 0;
  private ticks = 0;
  /** Сколько кадров у нас реально забрала сессия. */
  private framesTaken = 0;
  /** Очередь кадров к сессии. Нужна только ради `desiredSize` в логе. */
  private queue: ReadableStreamDefaultController<AudioFrame> | null = null;
  /**
   * Кто считался говорящим на прошлом тике.
   *
   * Замер раз в пять секунд о решениях микшера не говорит ничего: реплика
   * короче интервала, и в снимок попадают одни паузы. 16.09.2026 я на этом
   * дважды сделал неверный вывод — сначала «никого не усиливаем», потом
   * «фон обнуляется». Пишем СМЕНУ состояния, тогда в логе видно каждую
   * реплику и её усиление.
   */
  private wasSpeaking = new Map<string, boolean>();

  /**
   * Куда писать смикшированный поток. Пусто — не писать, и это обычный режим.
   *
   * Заведено 07.09.2026 под конкретный вопрос, на который иначе нет ответа:
   * тихого участника ассистент не слышал, при том что тракт публикации звук
   * доносит целым (запись с подписки распознаётся даже без усиления, на
   * уровне 157), а микшер поднимает его в сведении выше громкого. Оставалось
   * одно непросмотренное место — то, что микшер реально отдаёт в сессию.
   * Слушать это надо ушами и распознаванием, а не по счётчикам.
   */
  private readonly dumpPath = process.env.VOICE_MIX_DUMP || '';
  private dump?: import('node:fs').WriteStream;

  /**
   * Файл вместо комнаты — только для разбора.
   *
   * Когда задан `VOICE_INPUT_FILE`, вход берёт звук из файла (PCM s16 24 кГц
   * моно) и отдаёт его в сессию ровно так же, как речь участников. Это
   * единственный способ развести две оставшиеся версии: «теряет наш тракт
   * комнаты» и «теряет машинерия SDK» — при файле от эталонного клиента
   * отличается только вторая.
   *
   * 17.09.2026: сессия забирает все наши кадры, плагин отправляет в API ровно
   * реальное время, команд-разрушителей нет, а размечается 2 реплики из 9 —
   * при том что тот же звук через собственный клиент даёт 7.
   */
  private readonly fromFile = process.env.VOICE_INPUT_FILE || '';

  constructor(private readonly room: Room) {
    super();

    const source = new ReadableStream<AudioFrame>({
      start: (controller) => {
        // Держим ссылку на очередь: `desiredSize` уходит в минус ровно на
        // столько кадров, сколько сессия не забрала. Это единственный способ
        // увидеть, что модель перестала слушать: сам микшер при этом работает,
        // дамп пишется, и снаружи всё выглядит здоровым. 16.09.2026 на этом
        // ушёл день — ассистент оглох после переоткрытия сессии, а в логе не
        // было ни строки.
        this.queue = controller;
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
    /**
     * Счётчик на границе «мы отдали — SDK забрал».
     *
     * Внутрь потока встроен проходной этап: его `transform` вызывается ровно
     * тогда, когда потребитель вытягивает кадр. Сравнение с числом тиков
     * отвечает на вопрос, который иначе не закрыть: доходят ли наши кадры до
     * сессии вообще. 16.09.2026 стенд показал, что один и тот же звук в
     * отдельной сессии даёт 7 реплик, а в живой — 2, при исправном тракте до
     * самого входа.
     */
    const counted = source.pipeThrough(
      new TransformStream<AudioFrame, AudioFrame>({
        transform: (frame, controller) => {
          this.framesTaken++;
          controller.enqueue(frame);
        },
      }),
    );
    this.multiStream.addInputStream(counted);

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

    if (this.fromFile) {
      console.log(`[вход] РАЗБОРНЫЙ РЕЖИМ: звук из файла ${this.fromFile}, комната не слушается`);
      const pcm = readFileSync(this.fromFile);
      const all = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2);
      let off = 0;
      const feed = setInterval(() => {
        if (this.closed || off >= all.length) return;
        const chunk = new Int16Array(all.subarray(off, off + INPUT_SAMPLES_PER_TICK));
        off += INPUT_SAMPLES_PER_TICK;
        this.mixer.push('файл', chunk);
      }, TICK_MS);
      feed.unref?.();
    }

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

    if (this.dumpPath) {
      this.dump = createWriteStream(this.dumpPath);
      console.log(`[вход] пишу смикшированный поток в ${this.dumpPath} (PCM s16 ${INPUT_SAMPLE_RATE} моно)`);
    }

    /**
     * Тики отмеряются по ЧАСАМ, а не по срабатываниям таймера.
     *
     * setInterval(20) в Node срабатывает не через двадцать миллисекунд, а
     * через двадцать с небольшим: сколько именно — зависит от загрузки петли
     * событий. Отставание в один процент звучит безобидно, но оно копится:
     * кадры от участников приходят в реальном времени, а забираем мы их чуть
     * медленнее, очередь растёт, упирается в потолок в полсекунды — и дальше
     * куски выбрасываются ПОСТОЯННО, прямо из середины слов.
     *
     * Живой замер 16.09.2026: 185 000 тиков за 3737 секунд разговора, то есть
     * 3700 секунд звука — тридцать семь секунд потеряно. На стенде счётчик
     * выброшенных кусков рос до полусотни за минуту, и чистая фраза выходила
     * из микшера неразборчивой.
     *
     * Догоняем: сколько тиков должно было пройти по часам, столько и отдаём.
     * Потолок в 25 тиков (полсекунды) — на случай, если процесс замер: вывалить
     * в модель разом больше нельзя, у неё поедет разметка реплик.
     */
    const startedAt = Date.now();
    let emitted = 0;
    const emitOne = () => {
      const mixed = this.mixer.tick();
      for (const st of this.mixer.stats()) {
        if (this.wasSpeaking.get(st.participant) === st.speaking) continue;
        this.wasSpeaking.set(st.participant, st.speaking);
        console.log(
          st.speaking
            ? `[вход] ${st.participant} заговорил — усиление ×${st.gain} (уровень ${st.rms}, ` +
              `фон ${st.floor}, выброшено кусков ${st.dropped})`
            : `[вход] ${st.participant} замолчал`,
        );
      }
      // Тот же самый буфер, что уходит в сессию, — не пересчитанный заново.
      if (this.dump) this.dump.write(Buffer.from(mixed.buffer, mixed.byteOffset, mixed.byteLength));
      this.push(new AudioFrame(mixed, INPUT_SAMPLE_RATE, 1, INPUT_SAMPLES_PER_TICK));
      // Раз в пять секунд — сколько кадров пришло от людей. Без этой строки
      // отличить «никто не говорит» от «звук до нас не доходит» невозможно:
      // и то и другое выглядит как тишина. Три захода подряд я гадал именно
      // здесь.
      if (++this.ticks % 250 === 0) {
        // Раздельно по участникам, а не одним числом.
        //
        // Прежняя строка давала только сумму кадров, и по ней встреча
        // 07.09.2026 выглядела здоровой: поток ровный, три дорожки на месте.
        // А в транскрипт при этом попадал в основном один человек. Отличить
        // «остальные молчали» от «остальных не слышно» по сумме нельзя —
        // нужны громкость и доля речевых кадров у каждого.
        const per = this.mixer
          .stats()
          .map(
            (s) =>
              `${s.participant}: кадров ${s.frames}, речь ${s.speechFrames}, ур. ${s.rms}, фон ${s.floor}, ` +
              `${s.speaking ? `ГОВОРИТ ×${s.gain}` : 'молчит ×1'}`,
          )
          .join(' | ');
        // Отставание очереди — в кадрах. Ноль или около того значит, что
        // сессия забирает звук в реальном времени; растущий минус — оглохла.
        const behind = this.queue ? Math.max(0, -(this.queue.desiredSize ?? 0)) : 0;
        console.log(
          `[вход] тиков: ${this.ticks}, кадров от участников: ${this.framesIn}, ` +
          `забрала сессия: ${this.framesTaken}, очередь к модели: ${behind}, отставание тиков: ${Math.max(0, Math.floor((Date.now() - startedAt) / TICK_MS) - emitted)} — ${per}`,
        );
      }
    };

    this.ticker = setInterval(() => {
      if (this.closed) return;
      const due = Math.floor((Date.now() - startedAt) / TICK_MS) - emitted;
      const n = Math.min(Math.max(due, 1), 25);
      for (let i = 0; i < n; i++) {
        emitted++;
        emitOne();
      }
    }, TICK_MS);

    // unref обязателен: без него таймер держит event loop, процесс задания не
    // может завершиться, и фреймворк через минуту убивает его как «job is
    // unresponsive» — вместе с недоотправленным complete. Так дважды терялся
    // транскрипт (25 и 26.08.2026).
    this.ticker.unref?.();
  }

  /** Уже читаемые дорожки — чтобы не открыть два потока на одну. */
  private readonly attached = new Set<string>();
  /** Про кого уже написали геометрию кадров — строка нужна один раз. */
  private readonly geometryLogged = new Set<string>();
  /**
   * Дамп на каждого участника ДО сведения.
   *
   * Разделяет два случая, которые снаружи выглядят одинаково: звук уже
   * пришёл испорченным или мы портим его сами при сведении. 16.09.2026 без
   * этого пришлось бы гадать: смикшированный поток оказался неразборчивым
   * при здоровых громкости, длительности и отсутствии потерь.
   */
  private readonly perTrackDumps = new Map<string, import('node:fs').WriteStream>();

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
    console.log(`[вход] читаю дорожку ${key}`);
    void (async () => {
      const reader = new AudioStream(track, INPUT_SAMPLE_RATE, 1).getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done || this.closed) break;
          if (value) {
            // КОПИЯ, а не вид на чужую память.
            //
            // `value.data` принадлежит SDK, и следующий кадр может лечь в тот
            // же буфер. Мы же кладём массив в очередь микшера и держим его там
            // до тика, а дамп пишем потоком, который отдаёт данные позже. В
            // обоих случаях к моменту использования там оказывался уже другой
            // звук: громкость, длительность и огибающая правильные, содержимое
            // — каша. Синтетический стенд 16.09.2026: чистая фраза приходила
            // неразборчивой ещё ДО сведения, и ни на одной частоте не читалась.
            const data = new Int16Array(value.data);
            if (this.dumpPath) {
              let w = this.perTrackDumps.get(identity);
              if (!w) {
                w = createWriteStream(`${this.dumpPath}.${identity}.pcm`);
                this.perTrackDumps.set(identity, w);
              }
              w.write(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
            }
            if (!this.geometryLogged.has(identity)) {
              this.geometryLogged.add(identity);
              console.log(
                `[вход] геометрия кадров ${identity}: ${value.samplesPerChannel} сэмплов, ` +
                `${value.sampleRate} Гц, каналов ${value.channels}`,
              );
            }
            this.framesIn++;
            this.mixer.push(identity, data);
          }
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
    this.dump?.end();
    for (const w of this.perTrackDumps.values()) w.end();
    if (this.ticker) clearInterval(this.ticker);
    await super.close();
  }
}
