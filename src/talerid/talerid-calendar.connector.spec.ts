import { TalerIdCalendarConnector } from './talerid-calendar.connector';

describe('TalerIdCalendarConnector', () => {
  function makeOauth(overrides: Partial<Record<string, jest.Mock>> = {}) {
    return {
      getBackendAccessToken: jest.fn().mockResolvedValue('access-token-1'),
      ...overrides,
    } as any;
  }

  describe('listTasks — время рутины из due, а не хардкод 09:00', () => {
    const from = new Date('2026-08-30T00:00:00Z');
    const to = new Date('2026-09-02T00:00:00Z');
    const now = new Date('2026-08-30T05:00:00Z'); // 10:00 Asia/Yekaterinburg

    it('вечерняя рутина берёт время-суток из t.due (16:00Z=21:00), а не 09:00 (bug 2026-08-30)', async () => {
      const connector = new TalerIdCalendarConnector(makeOauth());
      jest.spyOn(connector as any, 'callTool').mockResolvedValue([
        {
          uid: 'routine-evening', title: 'Уход за лицом вечером',
          due: '2026-08-30T16:00:00.000Z', // 21:00 локально
          recurrence: { freq: 'daily' },
          occurrences: [{ occurrenceDate: '2026-08-30', status: 'pending' }],
        },
      ]);
      const tasks = await connector.listTasks('u1', from, to, now);
      const r = tasks.find((t) => t.uid === 'routine-evening')!;
      expect(r.due).toBe('2026-08-30T16:00:00.000Z'); // вечер, НЕ 04:00Z (09:00)
    });

    it('dueOverride конкретного вхождения имеет приоритет', async () => {
      const connector = new TalerIdCalendarConnector(makeOauth());
      jest.spyOn(connector as any, 'callTool').mockResolvedValue([
        {
          uid: 'r-ov', title: 'Рутина', due: '2026-08-30T16:00:00.000Z',
          recurrence: { freq: 'daily' },
          occurrences: [{ occurrenceDate: '2026-08-30', status: 'pending', dueOverride: '2026-08-30T07:00:00.000Z' }],
        },
      ]);
      const tasks = await connector.listTasks('u1', from, to, now);
      expect(tasks.find((t) => t.uid === 'r-ov')!.due).toBe('2026-08-30T07:00:00.000Z');
    });

    it('без t.due — fallback на 09:00 локально (04:00Z)', async () => {
      const connector = new TalerIdCalendarConnector(makeOauth());
      jest.spyOn(connector as any, 'callTool').mockResolvedValue([
        { uid: 'r-none', title: 'Рутина без времени', recurrence: { freq: 'daily' },
          occurrences: [{ occurrenceDate: '2026-08-30', status: 'pending' }] },
      ]);
      const tasks = await connector.listTasks('u1', from, to, now);
      expect(tasks.find((t) => t.uid === 'r-none')!.due).toBe('2026-08-30T04:00:00.000Z');
    });
  });

  describe('listEvents', () => {
    it('maps TalerID startAt/endAt/title/id -> CalEvent with source talerid', async () => {
      const oauth = makeOauth();
      const connector = new TalerIdCalendarConnector(oauth);
      const callTool = jest
        .spyOn(connector as any, 'callTool')
        .mockResolvedValue([
          {
            id: 'evt-1',
            title: 'Стендап',
            type: 'EVENT',
            startAt: '2026-08-17T09:45:00+05:00',
            endAt: '2026-08-17T10:15:00+05:00',
          },
        ]);

      const start = new Date('2026-08-17T00:00:00Z');
      const end = new Date('2026-08-18T00:00:00Z');
      const result = await connector.listEvents('user-1', start, end);

      // TalerID filters on DATE-ONLY strings, not ISO datetimes (see connector).
      expect(callTool).toHaveBeenCalledWith('user-1', 'list_calendar_events', {
        from: '2026-08-17',
        to: '2026-08-18',
      });
      expect(result).toEqual([
        {
          at: new Date('2026-08-17T09:45:00+05:00').toISOString(),
          end: new Date('2026-08-17T10:15:00+05:00').toISOString(),
          title: 'Стендап',
          source: 'talerid',
          uid: 'evt-1',
        },
      ]);
    });

    it('intraday window (same UTC date) → to is bumped +1 day so the day is included', async () => {
      const oauth = makeOauth();
      const connector = new TalerIdCalendarConnector(oauth);
      const callTool = jest.spyOn(connector as any, 'callTool').mockResolvedValue([]);

      // 09:00..11:30 on the same day — both slice to 2026-08-17 → must bump `to`.
      await connector.listEvents('user-1', new Date('2026-08-17T09:00:00Z'), new Date('2026-08-17T11:30:00Z'));

      expect(callTool).toHaveBeenCalledWith('user-1', 'list_calendar_events', {
        from: '2026-08-17',
        to: '2026-08-18',
      });
    });

    it('no token (oauth returns null) -> []', async () => {
      const oauth = makeOauth({ getBackendAccessToken: jest.fn().mockResolvedValue(null) });
      const connector = new TalerIdCalendarConnector(oauth);
      // Do NOT stub callTool here — exercise the real callTool short-circuit on missing token.

      const result = await connector.listEvents('user-1', new Date(), new Date());

      expect(result).toEqual([]);
    });

    it('MCP error thrown -> []', async () => {
      const oauth = makeOauth();
      const connector = new TalerIdCalendarConnector(oauth);
      jest.spyOn(connector as any, 'callTool').mockRejectedValue(new Error('mcp down'));

      const result = await connector.listEvents('user-1', new Date(), new Date());

      expect(result).toEqual([]);
    });

    it('parse/shape error (unexpected payload) -> []', async () => {
      const oauth = makeOauth();
      const connector = new TalerIdCalendarConnector(oauth);
      jest.spyOn(connector as any, 'callTool').mockResolvedValue({ garbage: true });

      const result = await connector.listEvents('user-1', new Date(), new Date());

      expect(result).toEqual([]);
    });
  });

  describe('createEvent', () => {
    it('single event -> exactly 1 create_calendar_event call with type EVENT and +05:00 offset startAt', async () => {
      const oauth = makeOauth();
      const connector = new TalerIdCalendarConnector(oauth);
      const callTool = jest.spyOn(connector as any, 'callTool').mockResolvedValue({ id: 'created-1' });

      const result = await connector.createEvent('user-1', {
        title: 'Созвон',
        datetime: '2026-08-17T09:45:00',
        durationMin: 30,
        note: 'важная встреча',
      });

      expect(callTool).toHaveBeenCalledTimes(1);
      const [userId, name, args]: [string, string, any] = callTool.mock.calls[0] as any;
      expect(userId).toBe('user-1');
      expect(name).toBe('create_calendar_event');
      expect(args.title).toBe('Созвон');
      expect(args.type).toBe('EVENT');
      expect(args.startAt).toBe('2026-08-17T09:45:00+05:00');
      expect(args.endAt).toBe('2026-08-17T10:15:00+05:00');
      expect(args.description).toBe('важная встреча');

      expect(result).toEqual({ created: 1, failed: 0, ids: ['created-1'] });
    });

    it('recurrence weekly byDay MO-FR count:3 -> 3 create_calendar_event calls', async () => {
      const oauth = makeOauth();
      const connector = new TalerIdCalendarConnector(oauth);
      const callTool = jest.spyOn(connector as any, 'callTool').mockResolvedValue({ id: 'x' });

      const result = await connector.createEvent('user-1', {
        title: 'Ежедневный стендап',
        datetime: '2026-08-17T09:00:00', // Monday
        recurrence: { freq: 'weekly', byDay: ['MO', 'TU', 'WE', 'TH', 'FR'], count: 3 },
      });

      expect(callTool).toHaveBeenCalledTimes(3);
      expect(result.created).toBe(3);
      expect(result.failed).toBe(0);
      expect(result.ids).toHaveLength(3);
      for (const call of callTool.mock.calls as any[]) {
        expect(call[1]).toBe('create_calendar_event');
        expect(call[2].type).toBe('EVENT');
        expect(call[2].startAt).toMatch(/\+05:00$/);
      }
    });

    it('one of N calls fails -> partial success {created: N-1, failed: 1}', async () => {
      const oauth = makeOauth();
      const connector = new TalerIdCalendarConnector(oauth);
      const callTool = jest
        .spyOn(connector as any, 'callTool')
        .mockResolvedValueOnce({ id: 'ok-1' })
        .mockRejectedValueOnce(new Error('mcp create failed'))
        .mockResolvedValueOnce({ id: 'ok-3' });

      const result = await connector.createEvent('user-1', {
        title: 'Серия',
        datetime: '2026-08-17T09:00:00',
        recurrence: { freq: 'daily', count: 3 },
      });

      expect(callTool).toHaveBeenCalledTimes(3);
      expect(result).toEqual({ created: 2, failed: 1, ids: ['ok-1', 'ok-3'] });
    });

    it('no durationMin -> defaults to 60 minutes for endAt', async () => {
      const oauth = makeOauth();
      const connector = new TalerIdCalendarConnector(oauth);
      const callTool = jest.spyOn(connector as any, 'callTool').mockResolvedValue({ id: 'x' });

      await connector.createEvent('user-1', { title: 'Событие', datetime: '2026-08-17T09:00:00' });

      const args: any = callTool.mock.calls[0][2];
      expect(args.startAt).toBe('2026-08-17T09:00:00+05:00');
      expect(args.endAt).toBe('2026-08-17T10:00:00+05:00');
    });
  });
});
