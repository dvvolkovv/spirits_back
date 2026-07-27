import { CalendarService } from '../calendar/calendar.service';
import * as crypto from '../calendar/crypto';
import { TalerIdController } from './talerid.controller';

/**
 * Task 5 — co-pilot aggregation (listEvents union), write routing (createEvent target), and the
 * connect/status/disconnect endpoints. Mocks the TalerID store/connector/oauth-service — no real
 * HTTP/MCP/DB. Must never break the pre-existing Yandex-only path (see calendar.service.spec.ts).
 */
describe('CalendarService — TalerID aggregation + write routing', () => {
  beforeAll(() => { process.env.CALENDAR_SECRET_KEY = '0123456789abcdef0123456789abcdef'; });
  beforeEach(() => { jest.spyOn(crypto, 'decryptSecret').mockReturnValue('app-pass'); });
  afterEach(() => { jest.restoreAllMocks(); });

  function makePg(overrides: Partial<Record<string, jest.Mock>> = {}) {
    return { query: jest.fn().mockResolvedValue({ rows: [] }), ...overrides } as any;
  }
  function makeTalerStore(overrides: Partial<Record<string, jest.Mock>> = {}) {
    return { getConnection: jest.fn().mockResolvedValue(null), ...overrides } as any;
  }
  function makeTalerConnector(overrides: Partial<Record<string, jest.Mock>> = {}) {
    return { listEvents: jest.fn().mockResolvedValue([]), createEvent: jest.fn(), ...overrides } as any;
  }

  const start = new Date('2026-07-25T00:00:00Z');
  const end = new Date('2026-08-01T00:00:00Z');

  describe('listEvents', () => {
    it('returns Yandex-only when TalerID is not connected', async () => {
      const pg = makePg({
        query: jest.fn().mockImplementation((sql: string) => {
          if (sql.includes('calendar_connections')) return Promise.resolve({ rows: [{ base_url: 'https://caldav.yandex.ru', username: 'u', secret_enc: 'x', collection_url: 'c', todo_collection_url: null }] });
          if (sql.includes('trip_calendars')) return Promise.resolve({ rows: [] });
          return Promise.resolve({ rows: [] });
        }),
      });
      const talerStore = makeTalerStore(); // getConnection -> null
      const talerConnector = makeTalerConnector();
      const service = new CalendarService(pg, talerStore, talerConnector);
      // Stub the private Yandex connector's listEvents via the instance (avoid real CalDAV I/O).
      (service as any).connector.listEvents = jest.fn().mockResolvedValue([
        { at: '2026-07-26T10:00:00.000Z', title: 'Yandex event', source: 'yandex' },
      ]);

      const events = await service.listEvents('user-1', start, end);

      expect(events).toEqual([{ at: '2026-07-26T10:00:00.000Z', title: 'Yandex event', source: 'yandex' }]);
      expect(talerConnector.listEvents).not.toHaveBeenCalled();
    });

    it('unions Yandex + TalerID when TalerID is connected', async () => {
      const pg = makePg({
        query: jest.fn().mockImplementation((sql: string) => {
          if (sql.includes('calendar_connections')) return Promise.resolve({ rows: [{ base_url: 'https://caldav.yandex.ru', username: 'u', secret_enc: 'x', collection_url: 'c', todo_collection_url: null }] });
          if (sql.includes('trip_calendars')) return Promise.resolve({ rows: [] });
          return Promise.resolve({ rows: [] });
        }),
      });
      const talerStore = makeTalerStore({ getConnection: jest.fn().mockResolvedValue({ status: 'connected' }) });
      const talerConnector = makeTalerConnector({
        listEvents: jest.fn().mockResolvedValue([{ at: '2026-07-27T09:00:00.000Z', title: 'TalerID event', source: 'talerid' }]),
      });
      const service = new CalendarService(pg, talerStore, talerConnector);
      (service as any).connector.listEvents = jest.fn().mockResolvedValue([
        { at: '2026-07-26T10:00:00.000Z', title: 'Yandex event', source: 'yandex' },
      ]);

      const events = await service.listEvents('user-1', start, end);

      expect(events).toHaveLength(2);
      expect(events.some((e) => e.source === 'yandex')).toBe(true);
      expect(events.some((e) => e.source === 'talerid')).toBe(true);
      expect(talerConnector.listEvents).toHaveBeenCalledWith('user-1', start, end);
    });

    it('a throwing TalerID connector/store never breaks the Yandex results', async () => {
      const pg = makePg({
        query: jest.fn().mockImplementation((sql: string) => {
          if (sql.includes('calendar_connections')) return Promise.resolve({ rows: [{ base_url: 'https://caldav.yandex.ru', username: 'u', secret_enc: 'x', collection_url: 'c', todo_collection_url: null }] });
          if (sql.includes('trip_calendars')) return Promise.resolve({ rows: [] });
          return Promise.resolve({ rows: [] });
        }),
      });
      const talerStore = makeTalerStore({ getConnection: jest.fn().mockRejectedValue(new Error('boom')) });
      const talerConnector = makeTalerConnector({ listEvents: jest.fn().mockRejectedValue(new Error('should not even be reached')) });
      const service = new CalendarService(pg, talerStore, talerConnector);
      (service as any).connector.listEvents = jest.fn().mockResolvedValue([
        { at: '2026-07-26T10:00:00.000Z', title: 'Yandex event', source: 'yandex' },
      ]);

      const events = await service.listEvents('user-1', start, end);

      expect(events).toEqual([{ at: '2026-07-26T10:00:00.000Z', title: 'Yandex event', source: 'yandex' }]);
    });
  });

  describe('createEvent — routing', () => {
    const proposed = { title: 'Meet', datetime: '2026-07-26T15:00:00' };

    it('routes to TalerID when connected — Yandex connector never touched, shape normalized', async () => {
      const pg = makePg();
      const talerStore = makeTalerStore({ getConnection: jest.fn().mockResolvedValue({ status: 'connected' }) });
      const talerConnector = makeTalerConnector({
        createEvent: jest.fn().mockResolvedValue({ created: 1, failed: 0, ids: ['tid-1'] }),
      });
      const service = new CalendarService(pg, talerStore, talerConnector);
      const yandexCreateSpy = jest.fn();
      (service as any).connector.createEvent = yandexCreateSpy;

      const result = await service.createEvent('user-1', proposed);

      expect(talerConnector.createEvent).toHaveBeenCalledWith('user-1', proposed);
      expect(yandexCreateSpy).not.toHaveBeenCalled();
      expect(result).toEqual({ ok: true, created: 1, failed: 0, uids: ['tid-1'] });
    });

    it('routes to Yandex when not connected (existing path unaffected)', async () => {
      const pg = makePg({
        query: jest.fn().mockImplementation((sql: string) => {
          if (sql.includes('calendar_connections')) return Promise.resolve({ rows: [{ base_url: 'https://caldav.yandex.ru', username: 'u', secret_enc: 'x', collection_url: 'c', todo_collection_url: null }] });
          return Promise.resolve({ rows: [] });
        }),
      });
      const talerStore = makeTalerStore(); // getConnection -> null
      const talerConnector = makeTalerConnector();
      const service = new CalendarService(pg, talerStore, talerConnector);
      const yandexCreateSpy = jest.fn().mockResolvedValue({ created: 1, failed: 0, uids: ['yandex-uid'] });
      (service as any).connector.createEvent = yandexCreateSpy;

      const result = await service.createEvent('user-1', proposed);

      expect(talerConnector.createEvent).not.toHaveBeenCalled();
      expect(yandexCreateSpy).toHaveBeenCalled();
      expect(result).toEqual({ ok: true, created: 1, failed: 0, uids: ['yandex-uid'], error: undefined });
    });

    it('falls closed with the pre-existing error message when not connected and no Yandex connection either', async () => {
      const pg = makePg(); // no calendar_connections row
      const talerStore = makeTalerStore();
      const talerConnector = makeTalerConnector();
      const service = new CalendarService(pg, talerStore, talerConnector);

      const result = await service.createEvent('user-1', proposed);

      expect(result).toEqual({ ok: false, error: 'Календарь не подключён' });
    });
  });
});

