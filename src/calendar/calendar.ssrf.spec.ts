import * as http from 'http';
import { AddressInfo } from 'net';

jest.mock('child_process', () => ({ execFile: jest.fn() }));

import { execFile } from 'child_process';
import { CalendarService } from './calendar.service';
import { ExchangeEwsConnector, curlResolveArgs } from './exchange';
import { fetchCalendarEvents } from '../trip/calendar';
import { isBlockedAddress } from '../common/net/ip-policy';
import { __setSafeFetchDepsForTests, assertPublicUrl } from '../common/net/safe-fetch';

/**
 * Календари по ссылке — SSRF-точки: ICS-ссылку и адрес Exchange вводит сам
 * человек, а ходит по ним сервер. ICS-текст разбирается и показывается, так
 * что ссылка на внутренний сервис превращалась в чтение этого сервиса (или
 * хотя бы в сканер портов по тексту ошибки).
 */

const ICS = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:1\r\nDTSTART:20260920T090000Z\r\nDTEND:20260920T100000Z\r\nSUMMARY:Планёрка\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';

function makeService() {
  const pg = { query: jest.fn(async () => ({ rows: [], rowCount: 1 })) };
  const svc = new CalendarService(pg as any, {} as any, {} as any, {} as any);
  return { svc, pg };
}

/** «Интернет» в тесте — ровно 127.0.0.1, всё остальное по настоящим правилам. */
function localAsPublic(table: Record<string, string>) {
  __setSafeFetchDepsForTests({
    resolve: async (h) => {
      if (!table[h]) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
      return [{ address: table[h], family: 4 }];
    },
    isBlocked: (ip) => ip !== '127.0.0.1' && isBlockedAddress(ip),
  });
}

let srv: http.Server;
let hits: string[];
let port: number;

beforeEach(async () => {
  hits = [];
  srv = http.createServer((req, res) => {
    hits.push(req.url || '');
    if (req.url === '/redirect-inside') { res.statusCode = 302; res.setHeader('Location', 'http://10.0.0.5:6379/'); return res.end(); }
    res.setHeader('Content-Type', 'text/calendar');
    res.end(ICS);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  port = (srv.address() as AddressInfo).port;
  (execFile as unknown as jest.Mock).mockReset();
});

afterEach(async () => {
  await new Promise<void>((r) => srv.close(() => r()));
  __setSafeFetchDepsForTests(null);
  jest.restoreAllMocks();
});

describe('addIcs: ссылку ввёл человек', () => {
  it.each([
    () => `http://127.0.0.1:${port}/cal.ics`,
    () => `http://localhost:${port}/cal.ics`,
    () => 'http://169.254.169.254/latest/meta-data/',
    () => `webcal://[::1]:${port}/cal.ics`,
    () => 'http://2130706433:6379/',
  ])('%s — отказ с понятной причиной, без запроса и без записи в БД', async (mk) => {
    const { svc, pg } = makeService();
    const r = await svc.addIcs('u-1', 'outlook', mk());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^Ссылка не подходит: адрес ведёт во внутреннюю сеть$/);
    expect(hits).toHaveLength(0);
    expect(pg.query).not.toHaveBeenCalled();
  });

  it('публичная ссылка с редиректом во внутреннюю сеть — отказ', async () => {
    localAsPublic({ 'cal.example': '127.0.0.1' });
    const { svc, pg } = makeService();
    const r = await svc.addIcs('u-1', 'outlook', `http://cal.example:${port}/redirect-inside`);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/внутреннюю сеть/);
    expect(hits).toEqual(['/redirect-inside']);
    expect(pg.query).not.toHaveBeenCalled();
  });

  it('обычная публичная ссылка по-прежнему подключается (http и свой порт допустимы)', async () => {
    localAsPublic({ 'cal.example': '127.0.0.1' });
    const { svc, pg } = makeService();
    const r = await svc.addIcs('u-1', 'outlook', `http://cal.example:${port}/cal.ics`);
    expect(r).toEqual({ ok: true });
    expect(pg.query).toHaveBeenCalledTimes(1);
  });
});

describe('fetchCalendarEvents: сохранённые ссылки', () => {
  it('внутренние пропускаются молча, публичные читаются', async () => {
    localAsPublic({ 'cal.example': '127.0.0.1', 'evil.example': '10.1.2.3' });
    const events = await fetchCalendarEvents(
      [
        { url: 'http://evil.example/cal.ics', source: 'evil' },
        { url: `http://cal.example:${port}/redirect-inside`, source: 'redir' },
        { url: `http://cal.example:${port}/cal.ics`, source: 'ok' },
      ],
      new Date('2026-09-19T00:00:00Z'),
      new Date('2026-09-21T00:00:00Z'),
    );
    expect(events).toEqual([expect.objectContaining({ title: 'Планёрка', source: 'ok' })]);
    expect(hits).toEqual(['/redirect-inside', '/cal.ics']);
  });
});

describe('Exchange: адрес сервера ввёл человек', () => {
  it('connectExchange на внутренний адрес — понятный отказ, curl не запускается', async () => {
    const test = jest.spyOn(ExchangeEwsConnector.prototype, 'test');
    const { svc, pg } = makeService();
    const r = await svc.connectExchange('u-1', '127.0.0.1:8443', 'corp', 'ivan', 'secret');
    expect(r).toEqual({ ok: false, error: 'Адрес сервера не подходит: адрес ведёт во внутреннюю сеть' });
    expect(test).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
    expect(pg.query).not.toHaveBeenCalled();
  });

  it('коннектор сам не пускает curl во внутреннюю сеть (test → false, listEvents → [])', async () => {
    __setSafeFetchDepsForTests({ resolve: async () => [{ address: '192.168.10.2', family: 4 }] });
    const c = new ExchangeEwsConnector();
    const creds = { server: 'mail.corp.example', username: 'ivan@corp', password: 'p' };
    await expect(c.test(creds)).resolves.toBe(false);
    await expect(c.listEvents(creds, new Date(), new Date(Date.now() + 864e5))).resolves.toEqual([]);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('публичный сервер: curl пиннится на проверенные IP, только https, без прокси', async () => {
    __setSafeFetchDepsForTests({
      resolve: async () => [{ address: '93.184.216.34', family: 4 }, { address: '2606:2800:220:1::1', family: 6 }],
    });
    (execFile as unknown as jest.Mock).mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      cb(null, { stdout: '<m:ResponseCode>NoError</m:ResponseCode>', stderr: '' });
    });
    const c = new ExchangeEwsConnector();
    await expect(c.test({ server: 'https://Mail.Corp.Example:8443/owa', username: 'ivan@corp', password: 'p' })).resolves.toBe(true);

    const [cmd, args] = (execFile as unknown as jest.Mock).mock.calls[0];
    expect(cmd).toBe('curl');
    const pair = (flag: string) => args[args.indexOf(flag) + 1];
    expect(pair('--resolve')).toBe('mail.corp.example:8443:93.184.216.34,[2606:2800:220:1::1]');
    expect(pair('--proto')).toBe('=https');
    expect(pair('--noproxy')).toBe('*');
    expect(args).toContain('https://mail.corp.example:8443/EWS/Exchange.asmx');
  });

  it('curlResolveArgs: для IP-литерала пиннинг не нужен', async () => {
    const t = await assertPublicUrl('https://93.184.216.34/EWS/Exchange.asmx', { allowAnyPort: true });
    expect(curlResolveArgs(t)).toEqual([]);
  });
});
