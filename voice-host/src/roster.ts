import { nameKey } from './presence.js';

export interface RosterEntry {
  name: string;
  /** Когда человек появился во встрече впервые, мс эпохи. */
  joinedAt: number;
}

/**
 * Кто был на встрече — для записи после неё (voice_calls.participants).
 *
 * Presence и occupancy держат ТЕКУЩИЙ состав и вышедших забывают; список
 * участников, наоборот, не забывает никого. Владелец 03.11.2026: «на
 * встречах записывать список участников».
 *
 * Ключ — имя, а не uuid: свой бот выдаёт uuid по порядку в списке
 * (`participant-1`, …), и перезашедший получил бы второй ряд. Цена —
 * тёзки схлопываются в одного; для списка «кто был» это приемлемо, а для
 * правил выхода (там считают по uuid) не используется.
 */
export class Roster {
  private readonly seenAt = new Map<string, RosterEntry>();
  private readonly selfKey?: string;

  /** @param selfName имя нашего же бота во встрече — его в список не пишем. */
  constructor(selfName?: string) {
    this.selfKey = selfName ? nameKey(selfName) : undefined;
  }

  seen(name: string, at: number): void {
    const key = nameKey(name);
    if (!key || key === this.selfKey || this.seenAt.has(key)) return;
    const clean = String(name).normalize('NFC').replace(/\s+/g, ' ').trim();
    this.seenAt.set(key, { name: clean, joinedAt: at });
  }

  get list(): RosterEntry[] {
    return [...this.seenAt.values()].map((e) => ({ ...e }));
  }
}
