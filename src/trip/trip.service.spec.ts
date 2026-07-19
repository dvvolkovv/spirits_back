import { computeCopilotState } from './trip.service';

const now = new Date('2026-07-19T10:00:00+05:00');
const task = (uid: string, title: string, due?: string, done = false) => ({ uid, title, due, done, source: 'yandex' });
const ev = (uid: string, title: string, at: string, end?: string) => ({ uid, title, at, end, source: 'yandex' });

describe('computeCopilotState', () => {
  it('headline = ближайшая незакрытая задача к сроку', () => {
    const s = computeCopilotState({
      tasks: [task('t1', 'Собрать вещи', '2026-07-20T09:00:00'), task('t2', 'Позже', '2026-07-25T09:00:00')],
      events: [],
      now,
    });
    expect(s.headline).toContain('Собрать вещи');
    expect(s.reminders.find((r) => r.id === 't1')?.done).toBe(false);
  });

  it('выполненные задачи не в headline', () => {
    const s = computeCopilotState({
      tasks: [task('t1', 'Готово', '2026-07-20T09:00:00', true)],
      events: [],
      now,
    });
    expect(s.reminders.find((r) => r.id === 't1')?.done).toBe(true);
    expect(s.headline).not.toContain('Готово');
  });

  it('нет задач и событий -> спокойный дефолт', () => {
    const s = computeCopilotState({ tasks: [], events: [], now });
    expect(s.headline).toBe('Пока всё спокойно');
  });

  it('нет незакрытых задач -> headline из ближайшего события', () => {
    const s = computeCopilotState({
      tasks: [task('t1', 'Готово', '2026-07-20T09:00:00', true)],
      events: [ev('e1', 'Встреча', '2026-07-20T10:00:00Z')],
      now,
    });
    expect(s.headline).toContain('Встреча');
  });

  it('конфликт = реальное пересечение событий, а не «за 3ч до»', () => {
    // синк 15:00–16:00 + встреча-выезд 16:00–17:00 → НЕ конфликт (встык)
    const s1 = computeCopilotState({
      tasks: [],
      events: [
        ev('e1', 'Синк', '2026-07-20T10:00:00Z', '2026-07-20T11:00:00Z'),
        ev('e2', 'Выезд', '2026-07-20T11:00:00Z', '2026-07-20T12:00:00Z'),
      ],
      now,
    });
    expect(s1.contextLines.some((l) => l.tone === 'warn')).toBe(false);

    // встреча 15:30–16:30 пересекается с выездом 16:00 → конфликт
    const s2 = computeCopilotState({
      tasks: [],
      events: [
        ev('e1', 'Встреча', '2026-07-20T10:30:00Z', '2026-07-20T11:30:00Z'),
        ev('e2', 'Выезд', '2026-07-20T11:00:00Z', '2026-07-20T12:00:00Z'),
      ],
      now,
    });
    expect(s2.contextLines.some((l) => l.tone === 'warn')).toBe(true);
  });

  it('reminders содержат все задачи (done и pending), timeTriggers — только pending с due', () => {
    const s = computeCopilotState({
      tasks: [
        task('t1', 'Собрать вещи', '2026-07-20T09:00:00'),
        task('t2', 'Готово', '2026-07-18T09:00:00', true),
        task('t3', 'Без срока'),
      ],
      events: [],
      now,
    });
    expect(s.reminders.length).toBe(3);
    expect(s.timeTriggers.map((t) => t.id)).toEqual(['task-t1']);
  });

  it('serverTime и version проставлены', () => {
    const s = computeCopilotState({ tasks: [], events: [], now });
    expect(s.version).toBeGreaterThan(0);
    expect(s.serverTime).toBe(now.toISOString());
  });

  it('конфликт детектится между двумя событиями БЕЗ uid (ICS-источник)', () => {
    const events = [
      { title: 'Личная', at: '2026-07-20T10:00:00Z', end: '2026-07-20T11:00:00Z', source: 'yandex' },
      { title: 'Рабочая', at: '2026-07-20T10:30:00Z', end: '2026-07-20T11:30:00Z', source: 'corp' },
    ] as any;
    const s = computeCopilotState({ tasks: [], events, now });
    expect(s.contextLines.filter((l) => l.tone === 'warn').length).toBe(2);
  });
});
