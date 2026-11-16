jest.mock('web-push', () => ({ setVapidDetails: jest.fn(), sendNotification: jest.fn() }));

import * as https from 'https';
import * as webpush from 'web-push';
import { PushService } from './push.service';
import { __setSafeFetchDepsForTests, UnsafeUrlError } from '../common/net/safe-fetch';

/**
 * Web Push: endpoint подписки присылает клиент, а сервер потом сам шлёт на
 * него POST. Без проверки POST /push/subscribe с `http://127.0.0.1:3001/…`
 * превращал каждое уведомление в запрос к внутреннему сервису.
 */

function makeService(rows: any[] = [], state: 'active' | 'deleted' = 'active') {
  const pg = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      if (normalized.includes("SELECT 1 FROM user_id WHERE internal_id=$1 AND state='active'")) {
        return { rows: state === 'active' ? [{ '?column?': 1 }] : [], rowCount: state === 'active' ? 1 : 0 };
      }
      if (/SELECT .*endpoint.* FROM push_subscriptions/.test(normalized)) {
        const fenced = normalized.includes("u.state='active'");
        return { rows: state === 'deleted' && fenced ? [] : rows, rowCount: state === 'deleted' && fenced ? 0 : rows.length };
      }
      return { rows: [], rowCount: 1 };
    }),
  };
  const svc = new PushService(pg as any);
  (svc as any).configured = true;
  (svc as any).logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };
  return { svc, pg };
}

const keys = { p256dh: 'k', auth: 'a' };

