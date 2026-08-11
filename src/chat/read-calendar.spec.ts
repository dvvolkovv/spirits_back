import { ChatToolsService } from './chat-tools';
import { parseLocalStart, parseLocalEnd } from '../calendar/calendar.service';

function svc(events: any, status: any = { connected: true }, listImpl?: jest.Mock) {
  const listEventsLocalRange = listImpl || jest.fn(async () => events);
  const getStatus = jest.fn(async () => status);
  const calendar = { listEventsLocalRange, getStatus } as any;
  // constructor order: (kling, misc, pg, video, routines, calendar, speech) — only calendar matters here
  return {
    svc: new ChatToolsService({} as any, {} as any, {} as any, {} as any, {} as any, calendar, {} as any),
    listEventsLocalRange,
    getStatus,
  };
}

describe('read_calendar tool', () => {
  it('returns events with durations + total (the "hours on lessons" use case), connected', async () => {
    const events = [
      { at: '2026-08-10T04:00:00Z', end: '2026-08-10T05:00:00Z', title: 'Урок английского', source: 'yandex' },
      { at: '2026-08-11T06:00:00Z', end: '2026-08-11T07:30:00Z', title: 'Урок английского', source: 'yandex' },
    ];
    const { svc: service, listEventsLocalRange } = svc(events);
    const r: any = await service.executeTool('u1', 'read_calendar', { from: '2026-08-10', to: '2026-08-12' });
    expect(r).toMatchObject({ ok: true, kind: 'calendar_read', connected: true, count: 2 });
    expect(listEventsLocalRange).toHaveBeenCalledWith('u1', '2026-08-10', '2026-08-12');
    expect(r.events[0]).toMatchObject({ title: 'Урок английского', durationMin: 60, source: 'yandex' });
    expect(r.events[1].durationMin).toBe(90);
    expect(r.totalDurationMin).toBe(150); // 2.5 часа на уроки — ровно то, что не мог посчитать Роман
    expect(r.events[0].start).toBe('2026-08-10T09:00:00+05:00'); // local (+05:00) display
    expect(r.events[0].end).toBe('2026-08-10T10:00:00+05:00');
  });

  it('event without end → durationMin undefined, excluded from total', async () => {
    const events = [{ at: '2026-08-10T04:00:00Z', title: 'День рождения', source: 'talerid' }];
    const { svc: service } = svc(events);
    const r: any = await service.executeTool('u1', 'read_calendar', { from: '2026-08-10', to: '2026-08-11' });
    expect(r.events[0].durationMin).toBeUndefined();
    expect(r.events[0].end).toBeUndefined();
    expect(r.totalDurationMin).toBe(0);
  });

  it('empty + not connected → connected:false (assistant can suggest connecting)', async () => {
    const { svc: service } = svc([], { connected: false });
    const r: any = await service.executeTool('u1', 'read_calendar', { from: '2026-08-10', to: '2026-08-11' });
    expect(r).toMatchObject({ ok: true, kind: 'calendar_read', connected: false, count: 0, totalDurationMin: 0 });
    expect(r.events).toEqual([]);
  });

  it('empty but exchange connected → connected:true', async () => {
    const { svc: service } = svc([], { connected: false, exchange: { connected: true } });
    const r: any = await service.executeTool('u1', 'read_calendar', { from: '2026-08-10', to: '2026-08-11' });
    expect(r.connected).toBe(true);
  });

  it('range error from service → ok:false with message', async () => {
    const listImpl = jest.fn(async () => {
      throw new Error('период слишком большой (максимум 366 дней)');
    });
    const { svc: service } = svc([], { connected: true }, listImpl);
    const r: any = await service.executeTool('u1', 'read_calendar', { from: '2020-01-01', to: '2026-01-01' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('366');
  });

  it('missing to → ok:false, no calendar read', async () => {
    const { svc: service, listEventsLocalRange } = svc([]);
    const r: any = await service.executeTool('u1', 'read_calendar', { from: '2026-08-10' });
    expect(r.ok).toBe(false);
    expect(listEventsLocalRange).not.toHaveBeenCalled();
  });
});

describe('local-range parsing (read_calendar window, product TZ +05:00)', () => {
  it('date-only start = 00:00 that day', () => {
    expect(parseLocalStart('2026-08-10').toISOString()).toBe('2026-08-09T19:00:00.000Z'); // 00:00+05:00
  });
  it('date-only end is INCLUSIVE → rolls to next-day 00:00', () => {
    expect(parseLocalEnd('2026-08-10').toISOString()).toBe('2026-08-10T19:00:00.000Z'); // 2026-08-11T00:00+05:00
  });
  it('datetime is interpreted in product TZ', () => {
    expect(parseLocalStart('2026-08-10T09:00:00').toISOString()).toBe('2026-08-10T04:00:00.000Z');
    expect(parseLocalEnd('2026-08-10T18:00:00').toISOString()).toBe('2026-08-10T13:00:00.000Z');
  });
});
