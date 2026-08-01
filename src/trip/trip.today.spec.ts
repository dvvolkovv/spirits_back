import { computeCopilotState } from './trip.service';
import { Task, CalEvent } from '../calendar/calendar.types';

// «Твой сегодня» [2026-08-01]: горизонт событий + зона дел (сегодня/просроченные) + «Дальше».
describe('computeCopilotState — модель «твой сегодня»', () => {
  const now = new Date('2026-08-01T09:00:00+05:00'); // сб, 9:00 Екб. Горизонт 36ч → до вс/пн ~21:00.

  const ev = (at: string, title: string, extra: Partial<CalEvent> = {}): CalEvent => ({ at, title, source: 'talerid', ...extra });
  const tk = (uid: string, title: string, extra: Partial<Task> = {}): Task => ({ uid, title, done: false, source: 'linkeon', ...extra });

  it('событие в горизонте показывается, за горизонтом → «Дальше»', () => {
    const s = computeCopilotState({
      now,
      events: [
        ev('2026-08-01T11:00:00+05:00', 'Синк сегодня'),
        ev('2026-08-04T14:00:00+05:00', 'Синк Триентос'), // понедельник, за горизонтом
      ],
      tasks: [],
    });
    expect(s.events!.map((e) => e.title)).toEqual(['Синк сегодня']);
    expect(s.next?.title).toBe('Синк Триентос');
  });

  it('просроченное дело ВИСИТ (overdue=true), не исчезает', () => {
    const s = computeCopilotState({
      now,
      events: [],
      tasks: [tk('t1', 'Умыться с гелем', { due: '2026-08-01T06:00:00+05:00' })], // 6:00 < now 9:00
    });
    const t = s.tasks!.find((x) => x.uid === 't1');
    expect(t).toBeDefined();
    expect(t!.overdue).toBe(true);
  });

  it('дело без срока («когда-нибудь») в зоне; дело далеко за горизонтом — нет', () => {
    const s = computeCopilotState({
      now,
      events: [],
      tasks: [
        tk('some', 'Купить билеты'), // без due
        tk('far', 'Дело на след. неделе', { due: '2026-08-06T10:00:00+05:00' }), // за горизонтом
      ],
    });
    const uids = s.tasks!.map((x) => x.uid);
    expect(uids).toContain('some');
    expect(uids).not.toContain('far');
  });

  it('рутина помечается isRoutine; done/dropped исключены из зоны', () => {
    const s = computeCopilotState({
      now,
      events: [],
      tasks: [
        tk('rt', 'Зарядка', { due: '2026-08-01T07:00:00+05:00', recurrence: { freq: 'daily' } as any }),
        tk('dn', 'Готово', { done: true }),
        tk('dp', 'Снято', { status: 'dropped' }),
      ],
    });
    const rt = s.tasks!.find((x) => x.uid === 'rt');
    expect(rt?.isRoutine).toBe(true);
    const uids = s.tasks!.map((x) => x.uid);
    expect(uids).not.toContain('dn');
    expect(uids).not.toContain('dp');
  });

  it('headline = ближайшее дело зоны; reminders хранят все задачи (совместимость)', () => {
    const s = computeCopilotState({
      now,
      events: [],
      tasks: [
        tk('a', 'Раннее дело', { due: '2026-08-01T06:00:00+05:00' }),
        tk('b', 'Позднее дело', { due: '2026-08-01T20:00:00+05:00' }),
        tk('c', 'Готово', { done: true }),
      ],
    });
    expect(s.headline).toContain('Раннее дело');
    expect(s.reminders.map((r) => r.id).sort()).toEqual(['a', 'b', 'c']);
  });
});
