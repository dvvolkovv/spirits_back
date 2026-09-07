/** Частота на всём пути моста. Ресемплинга в нашем коде нет нигде. */
export const SAMPLE_RATE = 48_000;

/** Длина тика. 20 мс — стандартный размер пакета WebRTC. */
export const TICK_MS = 20;

export const SAMPLES_PER_TICK = (SAMPLE_RATE * TICK_MS) / 1000; // 960

/**
 * Сведение речи участников встречи в один поток.
 *
 * Realtime принимает ровно один вход, а AgentSession из коробки слышит только
 * одного участника: RoomInputOptions прямым текстом — «link to the first
 * participant». Значит сводить обязан кто-то, и это мы.
 *
 * Складываем сэмплы, а НЕ перемежаем кадры. У AudioInput внутри лежит
 * MultiInputStream с addInputStream(), и соблазнительно отдать ему по потоку
 * на участника — но он именно перемежает: дорожки LiveKit публикуются
 * непрерывно, и при пятерых в поток пошло бы пять кадров на каждые 20 мс
 * реального времени. Realtime получал бы аудио впятеро быстрее реального и не
 * понял бы ничего — причём постоянно, а не только при наложении речи.
 *
 * Кадры приходят вразнобой и разной длины, поэтому выравнивать их не пытаемся:
 * у каждого участника свой буфер, тикер раз в 20 мс забирает из каждого по 960
 * сэмплов. Нет данных — тишина, и молчащий не тормозит говорящего.
 */
/** Что мы держим по каждому участнику: его звук и его громкость. */
interface Track {
  queue: Int16Array[];
  /** Сколько кадров пришло всего — отличает «молчит» от «звук не доходит». */
  frames: number;
  /** Сколько из них были речью, а не тишиной. */
  speechFrames: number;
  /** Скользящая громкость речи. Ноль — речи ещё не было. */
  speechRms: number;
}

