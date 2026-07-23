export interface Recurrence {
  freq: 'daily' | 'weekly';
  byDay?: string[];
  interval?: number;
  count?: number;
  until?: string;
}

const OFFSET = '+05:00'; // Asia/Yekaterinburg, no DST
const DOW = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']; // Date#getDay() index -> RRULE day code
const MAX_ITERATIONS = 366;

function timePart(naive: string): string {
  const m = /T(\d{2}:\d{2}:\d{2})/.exec(naive);
  return m ? m[1] : '00:00:00';
}

function datePart(naive: string): string {
  return naive.slice(0, 10);
}

/** Add `days` calendar days to a naive-local "YYYY-MM-DD" date string, returned in the same form. */
function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00${OFFSET}`);
  d.setUTCDate(d.getUTCDate() + days);
  // Render back to Asia/Yekaterinburg calendar date.
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Yekaterinburg', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

/**
 * Day-of-week of a "YYYY-MM-DD" calendar date, independent of any timezone offset.
 * (Constructing `new Date(`${dateStr}T00:00:00${OFFSET}`)` and calling getUTCDay() would shift
 * the instant back across midnight into the previous UTC calendar day for a positive offset —
 * the day-of-week of a calendar date never depends on timezone, so compute it from Date.UTC
 * with the date's own y/m/d components instead.)
 */
function dowOf(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function expandOccurrences(e: { datetime?: string; recurrence?: Recurrence; dates?: string[] }): string[] {
  if (e.dates && e.dates.length > 0) {
    return [...e.dates].sort((a, b) => a.localeCompare(b)).slice(0, 100);
  }

  if (e.recurrence && e.datetime) {
    const { freq, byDay, interval, count, until } = e.recurrence;
    const step = interval && interval > 1 ? interval : 1;
    const startDate = datePart(e.datetime);
    const time = timePart(e.datetime);
    const untilLimit = until ? new Date(`${until}T23:59:59${OFFSET}`) : undefined;
    const startDow = dowOf(startDate);

    const out: string[] = [];
    for (let dayOffset = 0; dayOffset < MAX_ITERATIONS; dayOffset++) {
      const curDateStr = addDays(startDate, dayOffset);
      const curDow = dowOf(curDateStr);
      let matches = false;
      if (freq === 'daily') {
        matches = dayOffset % step === 0;
      } else {
        // weekly
        const dayCode = DOW[curDow];
        const dayMatches = byDay && byDay.length > 0 ? byDay.includes(dayCode) : curDow === startDow;
        const weekIndex = Math.floor(dayOffset / 7);
        matches = dayMatches && weekIndex % step === 0;
      }
      if (matches) {
        const candidate = `${curDateStr}T${time}`;
        const candidateDate = new Date(`${candidate}${OFFSET}`);
        if (untilLimit && candidateDate.getTime() > untilLimit.getTime()) break;
        out.push(candidate);
        if (count && out.length >= count) break;
      }
    }
    return out.slice(0, 366);
  }

  if (e.datetime) return [e.datetime];
  return [];
}
