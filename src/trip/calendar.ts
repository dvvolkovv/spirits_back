/*
 * «Штурман» календарь [Фаза 3, T6]. Read-only ICS: тянем личный (Yandex) и рабочий (Outlook/OWA)
 * календари, разворачиваем повторения и оставляем ТОЛЬКО события в окне поездки — приватность:
 * ничего вне окна не берём и не храним. Найденные события сворачиваются в contextLines шторки
 * (конфликты с выездом — тоном warn). Всё best-effort: недоступный календарь (напр. OWA 500) или
 * кривой ICS не должны ронять состояние поездки.
 */
import * as ical from 'node-ical';

export interface CalEvent {
  /** ISO-инстант начала события (UTC). */
  at: string;
  title: string;
  /** 'yandex' | 'corp' — источник, для иконки/отладки. */
  source: string;
}

export interface CalendarSource {
  url: string;
  source: string;
}

export interface CalContextLine {
  icon: string;
  text: string;
  tone?: 'ok' | 'warn' | 'crit';
}

// Owner's timezone — all plan datetimes are naive Yekaterinburg wall-clock, no DST in Russia.
const YEKT_OFFSET = '+05:00';
const CONFLICT_LOOKBEHIND_MS = 3 * 60 * 60 * 1000; // an event within 3h before departure competes with it

/** Parse a naive plan datetime ("2026-07-20T16:00:00") as a Yekaterinburg instant. */
function planInstant(naive: string): number {
  return new Date(naive.includes('+') || naive.endsWith('Z') ? naive : `${naive}${YEKT_OFFSET}`).getTime();
}

/**
 * Folds trip-window calendar events into contextLines for the sheet. An event whose start falls
 * within [departPlanned − 3h, endEstimated] is flagged as a conflict (⚠️/warn — you can't be at a
 * meeting and on the road); other in-window events are informational (📅). Deterministic given the
 * fixed Yekaterinburg timezone, so it's unit-testable alongside computeState.
 */
export function foldCalendarLines(
  events: CalEvent[],
  departPlanned: string,
  endEstimated: string,
): CalContextLine[] {
  const depart = planInstant(departPlanned);
  const end = planInstant(endEstimated);
  const conflictFrom = depart - CONFLICT_LOOKBEHIND_MS;
  const fmt = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Asia/Yekaterinburg',
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  return events.map((e) => {
    const t = new Date(e.at).getTime();
    const conflict = t >= conflictFrom && t <= end;
    const when = fmt.format(new Date(e.at)).replace(/,/g, '');
    return conflict
      ? { icon: '⚠️', text: `${when} — ${e.title} (пересекается с выездом)`, tone: 'warn' as const }
      : { icon: '📅', text: `${when} — ${e.title}` };
  });
}

/**
 * Парсит ICS-текст и возвращает события (с разворотом повторений через rrule), чьё начало попадает
 * в [start, end). node-ical для событий с TZID хранит DTSTART как «плавающее» UTC, и
 * rrule.between отдаёт вхождения в той же плавающей шкале — сравниваем их с окном, приведённым к
 * той же шкале (см. floatWindow в fetchCalendarEvents). Никогда не бросает.
 */
export function eventsFromIcs(icsText: string, source: string, start: Date, end: Date): CalEvent[] {
  let data: Record<string, any>;
  try {
    data = ical.parseICS(icsText) as any;
  } catch {
    return [];
  }
  const out: CalEvent[] = [];
  for (const key of Object.keys(data)) {
    const ev = data[key];
    if (!ev || ev.type !== 'VEVENT' || !ev.start) continue;
    const title = String(ev.summary || '').trim() || 'Событие';

    if (ev.rrule) {
      let occ: Date[] = [];
      try {
        occ = ev.rrule.between(start, end, true);
      } catch {
        occ = [];
      }
      const exdates: Record<string, any> = ev.exdate || {};
      for (const d of occ) {
        const iso = new Date(d).toISOString();
        // EXDATE keys in node-ical are date strings; skip cancelled occurrences.
        const dayKey = iso.slice(0, 10);
        if (Object.keys(exdates).some((k) => k.startsWith(dayKey))) continue;
        out.push({ at: iso, title, source });
      }
    } else {
      const s = new Date(ev.start);
      if (s >= start && s < end) out.push({ at: s.toISOString(), title, source });
    }
  }
  return out;
}

/**
 * Тянет несколько ICS-URL (best-effort, таймаут 8с каждый) и собирает события окна.
 * Возвращает отсортированный по времени список; недоступные источники молча пропускает.
 */
export async function fetchCalendarEvents(
  sources: CalendarSource[],
  start: Date,
  end: Date,
): Promise<CalEvent[]> {
  const all: CalEvent[] = [];
  for (const { url, source } of sources) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const text = await res.text();
      all.push(...eventsFromIcs(text, source, start, end));
    } catch {
      /* best-effort: unreachable calendar must not break trip state */
    }
  }
  all.sort((a, b) => a.at.localeCompare(b.at));
  return all;
}
