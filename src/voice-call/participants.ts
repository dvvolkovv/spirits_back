/**
 * Список участников встречи — voice_calls.participants.
 *
 * Владелец 03.11.2026: «на встречах записывать список участников». Список
 * копит воркер (voice-host/src/roster.ts): каждый, кто появлялся во встрече,
 * с временем первого появления. Шлёт его в progress по ходу встречи и в
 * complete в конце — так обрыв до complete список не теряет.
 */
export interface MeetingParticipant {
  name: string;
  /** Когда человек появился во встрече впервые, мс эпохи. */
  joinedAt: number;
}

/** Потолки — от мусора в подписанном, но всё же внешнем запросе. */
const NAME_LIMIT = 200;
const LIST_LIMIT = 300;

const key = (name: string) => name.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();

/** Только правильные записи. Не массив (воркер прежней версии) — пустой список. */
export function cleanParticipants(raw: unknown): MeetingParticipant[] {
  if (!Array.isArray(raw)) return [];
  const out: MeetingParticipant[] = [];
  for (const p of raw) {
    const name = typeof p?.name === 'string' ? p.name.replace(/\s+/g, ' ').trim().slice(0, NAME_LIMIT) : '';
    if (!name || typeof p?.joinedAt !== 'number' || !Number.isFinite(p.joinedAt)) continue;
    out.push({ name, joinedAt: p.joinedAt });
    if (out.length >= LIST_LIMIT) break;
  }
  return out;
}

/**
 * Сохранённое из progress плюс пришедшее в complete. Ключ — имя, время —
 * самое раннее, порядок — по времени входа.
 */
export function mergeParticipants(a: MeetingParticipant[], b: MeetingParticipant[]): MeetingParticipant[] {
  const byName = new Map<string, MeetingParticipant>();
  for (const p of [...a, ...b]) {
    const k = key(p.name);
    const had = byName.get(k);
    if (!had || p.joinedAt < had.joinedAt) byName.set(k, { name: had?.name ?? p.name, joinedAt: p.joinedAt });
  }
  return [...byName.values()].sort((x, y) => x.joinedAt - y.joinedAt);
}

/** Строка для сообщения о встрече. У звонка участников нет — строки тоже. */
export function participantsLine(list: MeetingParticipant[]): string {
  return list.length ? `Участники: ${list.map((p) => p.name).join(', ')}.` : '';
}
