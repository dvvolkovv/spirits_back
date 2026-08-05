// Ф3 day framing — ЧИСТЫЙ модуль (без БД/LLM), детерминированные факты + окно + хеш.
import { createHash } from 'crypto';

export type DayWindow = 'morning' | 'evening' | null;
type CalEvent = { at: string; title: string; end?: string };
type Task = { uid?: string; title: string; status?: string; due?: string; done?: boolean; isRoutine?: boolean };

const TZ = 'Asia/Yekaterinburg';
const parse = (s?: string) => (s ? new Date(s).getTime() : NaN);
const localHour = (ms: number, tz = TZ) =>
  Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).format(new Date(ms)));
const localDay = (ms: number, tz = TZ) =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: tz }).format(new Date(ms)); // YYYY-MM-DD
const isDone = (t: Task) => t.done || t.status === 'done';
const isPending = (t: Task) => !isDone(t) && t.status !== 'dropped' && !!t.title?.trim();

/** Сегодняшние (по локальному дню) события, отсортированы по времени. */
function todaysEvents(now: Date, events: CalEvent[]): CalEvent[] {
  const day = localDay(now.getTime());
  return events
    .filter((e) => e.title?.trim() && !Number.isNaN(parse(e.at)) && localDay(parse(e.at)) === day)
    .sort((a, b) => parse(a.at) - parse(b.at));
}

export function activeWindow(now: Date, events: CalEvent[], tz = TZ): DayWindow {
  const h = localHour(now.getTime(), tz);
  if (h < 5) return null; // ещё «ночь»
  const evs = todaysEvents(now, events);
  const nowMs = now.getTime();
  const firstStart = evs.length ? parse(evs[0].at) : NaN;
  const lastEnd = evs.length ? Math.max(...evs.map((e) => (e.end ? parse(e.end) : parse(e.at) + 3_600_000))) : NaN;
  // Утро: до старта первого события, но не позже 12:00.
  if (h < 12 && (Number.isNaN(firstStart) || nowMs < firstStart)) return 'morning';
  // Вечер: после конца последнего события, или после 18:00 если событий нет.
  if (evs.length ? nowMs >= lastEnd : h >= 18) return 'evening';
  return null;
}

function freeSlots(now: Date, evs: CalEvent[], minMin = 30): { start: string; end: string }[] {
  const out: { start: string; end: string }[] = [];
  for (let i = 0; i < evs.length - 1; i++) {
    const end = evs[i].end ? parse(evs[i].end) : parse(evs[i].at) + 3_600_000;
    const next = parse(evs[i + 1].at);
    if (next - end >= minMin * 60_000) out.push({ start: new Date(end).toISOString(), end: new Date(next).toISOString() });
  }
  return out;
}

export function buildMorningFacts(input: { now: Date; events: CalEvent[]; tasks: Task[] }) {
  const evs = todaysEvents(input.now, input.events);
  const unfinished = input.tasks.filter(isPending).map((t) => ({ title: t.title, due: t.due, routine: !!t.isRoutine }));
  return {
    kind: 'morning' as const,
    eventCount: evs.length,
    firstEvent: evs[0] ? { title: evs[0].title, at: evs[0].at } : null,
    events: evs.map((e) => ({ title: e.title, at: e.at })),
    unfinished,
    freeSlots: freeSlots(input.now, evs),
  };
}

export function buildEveningFacts(input: { now: Date; events: CalEvent[]; tasks: Task[] }) {
  const unfinished = input.tasks.filter(isPending).map((t) => ({ title: t.title }));
  return {
    kind: 'evening' as const,
    unfinishedCount: unfinished.length,
    unfinished,
    eventCount: todaysEvents(input.now, input.events).length,
  };
}

export function factsHash(facts: object): string {
  return createHash('sha1').update(JSON.stringify(facts)).digest('hex').slice(0, 16);
}