function makeAtomicWriteRaceService() {
  let state: 'active' | 'deleted' = 'active';
  let firstActiveSelect = true;
  const subscriptions: any[] = [];
  const pg = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      if (normalized.startsWith("SELECT 1 FROM user_id WHERE internal_id=$1 AND state='active'") && firstActiveSelect) {
        firstActiveSelect = false;
        state = 'deleted';
        return { rows: [{ '?column?': 1 }], rowCount: 1 };
      }
      if (normalized.startsWith('INSERT INTO push_subscriptions')) {
        const guarded = normalized.includes('WHERE EXISTS') && normalized.includes("state='active'");
        if (state === 'deleted' && guarded) return { rows: [], rowCount: 0 };
        subscriptions.push({ userId: params[0], endpoint: params[1] });
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${normalized}`);
    }),
  };
  return { svc: new PushService(pg as any), subscriptions };
}

afterEach(() => {
  __setSafeFetchDepsForTests(null);
  jest.clearAllMocks();
});

describe('POST /push/subscribe', () => {
  it.each([
    'http://127.0.0.1:3001/webhook/admin',
    'https://localhost/x',
    'https://169.254.169.254/latest/meta-data/',
    'https://[::1]/x',
    'http://fcm.googleapis.com/fcm/send/abc', // только https
    'https://fcm.googleapis.com:8080/fcm/send/abc', // только стандартный порт
    'file:///etc/passwd',
  ])('%s — отказ, в БД не пишется', async (endpoint) => {
    const { svc, pg } = makeService();
    await expect(svc.subscribe('u-1', { endpoint, keys })).rejects.toThrow(UnsafeUrlError);
    expect(pg.query.mock.calls.filter(([sql]) => /INSERT INTO push_subscriptions/.test(String(sql)))).toEqual([]);
  });

  it('настоящий endpoint push-сервиса сохраняется как есть', async () => {
    const { svc, pg } = makeService();
    const endpoint = 'https://fcm.googleapis.com/fcm/send/dXk:APA91b';
    await svc.subscribe('u-1', { endpoint, keys });
    expect(pg.query).toHaveBeenCalledWith(expect.stringMatching(/INSERT INTO push_subscriptions/), ['u-1', endpoint, JSON.stringify(keys)]);
  });

  it('deleted не создаёт web subscription', async () => {
    const { svc, pg } = makeService([], 'deleted');
    await svc.subscribe('u-1', { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys });
    expect(pg.query.mock.calls.filter(([sql]) => /INSERT INTO push_subscriptions/.test(String(sql)))).toEqual([]);
  });

  it('deleted не создаёт native subscription, active сохраняет регистрацию', async () => {
    const deleted = makeService([], 'deleted');
    await deleted.svc.registerNative('u-1', 'native-token');
    expect(deleted.pg.query.mock.calls.filter(([sql]) => /INSERT INTO push_subscriptions/.test(String(sql)))).toEqual([]);

    const active = makeService();
    await active.svc.registerNative('u-1', 'native-token');
    expect(active.pg.query).toHaveBeenCalledWith(
      expect.stringMatching(/INSERT INTO push_subscriptions/),
      ['u-1', 'fcm:native-token'],
    );
  });

  it('active→deleted после precheck не создаёт web subscription без атомарного guard', async () => {
    const { svc, subscriptions } = makeAtomicWriteRaceService();
    await svc.subscribe('u-1', { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys });
    expect(subscriptions).toEqual([]);
  });

  it('active→deleted после precheck не создаёт native subscription без атомарного guard', async () => {
    const { svc, subscriptions } = makeAtomicWriteRaceService();
    await svc.registerNative('u-1', 'native-token');
    expect(subscriptions).toEqual([]);
  });
});

describe('sendPush', () => {
  it('подписка во внутреннюю сеть (сохранённая до проверки) не отправляется и удаляется', async () => {
    __setSafeFetchDepsForTests({ resolve: async () => [{ address: '10.0.0.3', family: 4 }] });
    const { svc, pg } = makeService([
      { endpoint: 'https://evil.example/hook', keys, platform: 'web' },
      { endpoint: 'http://127.0.0.1:6379/', keys, platform: 'web' },
    ]);
    const sent = await svc.sendPush('u-1', { title: 't' });
    expect(sent).toBe(0);
    expect(webpush.sendNotification).not.toHaveBeenCalled();
    const deletes = pg.query.mock.calls.filter((c: any[]) => /DELETE FROM push_subscriptions/.test(c[0])).map((c: any[]) => c[1][0]);
    expect(deletes).toEqual(['https://evil.example/hook', 'http://127.0.0.1:6379/']);
  });

  it('публичный endpoint — отправка через пиннинг-агент на проверенный адрес, со сроком', async () => {
    __setSafeFetchDepsForTests({ resolve: async () => [{ address: '142.250.74.10', family: 4 }] });
    (webpush.sendNotification as jest.Mock).mockResolvedValue({ statusCode: 201 });
    const { svc } = makeService([{ endpoint: 'https://FCM.googleapis.com/fcm/send/abc', keys, platform: 'web' }]);
    const sent = await svc.sendPush('u-1', { title: 't' });
    expect(sent).toBe(1);
    const [sub, , opts] = (webpush.sendNotification as jest.Mock).mock.calls[0];
    expect(sub.endpoint).toBe('https://fcm.googleapis.com/fcm/send/abc');
    expect(opts.agent).toBeInstanceOf(https.Agent);
    expect(opts.timeout).toBeGreaterThan(0);

    // Агент соединяется только с проверенным адресом проверенного имени.
    const lookup = (opts.agent as any).options.lookup;
    await new Promise<void>((done) => lookup('fcm.googleapis.com', {}, (err: any, addr: string) => {
      expect(err).toBeNull();
      expect(addr).toBe('142.250.74.10');
      done();
    }));
    await new Promise<void>((done) => lookup('127.0.0.1', {}, (err: any) => {
      expect(err).toBeInstanceOf(UnsafeUrlError);
      done();
    }));
  });

  it('deleted не выполняет outbound web/native push', async () => {
    __setSafeFetchDepsForTests({ resolve: async () => [{ address: '142.250.74.10', family: 4 }] });
    (webpush.sendNotification as jest.Mock).mockResolvedValue({ statusCode: 201 });
    const { svc, pg } = makeService([
      { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys, platform: 'web' },
      { endpoint: 'fcm:native-token', keys: {}, platform: 'android' },
    ], 'deleted');
    const fcm = jest.spyOn(svc as any, 'sendFcm');

    expect(await svc.sendPush('u-1', { title: 't' })).toBe(0);
    expect(webpush.sendNotification).not.toHaveBeenCalled();
    expect(fcm).not.toHaveBeenCalled();
    expect(pg.query.mock.calls.filter(([sql]) => /SELECT .*endpoint.* FROM push_subscriptions/.test(String(sql).replace(/\s+/g, ' ')))).toEqual([]);
  });
});
