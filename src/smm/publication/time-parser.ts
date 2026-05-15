// src/smm/publication/time-parser.ts
/**
 * Parses a flexible human time string into a Date.
 * Supports:
 *   - ISO timestamps:           "2026-05-16T18:00:00+03:00"
 *   - "сейчас" / "now"          → returns null (treated as immediate publish)
 *   - "через час"               → now + 1h
 *   - "через 30 минут"
 *   - "завтра в 18" / "завтра в 18:00"
 *   - "сегодня в 22"
 *
 * Returns Date for future timestamps, null for "now"/empty.
 * Throws Error on unparseable input or past dates.
 */
export function parseScheduleTime(input: string | null | undefined): Date | null {
  if (!input) return null;
  const s = input.trim().toLowerCase();
  if (s === 'сейчас' || s === 'now' || s === '') return null;

  const now = new Date();

  // ISO
  if (/^\d{4}-\d{2}-\d{2}t/i.test(s)) {
    const d = new Date(s);
    if (isNaN(d.getTime())) throw new Error(`Invalid ISO date: ${input}`);
    if (d.getTime() < now.getTime() - 60_000) throw new Error(`Scheduled time is in the past: ${input}`);
    return d;
  }

  // "через час" / "через день" (no number — implicit 1)
  // Note: \b does not work with Cyrillic; use lookahead (?=\s|$) instead
  const bareMatch = s.match(/через\s+(час|день|минуту)(?=\s|$)/);
  if (bareMatch) {
    const word = bareMatch[1];
    let ms = 0;
    if (word === 'час') ms = 3600_000;
    else if (word === 'день') ms = 86400_000;
    else if (word === 'минуту') ms = 60_000;
    return new Date(now.getTime() + ms);
  }

  // "через X минут / часов"
  const inMatch = s.match(/через\s+(\d+)\s*(минут|мин|часов?|ч|дней?)/);
  if (inMatch) {
    const n = parseInt(inMatch[1], 10);
    const unit = inMatch[2];
    let ms = 0;
    if (unit.startsWith('мин')) ms = n * 60_000;
    else if (unit.startsWith('ч') || unit.startsWith('час')) ms = n * 3600_000;
    else if (unit.startsWith('д')) ms = n * 86400_000;
    return new Date(now.getTime() + ms);
  }

  // "завтра в HH" / "сегодня в HH:MM"
  const todayTomMatch = s.match(/(сегодня|завтра|послезавтра)\s+в\s+(\d{1,2})(?::(\d{2}))?/);
  if (todayTomMatch) {
    const day = todayTomMatch[1];
    const hour = parseInt(todayTomMatch[2], 10);
    const min = todayTomMatch[3] ? parseInt(todayTomMatch[3], 10) : 0;
    if (hour < 0 || hour > 23) throw new Error(`Bad hour: ${hour}`);
    const d = new Date(now);
    if (day === 'завтра') d.setDate(d.getDate() + 1);
    else if (day === 'послезавтра') d.setDate(d.getDate() + 2);
    d.setHours(hour, min, 0, 0);
    if (d.getTime() < now.getTime() - 60_000) throw new Error(`Scheduled time is in the past`);
    return d;
  }

  throw new Error(`Unparseable schedule time: "${input}". Use ISO timestamp or "завтра в 18".`);
}