describe('TalerIdController', () => {
  function makeOauth(overrides: Partial<Record<string, jest.Mock>> = {}) {
    return { connect: jest.fn(), disconnect: jest.fn().mockResolvedValue(undefined), ...overrides } as any;
  }
  function makeStore(overrides: Partial<Record<string, jest.Mock>> = {}) {
    return { getConnection: jest.fn().mockResolvedValue(null), ...overrides } as any;
  }
  function makePg(rows: { uid?: any[]; profile?: any[] } = {}) {
    return {
      query: jest.fn().mockImplementation((sql: string) => {
        if (sql.includes('FROM user_id')) return Promise.resolve({ rows: rows.uid ?? [] });
        if (sql.includes('FROM ai_profiles_consolidated')) return Promise.resolve({ rows: rows.profile ?? [] });
        return Promise.resolve({ rows: [] });
      }),
    } as any;
  }

  // Account-linking service — not exercised by these connect/status/disconnect tests; stub it.
  const makeLink = () => ({ startLink: jest.fn(), completeLink: jest.fn() } as any);

  describe('connect', () => {
    it('calls TalerIdOauthService.connect with the user phone (raw, no +) and returns the status', async () => {
      const oauth = makeOauth({ connect: jest.fn().mockResolvedValue('connected') });
      const store = makeStore();
      const pg = makePg({ uid: [{ primary_phone: '79656445804', primary_email: null }], profile: [{ email: 'a@b.com', profile_data: { name: 'Dmitry' } }] });
      const controller = new TalerIdController(oauth, store, makeLink(), pg);

      const result = await controller.connect({ userId: 'user-1' });

      expect(oauth.connect).toHaveBeenCalledWith('user-1', '79656445804', 'a@b.com', 'Dmitry');
      expect(result).toEqual({ status: 'connected' });
    });

    it('ambiguous status is returned as a normal (non-throwing) 200-shaped response', async () => {
      const oauth = makeOauth({ connect: jest.fn().mockResolvedValue('ambiguous') });
      const store = makeStore();
      const pg = makePg({ uid: [{ primary_phone: '79656445804' }] });
      const controller = new TalerIdController(oauth, store, makeLink(), pg);

      const result = await controller.connect({ userId: 'user-1' });

      expect(result).toEqual({ status: 'ambiguous' });
    });

    it('no phone on file → does not call connect, returns error status', async () => {
      const oauth = makeOauth();
      const store = makeStore();
      const pg = makePg({ uid: [{ primary_phone: null }] });
      const controller = new TalerIdController(oauth, store, makeLink(), pg);

      const result = await controller.connect({ userId: 'user-1' });

      expect(oauth.connect).not.toHaveBeenCalled();
      expect(result).toEqual({ status: 'error' });
    });
  });

  describe('status', () => {
    it('reflects getConnection', async () => {
      const oauth = makeOauth();
      const store = makeStore({ getConnection: jest.fn().mockResolvedValue({ status: 'connected' }) });
      const pg = makePg();
      const controller = new TalerIdController(oauth, store, makeLink(), pg);

      const result = await controller.status({ userId: 'user-1' });

      expect(result).toEqual({ connected: true, status: 'connected' });
    });

    it('not connected → connected:false', async () => {
      const oauth = makeOauth();
      const store = makeStore(); // getConnection -> null
      const pg = makePg();
      const controller = new TalerIdController(oauth, store, makeLink(), pg);

      const result = await controller.status({ userId: 'user-1' });

      expect(result).toEqual({ connected: false, status: null });
    });
  });

  describe('disconnect', () => {
    it('calls TalerIdOauthService.disconnect and returns ok:true', async () => {
      const oauth = makeOauth();
      const store = makeStore();
      const pg = makePg();
      const controller = new TalerIdController(oauth, store, makeLink(), pg);

      const result = await controller.disconnect({ userId: 'user-1' });

      expect(oauth.disconnect).toHaveBeenCalledWith('user-1');
      expect(result).toEqual({ ok: true });
    });
  });
});
