/**
 * Ответ специалиста нельзя вставлять, пока Роман говорит: он перебьёт сам себя
 * на полуслове. Копим и отдаём по сигналу «речь закончилась».
 */
export class PendingAnswers {
  private queue: string[] = [];
  private speaking = false;

  setSpeaking(v: boolean): void { this.speaking = v; }

  /** Вернёт текст, если вставлять можно прямо сейчас; иначе положит в очередь. */
  offer(text: string): string | null {
    if (this.speaking) { this.queue.push(text); return null; }
    return text;
  }

  /** Забрать накопленное — звать после окончания реплики. */
  drain(): string[] {
    const out = this.queue;
    this.queue = [];
    return out;
  }

  get size(): number { return this.queue.length; }
}
