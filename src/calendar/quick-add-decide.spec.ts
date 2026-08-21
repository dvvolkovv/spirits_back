import { CalendarService } from './calendar.service';

// Чистая логика решения quick-add (без сети/БД/LLM): что делать по разобранным слотам —
// болтовня / переспрос недостающего / создание. Обязательные слоты (owner 2026-08-21):
// событие = день+время+длительность; дело = как минимум день; рутина = день не нужен.
describe('CalendarService.decideQuickAdd', () => {
  const decide = (p: any) => CalendarService.decideQuickAdd(p);

  it('intent=chat → болтовня', () => {
    expect(decide({ intent: 'chat', title: 'что у меня завтра' }).kind).toBe('chat');
  });

  it('пустой title → болтовня (нечего добавлять)', () => {
    expect(decide({ intent: 'add', title: '  ' }).kind).toBe('chat');
  });

  it('событие со всем (день+время+длит.) → создаём', () => {
    const d = decide({ intent: 'add', kind: 'event', title: 'встреча', date: '2026-08-23', time: '15:00', durationMin: 60 });
    expect(d).toMatchObject({ kind: 'create', itemKind: 'event', title: 'встреча', date: '2026-08-23', time: '15:00', durationMin: 60 });
  });

  it('событие без времени и длительности (только день) → переспрос обоих', () => {
    const d = decide({ intent: 'add', kind: 'event', title: 'рыбалка', date: '2026-08-23' });
    expect(d.kind).toBe('clarify');
    expect((d as any).question).toBe('Во сколько и на сколько по времени?');
  });

  it('событие без длительности (день+время есть) → переспрос только длительности', () => {
    const d = decide({ intent: 'add', kind: 'event', title: 'встреча', date: '2026-08-23', time: '15:00' });
    expect(d.kind).toBe('clarify');
    expect((d as any).question).toBe('На сколько по времени?');
  });

  it('событие без дня (время+длит. есть) → переспрос дня', () => {
    const d = decide({ intent: 'add', kind: 'event', title: 'встреча', time: '15:00', durationMin: 30 });
    expect(d.kind).toBe('clarify');
    expect((d as any).question).toBe('На какой день?');
  });

  it('дело с днём (без времени) → создаём (время не обязательно)', () => {
    const d = decide({ intent: 'add', kind: 'task', title: 'прописка Саве', date: '2026-08-25' });
    expect(d).toMatchObject({ kind: 'create', itemKind: 'task', title: 'прописка Саве', date: '2026-08-25' });
    expect((d as any).time).toBeUndefined();
  });

  it('дело с днём и временем → создаём с временем', () => {
    const d = decide({ intent: 'add', kind: 'task', title: 'прописка', date: '2026-08-25', time: '10:30' });
    expect(d).toMatchObject({ kind: 'create', itemKind: 'task', time: '10:30' });
  });

  it('дело без дня → переспрос дня (иначе невидимо в лаунчере)', () => {
    const d = decide({ intent: 'add', kind: 'task', title: 'купить молоко' });
    expect(d.kind).toBe('clarify');
    expect((d as any).question).toBe('На какой день?');
  });

  it('рутина (recurrence) → создаём дело без требования дня', () => {
    const d = decide({ intent: 'add', kind: 'task', title: 'зарядка', recurrence: { freq: 'daily' } });
    expect(d.kind).toBe('create');
    expect((d as any).itemKind).toBe('task');
    expect((d as any).recurrence).toEqual({ freq: 'daily', byDay: undefined, interval: undefined });
  });

  it('«поехать на рыбалку в воскресенье» как событие с днём → переспрос времени+длит. (кейс владельца)', () => {
    const d = decide({ intent: 'add', kind: 'event', title: 'рыбалка с ребятами', date: '2026-08-23' });
    expect(d.kind).toBe('clarify');
    expect((d as any).question).toBe('Во сколько и на сколько по времени?');
  });

  it('невалидные форматы date/time игнорируются (как отсутствующие)', () => {
    const d = decide({ intent: 'add', kind: 'event', title: 'x', date: 'завтра', time: '3 часа', durationMin: 0 });
    expect(d.kind).toBe('clarify');
    expect((d as any).question).toBe('На какой день и во сколько и на сколько по времени?');
  });
});

describe('CalendarService.clarifyQuestion', () => {
  it('составляет вопрос из недостающих слотов', () => {
    expect(CalendarService.clarifyQuestion(['time', 'duration'])).toBe('Во сколько и на сколько по времени?');
    expect(CalendarService.clarifyQuestion(['date'])).toBe('На какой день?');
    expect(CalendarService.clarifyQuestion(['duration'])).toBe('На сколько по времени?');
  });
});
