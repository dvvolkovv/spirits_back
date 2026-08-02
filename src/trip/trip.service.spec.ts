import { computeCopilotState, mergeEvents, TripService } from './trip.service';

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

  it('reminders содержат все задачи; обычные дела (без дедлайна/событий) НЕ пушат по времени', () => {
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
    // Модель «пора»: обычные дела по времени не пушим (важно не время, а факт). Нет событий/дедлайнов → пусто.
    expect(s.timeTriggers).toEqual([]);
  });

  it('events[] структурированы (ISO at + conflict) для ранжирования в лаунчере [784fd182]', () => {
    const s = computeCopilotState({
      tasks: [],
      events: [
        ev('e1', 'Встреча', '2026-07-20T10:30:00Z', '2026-07-20T11:30:00Z'),
        ev('e2', 'Выезд', '2026-07-20T11:00:00Z', '2026-07-20T12:00:00Z'),
        ev('e3', 'Одиночное', '2026-07-21T09:00:00Z'),
      ],
      now,
      horizonHours: 24 * 30, // тест про СТРУКТУРУ/конфликт, не про горизонт — берём все 3
    });
    expect(s.events?.length).toBe(3);
    // первые два пересекаются → conflict:true у обоих; третье — false
    expect(s.events?.[0]).toMatchObject({ title: 'Встреча', at: '2026-07-20T10:30:00Z', conflict: true });
    expect(s.events?.[1]).toMatchObject({ title: 'Выезд', conflict: true });
    expect(s.events?.[2]).toMatchObject({ title: 'Одиночное', conflict: false });
  });

  it('нет событий -> events[] пуст (не undefined), обратная совместимость', () => {
    const s = computeCopilotState({ tasks: [], events: [], now });
    expect(s.events).toEqual([]);
  });

  describe('mergeEvents [6ad042df]', () => {
    it('дедуп одного митинга из ICS и TalerID по заголовку+минуте', () => {
      const ics = [ev('e1', 'Стендап', '2026-07-20T10:00:00Z')] as any;
      const talerid = [
        { title: 'стендап', at: '2026-07-20T10:00:30Z', source: 'talerid', uid: 'tx1' }, // та же минута, иной регистр
        { title: 'Личное TalerID', at: '2026-07-20T14:00:00Z', source: 'talerid', uid: 'tx2' },
      ] as any;
      const merged = mergeEvents(ics, talerid);
      expect(merged.length).toBe(2);
      expect(merged.map((e) => e.title)).toEqual(['Стендап', 'Личное TalerID']); // ICS-дубль выиграл, TalerID-уникум добавлен
      expect(merged[0].source).toBe('yandex');
    });

    it('разные события из обоих источников сохраняются', () => {
      const a = [ev('e1', 'A', '2026-07-20T10:00:00Z')] as any;
      const b = [{ title: 'B', at: '2026-07-20T11:00:00Z', source: 'talerid' }] as any;
      expect(mergeEvents(a, b).map((e) => e.title)).toEqual(['A', 'B']);
    });

    it('пустые источники → пустой результат', () => {
      expect(mergeEvents([], [])).toEqual([]);
    });
  });

  describe('applyAction — предложения агента [a5131311]', () => {
    const makeCalendar = (overrides: any = {}) => ({
      listTasks: jest.fn().mockResolvedValue([]),
      listEvents: jest.fn().mockResolvedValue([]),
      listPendingProposals: jest.fn().mockResolvedValue([]),
      createEvent: jest.fn().mockResolvedValue({ ok: true, created: 1, failed: 0, uids: ['e1'] }),
      setProposalStatus: jest.fn().mockResolvedValue(true), // прод возвращает rowCount>0 при флипе pending→accepted
      revertProposalToPending: jest.fn().mockResolvedValue(undefined),
      getProposal: jest.fn(),
      setTaskDone: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    });
    const taleridCal = {
      listEvents: jest.fn().mockResolvedValue([]),
      listTasks: jest.fn().mockResolvedValue([]),
      setTaskStatus: jest.fn().mockResolvedValue({ ok: true }),
      rescheduleTask: jest.fn().mockResolvedValue({ ok: true }),
    } as any;
    const linkeonTasks = { list: jest.fn().mockResolvedValue([]) } as any;
    const svc = (calendar: any) => new TripService({} as any, calendar, taleridCal, linkeonTasks);

    it('proposal_accept → пишет event в календарь + помечает accepted', async () => {
      const event = { title: 'Созвон', datetime: '2026-07-20T15:00:00', durationMin: 60 };
      const calendar = makeCalendar({ getProposal: jest.fn().mockResolvedValue({ kind: 'event', event }) });
      await svc(calendar).applyAction('u1', 'idem-1', 'proposal_accept', { id: 'p1' });
      expect(calendar.createEvent).toHaveBeenCalledWith('u1', event);
      expect(calendar.setProposalStatus).toHaveBeenCalledWith('u1', 'p1', 'accepted');
    });

    it('proposal_dismiss → помечает dismissed, в календарь НЕ пишет', async () => {
      const calendar = makeCalendar();
      await svc(calendar).applyAction('u1', 'idem-2', 'proposal_dismiss', { id: 'p2' });
      expect(calendar.createEvent).not.toHaveBeenCalled();
      expect(calendar.setProposalStatus).toHaveBeenCalledWith('u1', 'p2', 'dismissed');
    });

    it('proposal_accept без id → BadRequest', async () => {
      const calendar = makeCalendar();
      await expect(svc(calendar).applyAction('u1', 'idem-3', 'proposal_accept', {})).rejects.toThrow();
    });

    it('getState докладывает pending-предложения в state.proposals', async () => {
      const event = { title: 'Встреча', datetime: '2026-07-20T16:00:00' };
      const calendar = makeCalendar({
        listPendingProposals: jest.fn().mockResolvedValue([{ id: 'p9', event, kind: 'event' }]),
      });
      const state = await svc(calendar).getState('u1');
      expect(state.proposals).toEqual([{ id: 'p9', kind: 'calendar_event', payload: { event } }]);
    });
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
