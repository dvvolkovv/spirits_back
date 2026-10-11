import { CalendarService } from './calendar.service';

// Чистая логика решения quick-add (без сети/БД/LLM): что делать по разобранным слотам —
// болтовня / переспрос недостающего / создание. Обязательные слоты:
// событие = день+время; дело = как минимум день; рутина = день не нужен.
// ⚠️ Длительность была обязательной с 21.08.2026 и перестала быть 11.10.2026 (owner):
// «завтра в 15:25 флюорография у Савы» не создавалось, а переспрос «На сколько по
// времени?» читался как требование указать время, которое было названо.
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

  it('событие без времени (только день) → переспрос времени', () => {
    const d = decide({ intent: 'add', kind: 'event', title: 'рыбалка', date: '2026-08-23' });
    expect(d.kind).toBe('clarify');
    expect((d as any).question).toBe('Во сколько?');
  });

  it('КЕЙС ВЛАДЕЛЬЦА 11.10.2026 (вечер): «занятие Савы в 8:15» → СОЗДАЁМ, а не переспрос', () => {
    const d = decide({ intent: 'add', kind: 'event', title: 'занятие Савы с Вероникой',
                       date: '2026-10-12', time: '8:15' });
    expect(d).toMatchObject({ kind: 'create', itemKind: 'event', time: '08:15', durationMin: 60 });
  });

  it('КЕЙС ВЛАДЕЛЬЦА 11.10.2026: день+время без длительности → СОЗДАЁМ (час по умолчанию)', () => {
    const d = decide({ intent: 'add', kind: 'event', title: 'флюорография у Савы', date: '2026-10-12', time: '15:25' });
    expect(d).toMatchObject({ kind: 'create', itemKind: 'event', date: '2026-10-12', time: '15:25', durationMin: 60 });
  });

  it('названную длительность уважаем, а не затираем умолчанием', () => {
    const d = decide({ intent: 'add', kind: 'event', title: 'созвон', date: '2026-10-12', time: '15:00', durationMin: 15 });
    expect((d as any).durationMin).toBe(15);
  });

  it('событие без дня (время есть) → переспрос дня', () => {
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

  it('«поехать на рыбалку в воскресенье» как событие с днём → переспрос времени (кейс владельца 21.08)', () => {
    const d = decide({ intent: 'add', kind: 'event', title: 'рыбалка с ребятами', date: '2026-08-23' });
    expect(d.kind).toBe('clarify');
    expect((d as any).question).toBe('Во сколько?');
  });

  it('невалидные форматы date/time игнорируются (как отсутствующие)', () => {
    const d = decide({ intent: 'add', kind: 'event', title: 'x', date: 'завтра', time: '3 часа', durationMin: 0 });
    expect(d.kind).toBe('clarify');
    expect((d as any).question).toBe('На какой день и во сколько?');
  });
});

describe('CalendarService.dateReference', () => {
  it('раскладывает дни недели по датам (пятница 2026-08-21 → воскресенье=23, понедельник=24)', () => {
    // localNow = местный полдень пятницы 21.08.2026 (в сервисе это now+5ч, читается UTC-геттерами).
    const localNow = new Date('2026-08-21T12:00:00Z');
    const ref = CalendarService.dateReference(localNow);
    expect(ref).toContain('2026-08-21 — пятница — сегодня');
    expect(ref).toContain('2026-08-22 — суббота — завтра');
    expect(ref).toContain('2026-08-23 — воскресенье');       // БАГ был: «воскресенье» уезжало на 24
    expect(ref).toContain('2026-08-24 — понедельник');
    expect(ref.split('\n')).toHaveLength(8);
  });
});

describe('CalendarService.normalizeTime', () => {
  // ⚠️ Баг владельца 11.10.2026: «занятие Савы с Вероникой в 8:15» не добавлялось, помощник
  // переспрашивал время, которое уже названо. Проверка требовала ДВУХ цифр в часах, а люди
  // говорят «в 8:15» и «в 9:00» — и модель возвращает ровно сказанное. Теряло все утренние
  // события, то есть почти все детские занятия.
  const t = (x: unknown) => CalendarService.normalizeTime(x);

  it('одна цифра в часах принимается и дополняется нулём', () => {
    expect(t('8:15')).toBe('08:15');
    expect(t('9:00')).toBe('09:00');
    expect(t('0:05')).toBe('00:05');
  });

  it('две цифры работают как раньше', () => {
    expect(t('15:25')).toBe('15:25');
    expect(t('08:15')).toBe('08:15');
    expect(t('23:59')).toBe('23:59');
  });

  it('пробелы по краям не мешают', () => {
    expect(t(' 8:15 ')).toBe('08:15');
  });

  it('не время — undefined', () => {
    expect(t('3 часа')).toBeUndefined();
    expect(t('утром')).toBeUndefined();
    expect(t(null)).toBeUndefined();
    expect(t(undefined)).toBeUndefined();
    expect(t('815')).toBeUndefined();
  });

  it('формат соблюдён, а времени не существует — undefined', () => {
    expect(t('25:00')).toBeUndefined();
    expect(t('12:70')).toBeUndefined();
  });
});

describe('CalendarService.clarifyQuestion', () => {
  it('составляет вопрос из недостающих слотов', () => {
    expect(CalendarService.clarifyQuestion(['time', 'duration'])).toBe('Во сколько и на сколько по времени?');
    expect(CalendarService.clarifyQuestion(['date'])).toBe('На какой день?');
    expect(CalendarService.clarifyQuestion(['duration'])).toBe('На сколько по времени?');
  });
});
