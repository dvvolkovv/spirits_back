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

  private buffers = new Map<string, Int16Array[]>();

  push(participant: string, samples: Int16Array): void {
    if (!samples.length) return;
    const queue = this.buffers.get(participant) || [];
    queue.push(samples);
    while (this.countTicks(queue) > Mixer.MAX_BUFFERED_TICKS) queue.shift();
    this.buffers.set(participant, queue);
  }

  remove(participant: string): void {
    this.buffers.delete(participant);
  }

  bufferedTicks(participant: string): number {
    return this.countTicks(this.buffers.get(participant) || []);
  }

  /** Один смикшированный кадр. Вызывается ровно раз в TICK_MS. */
  tick(): Int16Array {
    const out = new Int16Array(SAMPLES_PER_TICK);
    for (const queue of this.buffers.values()) {
      const chunk = this.takeTick(queue);
      for (let i = 0; i < chunk.length; i++) {
        const sum = out[i] + chunk[i];
        // Ограничение обязательно: Int16Array переполняется молча, и сумма
        // двух громких голосов превращается в треск на противоположном знаке.
        out[i] = sum > 32767 ? 32767 : sum < -32768 ? -32768 : sum;
      }
    }
    return out;
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