/** Среднеквадратичная громкость кадра. */
function rmsOf(samples: Int16Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

export class Mixer {
  /**
   * Потолок буфера — полсекунды.
   *
   * Участник может слать быстрее, чем мы читаем: рассинхрон часов, всплеск
   * сети. Без потолка буфер растёт неограниченно — сначала это задержка,
   * которая только копится, потом память. Лучше выкинуть старое: во встрече
   * важна свежая речь, а не полная.
   */
  static readonly MAX_BUFFERED_TICKS = 25;

  /**
   * Целевой уровень речи в сведении, RMS для int16 (≈ −20 dBFS).
   *
   * Ниже него участника ПОДНИМАЕМ, выше — не трогаем. Только вверх и никогда
   * вниз: громкого в комнате слышно и так, а тихого не слышно вовсе, и
   * приглушать первого ради второго значило бы чинить одно, ломая другое.
   */
  static readonly TARGET_RMS = 3000;

  /**
   * Ниже этого уровня кадр считается тишиной и в оценку громкости не идёт.
   *
   * Без порога средняя громкость участника считалась бы вместе с паузами, а
   * пауз на встрече больше, чем речи: у молчащего оценка уехала бы к нулю, и
   * усиление выкрутилось бы в потолок на его фоновом шуме.
   */
  static readonly NOISE_FLOOR_RMS = 300;

  /** Потолок усиления. Больше — и шум тихого микрофона станет громче речи. */
  static readonly MAX_GAIN = 8;

  private tracks = new Map<string, Track>();

  push(participant: string, samples: Int16Array): void {
    if (!samples.length) return;
    const t = this.track(participant);
    t.queue.push(samples);
    while (this.countTicks(t.queue) > Mixer.MAX_BUFFERED_TICKS) t.queue.shift();
    t.frames++;
    const rms = rmsOf(samples);
    if (rms > Mixer.NOISE_FLOOR_RMS) {
      // Скользящее среднее по РЕЧЕВЫМ кадрам: оценка не должна прыгать от
      // одного громкого слога и не должна проседать в паузах.
      t.speechRms = t.speechRms === 0 ? rms : t.speechRms * 0.95 + rms * 0.05;
      t.speechFrames++;
    }
  }

  remove(participant: string): void {
    this.tracks.delete(participant);
  }

  bufferedTicks(participant: string): number {
    return this.countTicks(this.tracks.get(participant)?.queue || []);
  }

  /**
   * Во сколько раз поднимаем участника, чтобы он не тонул в сведении.
   *
   * Зачем это вообще. Встреча 07.09.2026: трое участников, аудио всех троих
   * дошло до микшера (в логе три подписки и ровный поток кадров весь час), но
   * в транскрипт попал в основном владелец. У остальных двоих остались обрывки
   * в два-три слова — при том, что они, по словам владельца, обращались к
   * ассистенту прямо по имени, и ни одного такого обращения в записи нет.
   * Складывая дорожки как есть, мы сохраняем разницу в громкости микрофонов:
   * тихий удалённый участник тонет под громким, и распознавание разбирает
   * только верхний голос.
   */
  gainFor(participant: string): number {
    const t = this.tracks.get(participant);
    if (!t || t.speechRms < Mixer.NOISE_FLOOR_RMS) return 1;
    const gain = Mixer.TARGET_RMS / t.speechRms;
    return Math.min(Math.max(gain, 1), Mixer.MAX_GAIN);
  }

  /** Что слышно от каждого участника — для диагностики в логе. */
  stats(): { participant: string; frames: number; speechFrames: number; rms: number; gain: number }[] {
    return [...this.tracks.entries()].map(([participant, t]) => ({
      participant,
      frames: t.frames,
      speechFrames: t.speechFrames,
      rms: Math.round(t.speechRms),
      gain: Number(this.gainFor(participant).toFixed(2)),
    }));
  }

  /** Один смикшированный кадр. Вызывается ровно раз в TICK_MS. */
  tick(): Int16Array {
    const out = new Int16Array(SAMPLES_PER_TICK);
    for (const [participant, t] of this.tracks) {
      const chunk = this.takeTick(t.queue);
      const gain = this.gainFor(participant);
      for (let i = 0; i < chunk.length; i++) {
        const sum = out[i] + chunk[i] * gain;
        // Ограничение обязательно: Int16Array переполняется молча, и сумма
        // двух громких голосов превращается в треск на противоположном знаке.
        out[i] = sum > 32767 ? 32767 : sum < -32768 ? -32768 : sum;
      }
    }
    return out;
  }

  private track(participant: string): Track {
    let t = this.tracks.get(participant);
    if (!t) {
      t = { queue: [], frames: 0, speechFrames: 0, speechRms: 0 };
      this.tracks.set(participant, t);
    }
    return t;
  }

  private countTicks(queue: Int16Array[]): number {
    let n = 0;
    for (const c of queue) n += c.length;
    return Math.ceil(n / SAMPLES_PER_TICK);
  }

  /** Снять с очереди ровно тик; если данных меньше — сколько есть. */
  private takeTick(queue: Int16Array[]): Int16Array {
    const out = new Int16Array(SAMPLES_PER_TICK);
    let filled = 0;
    while (filled < SAMPLES_PER_TICK && queue.length) {
      const head = queue[0];
      const need = SAMPLES_PER_TICK - filled;
      if (head.length <= need) {
        out.set(head, filled);
        filled += head.length;
        queue.shift();
      } else {
        out.set(head.subarray(0, need), filled);
        // subarray, а не slice: slice на Int16Array поверх чужого буфера ведёт
        // себя непредсказуемо — про это есть прямое предупреждение в примерах
        // rtc-node.
        queue[0] = head.subarray(need);
        filled += need;
      }
    }
    // Длина всегда SAMPLES_PER_TICK: недобранный хвост остаётся тишиной. Тик
    // обязан быть ровным, иначе поток в Realtime поедет по времени.
    return out;
  }
}
