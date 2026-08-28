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
      const service = new CalendarService(pg, talerStore, talerConnector, {} as any);
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
      const service = new CalendarService(pg, talerStore, talerConnector, {} as any);
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
      const service = new CalendarService(pg, talerStore, talerConnector, {} as any);
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
      const service = new CalendarService(pg, talerStore, talerConnector, {} as any);
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
      const service = new CalendarService(pg, talerStore, talerConnector, {} as any);
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
      const service = new CalendarService(pg, talerStore, talerConnector, {} as any);

      const result = await service.createEvent('user-1', proposed);

      expect(result).toEqual({ ok: false, error: 'Календарь не подключён' });
    });
  });
});

describe('TalerIdController', () => {
  function makeOauth(overrides: Partial<Record<string, jest.Mock>> = {}) {
    return {
      connect: jest.fn(),
      // Identity lookup + provision moved into the service; the controller now delegates
      // connect → provisionForUser and oauthStart → lookupProvisionInput.
      provisionForUser: jest.fn().mockResolvedValue('connected'),
      lookupProvisionInput: jest.fn().mockResolvedValue({ phone: null }),
      disconnect: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    } as any;
  }
  function makeStore(overrides: Partial<Record<string, jest.Mock>> = {}) {
    return { getConnection: jest.fn().mockResolvedValue(null), ...overrides } as any;
  }

  // Account-linking service — not exercised by these connect/status/disconnect tests; stub it.
  const makeLink = () => ({ startLink: jest.fn(), completeLink: jest.fn() } as any);
  // Вход через TalerID — отдельный сервис рядом с привязкой; в этих тестах
  // он не участвует, но контроллер его требует.
  const makeLogin = (overrides: Partial<Record<string, jest.Mock>> = {}) => ({
    startLogin: jest.fn(),
    peekLogin: jest.fn().mockResolvedValue(null),
    completeLogin: jest.fn(),
    redeemHandoff: jest.fn(),
    ...overrides,
  } as any);

  /** Ловит адрес редиректа вместо настоящего express-ответа. */
  function makeRes() {
    const res: any = { redirected: null as string | null };
    res.redirect = (url: string) => {
      res.redirected = url;
      return res;
    };
    return res;
  }

  describe('connect', () => {
    it('delegates to provisionForUser and returns the status (identity lookup lives in the service)', async () => {
      const oauth = makeOauth({ provisionForUser: jest.fn().mockResolvedValue('connected') });
      const controller = new TalerIdController(oauth, makeStore(), makeLink(), makeLogin());

      const result = await controller.connect({ userId: 'user-1' });

      expect(oauth.provisionForUser).toHaveBeenCalledWith('user-1');
      expect(result).toEqual({ status: 'connected' });
    });

    it('ambiguous status is returned as a normal (non-throwing) 200-shaped response', async () => {
      const oauth = makeOauth({ provisionForUser: jest.fn().mockResolvedValue('ambiguous') });
      const controller = new TalerIdController(oauth, makeStore(), makeLink(), makeLogin());

      const result = await controller.connect({ userId: 'user-1' });

      expect(result).toEqual({ status: 'ambiguous' });
    });

    it('no phone on file → provisionForUser reports error, controller passes it through', async () => {
      const oauth = makeOauth({ provisionForUser: jest.fn().mockResolvedValue('error') });
      const controller = new TalerIdController(oauth, makeStore(), makeLink(), makeLogin());

      const result = await controller.connect({ userId: 'user-1' });

      expect(result).toEqual({ status: 'error' });
    });
  });

  describe('status', () => {
    it('reflects getConnection', async () => {
      const oauth = makeOauth();
      const store = makeStore({ getConnection: jest.fn().mockResolvedValue({ status: 'connected' }) });
      const controller = new TalerIdController(oauth, store, makeLink(), makeLogin());

      const result = await controller.status({ userId: 'user-1' });

      expect(result).toEqual({ connected: true, status: 'connected' });
    });

    it('not connected → connected:false', async () => {
      const oauth = makeOauth();
      const store = makeStore(); // getConnection -> null
      const controller = new TalerIdController(oauth, store, makeLink(), makeLogin());

      const result = await controller.status({ userId: 'user-1' });

      expect(result).toEqual({ connected: false, status: null });
    });
  });

  // Вход из мобильного приложения: согласие проходит в системном браузере
  // (иначе установленный Taler ID его не перехватит), и возврат обязан
  // уйти ссылкой в приложение — веб-страницу Linkeon оно оттуда не видит.
  describe('login callback — куда возвращается человек', () => {
    function makeController(login: any) {
      return new TalerIdController(makeOauth(), makeStore(), makeLink(), login);
    }

    it('мобильный вход возвращается в приложение', async () => {
      const login = makeLogin({
        peekLogin: jest.fn().mockResolvedValue({ mobile: true }),
        completeLogin: jest.fn().mockResolvedValue('handoff-1'),
      });
      const res = makeRes();

      await makeController(login).oauthCallback('code-1', 'state-1', undefined as any, res);

      expect(res.redirected).toBe('linkeon://auth/talerid?talerid_login=handoff-1');
    });

    it('веб-вход по-прежнему возвращается на страницу', async () => {
      const login = makeLogin({
        peekLogin: jest.fn().mockResolvedValue({ mobile: false }),
        completeLogin: jest.fn().mockResolvedValue('handoff-2'),
      });
      const res = makeRes();

      await makeController(login).oauthCallback('code-1', 'state-1', undefined as any, res);

      expect(res.redirected).toBe('https://my.linkeon.io/?talerid_login=handoff-2');
    });

    it('несостоявшийся обмен уводит мобильного в приложение, а не в браузер', async () => {
      const login = makeLogin({
        peekLogin: jest.fn().mockResolvedValue({ mobile: true }),
        completeLogin: jest.fn().mockResolvedValue(null),
      });
      const res = makeRes();

      await makeController(login).oauthCallback('code-1', 'state-1', undefined as any, res);

      expect(res.redirected).toBe('linkeon://auth/talerid?talerid_login_error=1');
    });

    // Отказ на стороне провайдера — это тоже конец входа, а не привязки:
    // раньше он уводил человека на `?talerid_link=cancelled`, о котором
    // экран входа ничего не знает, и в приложении оборвался бы совсем.
    it('отказ на стороне провайдера остаётся в потоке входа', async () => {
      const login = makeLogin({ peekLogin: jest.fn().mockResolvedValue({ mobile: true }) });
      const res = makeRes();

      await makeController(login).oauthCallback('', 'state-1', 'access_denied', res);

      expect(res.redirected).toBe('linkeon://auth/talerid?talerid_login_error=1');
      expect(login.completeLogin).not.toHaveBeenCalled();
    });

    it('привязка не задета — у неё свой возврат', async () => {
      const link = makeLink();
      link.completeLink = jest.fn().mockResolvedValue('linked');
      const controller = new TalerIdController(
        makeOauth(), makeStore(), link, makeLogin(),
      );
      const res = makeRes();

      await controller.oauthCallback('code-1', 'state-1', undefined as any, res);

      expect(res.redirected).toBe('https://my.linkeon.io/?talerid_link=linked');
    });
  });

  describe('login/start', () => {
    it('признак мобильного клиента доезжает до сервиса', async () => {
      const login = makeLogin({
        startLogin: jest.fn().mockResolvedValue({ authorizeUrl: 'https://x' }),
      });
      const controller = new TalerIdController(
        makeOauth(), makeStore(), makeLink(), login,
      );

      await controller.loginStart({ platform: 'mobile' });

      expect(login.startLogin).toHaveBeenCalledWith('mobile');
    });

    it('веб-клиент платформу не присылает и остаётся вебом', async () => {
      const login = makeLogin({
        startLogin: jest.fn().mockResolvedValue({ authorizeUrl: 'https://x' }),
      });
      const controller = new TalerIdController(
        makeOauth(), makeStore(), makeLink(), login,
      );

      await controller.loginStart({} as any);

      expect(login.startLogin).toHaveBeenCalledWith(undefined);
    });
  });

  describe('disconnect', () => {
    it('calls TalerIdOauthService.disconnect and returns ok:true', async () => {
      const oauth = makeOauth();
      const store = makeStore();
      const controller = new TalerIdController(oauth, store, makeLink(), makeLogin());

      const result = await controller.disconnect({ userId: 'user-1' });

      expect(oauth.disconnect).toHaveBeenCalledWith('user-1');
      expect(result).toEqual({ ok: true });
    });
  });
});
