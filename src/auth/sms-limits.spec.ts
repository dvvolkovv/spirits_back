import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SMS_CODE_MAX_ATTEMPTS, smsCodeKey } from './sms-code';
import { isSmsPhone, SMS_LIMIT_DEFAULTS, SMS_LIMIT_ENV } from './sms-limits';
import { clockRedis, FakeRedis } from './fake-redis.forspec';
import { sendTelegramAlert } from '../common/telegram-alert';

jest.mock('../common/telegram-alert', () => ({ sendTelegramAlert: jest.fn(async () => undefined) }));
const alerts = jest.mocked(sendTelegramAlert);

/**
 * Лимиты отправки SMS (sms-limits.ts, quota.ts) — как их видит запрос кода:
 * сервис AuthService.requestSmsCode и ответ эндпоинта /sms/:phone.
 *
 * Redis — в памяти, со своими часами (fake-redis.forspec.ts); время двигает
 * advance(). Postgres отвечает на запрос состояния номера: какие номера
 * «известные», какие заблокированы. SMS Aero подменён: считаем, на какие
 * номера ушла SMS.
 */

function makeService(redis: FakeRedis = clockRedis()) {
  const known = new Set<string>();
  const blocked = new Set<string>();
  const pg = {
    async query(_sql: string, params: string[]) {
      const p = params[0];
      if (blocked.has(p)) return { rows: [{ state: 'blocked', known: true }] };
      return { rows: [{ state: known.has(p) ? 'active' : null, known: known.has(p) }] };
    },
  };
  const tracked: Array<[string, any]> = [];
  const events = { track: (name: string, opts: any) => { tracked.push([name, opts]); } };
  const identity = { async resolveOrCreate(_p: string, d: any) { return { status: 'ok', userId: d.phone, isNew: false }; } };
  const jwt = { signAccess: (u: string) => `A-${u}`, signRefresh: (u: string) => `R-${u}` };
  const service = new AuthService(pg as any, redis as any, jwt as any, identity as any, events as any);

  const sent: string[] = [];
  jest.spyOn(service as any, 'sendSms').mockImplementation(async (...args: unknown[]) => { sent.push(args[0] as string); });
  const logs = { warn: [] as string[], error: [] as string[] };
  const logger = (service as any).logger;
  jest.spyOn(logger, 'warn').mockImplementation((m: unknown) => { logs.warn.push(String(m)); });
  jest.spyOn(logger, 'error').mockImplementation((m: unknown) => { logs.error.push(String(m)); });
  jest.spyOn(logger, 'log').mockImplementation(() => undefined);
  return { service, redis, tracked, sent, logs, known, blocked };
}

type Svc = ReturnType<typeof makeService>;

/** Код погашен — входом или пятью неверными (sms-code.ts): следующий запрос заводит новый. */
const burn = (redis: FakeRedis, phone: string) => redis.del(smsCodeKey(phone));

/** Запросить код и сразу погасить его — как в петле накрутки. */
async function requestAndBurn(s: Svc, phone: string) {
  const r = await s.service.requestSmsCode(phone);
  await burn(s.redis, phone);
  return r;
}

/** Заполнить общий счётчик новых номеров: n новых номеров по SMS. */
async function fillGlobal(s: Svc, n: number, from = 9000) {
  for (let i = 0; i < n; i++) expect(await requestAndBurn(s, RU(from + i))).toEqual({ status: 'sent' });
}

/** Настоящие на вид номера, не из тестовых списков AuthService. */
const RU = (i: number) => `7999${String(1000000 + i).slice(-7)}`;
const DE = (i: number) => `49151${String(1000000 + i).slice(-7)}`;

/** Счётчики лимитов — без отметок «об этом уже сообщили» (sms-lim:alerted:*). */
const counters = (s: Svc) => new Map([...s.redis.snapshot('sms-lim:')].filter(([k]) => !k.startsWith('sms-lim:alerted:')));

const sharedEvents = (s: Svc) => s.tracked.filter(([n, o]) => n === 'sms_limit_hit' && !o.userId).map(([, o]) => o.props.scope);

const ENV_KEYS = ['DEBUG_SMS_CODES', 'SMS_AERO_SKIP_PHONES', ...Object.values(SMS_LIMIT_ENV)];
const savedEnv: Record<string, string | undefined> = {};
beforeAll(() => { for (const k of ENV_KEYS) savedEnv[k] = process.env[k]; });
beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.DEBUG_SMS_CODES = 'true'; // как на проде и на тест-стенде
  alerts.mockClear();
});
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
});

// ── Контроллер: что видит клиент ──────────────────────────────────────────

function fakeRes() {
  const out: { code?: number; body?: any; headers: Record<string, string> } = { headers: {} };
  return {
    out,
    set(name: string | Record<string, string>, value?: string) {
      if (typeof name === 'string') out.headers[name] = value!;
      else Object.assign(out.headers, name);
      return this;
    },
    status(code: number) { out.code = code; return this; },
    json(body: any) { out.body = body; return this; },
    send(body: any) { out.body = body; return this; },
  };
}

function makeController(s = makeService()) {
  const links: any[] = [];
  const identity = { async linkMethod(...args: any[]) { links.push(args); return { ok: true }; } };
  const unused = {} as any;
  const controller = new AuthController(
    s.service, unused, identity as any, unused, s.redis as any, unused, unused, unused, { async record() {} } as any, unused,
  );
  return { ...s, controller, links };
}

const askSms = (c: AuthController, phone: string, res: any) =>
  c.sendSms(phone, undefined as any, undefined as any, undefined as any, undefined as any, res);

describe('номер для SMS: формат', () => {
  it('не цифры, не та длина, ведущий ноль — 400 invalid_phone; Redis не тронут, SMS нет', async () => {
    const bad = ['+79991234567', '7 999 123 45 67', '8(999)1234567', 'abc', '', '123456', '1234567890123456', '07991234567'];
    for (const phone of bad) {
      const s = makeController();
      const getSpy = jest.spyOn(s.redis, 'get');
      const res = fakeRes();
      await askSms(s.controller, phone, res);
      expect({ phone, code: res.out.code, body: res.out.body }).toEqual({ phone, code: 400, body: { error: 'invalid_phone' } });
      expect(getSpy).not.toHaveBeenCalled();
      expect(s.redis.snapshot('')).toEqual(new Map());
      expect(s.sent).toEqual([]);
    }
  });

  it('с кодом страны от 7 до 15 цифр — проходит, в том числе короткие номера малых территорий', async () => {
    // Токелау (7), Фареры (9), Россия (11), Германия (13), предел E.164 (15).
    for (const phone of ['6907290', '298211234', '79991234567', '4915112345678', '123456789012345']) {
      expect({ phone, ok: isSmsPhone(phone) }).toEqual({ phone, ok: true });
    }
    const s = makeService();
    expect(await s.service.requestSmsCode('298211234')).toEqual({ status: 'sent' });
    expect(s.sent).toEqual(['298211234']);
  });

  it('заблокированный номер — blocked до всяких лимитов', async () => {
    const s = makeService();
    s.blocked.add(RU(1));
    expect(await s.service.requestSmsCode(RU(1))).toEqual({ status: 'blocked' });
    expect(s.redis.snapshot('sms-lim:')).toEqual(new Map());
  });
});

describe('лимит на номер (и новым, и известным)', () => {
  it('не чаще раза в 60 секунд', async () => {
    const s = makeService();
    expect(await requestAndBurn(s, RU(1))).toEqual({ status: 'sent' });

    s.redis.advance(59);
    expect(await requestAndBurn(s, RU(1))).toEqual({ status: 'rate_limited', scope: 'phone_interval', retryAfterSec: 1 });

    s.redis.advance(1);
    expect(await requestAndBurn(s, RU(1))).toEqual({ status: 'sent' });
    expect(s.sent).toEqual([RU(1), RU(1)]);
  });

  it('известному номеру — тот же лимит, что новому', async () => {
    const s = makeService();
    s.known.add(RU(1));
    expect(await requestAndBurn(s, RU(1))).toEqual({ status: 'sent' });
    s.redis.advance(30);
    expect(await requestAndBurn(s, RU(1))).toEqual({ status: 'rate_limited', scope: 'phone_interval', retryAfterSec: 30 });
  });

  it('не больше 3 в час', async () => {
    const s = makeService();
    for (const t of [0, 60, 60]) {
      s.redis.advance(t);
      expect(await requestAndBurn(s, RU(2))).toEqual({ status: 'sent' });
    }
    s.redis.advance(60); // t = 180
    expect(await requestAndBurn(s, RU(2))).toEqual({ status: 'rate_limited', scope: 'phone_hour', retryAfterSec: 3600 - 180 });

    s.redis.advance(3600 - 180); // окно часа истекло
    expect(await requestAndBurn(s, RU(2))).toEqual({ status: 'sent' });
    expect(s.sent).toHaveLength(4);
  });

  it('срок ответа — по самому дальнему заполненному окну, а не по сработавшему', async () => {
    // Через 10 с после третьей SMS часа запрос упирается в минутный зазор,
    // но и час уже заполнен: «через минуту» было бы неправдой.
    const s = makeService();
    for (const t of [0, 60, 60]) {
      s.redis.advance(t);
      await requestAndBurn(s, RU(3));
    }
    s.redis.advance(10); // t = 130
    expect(await requestAndBurn(s, RU(3))).toEqual({ status: 'rate_limited', scope: 'phone_interval', retryAfterSec: 3600 - 130 });
  });

  it('не больше 5 в сутки', async () => {
    const s = makeService();
    for (const t of [0, 60, 60, 3600 - 120, 60]) { // 0, 60, 120 | 3600, 3660
      s.redis.advance(t);
      expect(await requestAndBurn(s, RU(4))).toEqual({ status: 'sent' });
    }
    s.redis.advance(60); // t = 3720: часовой лимит свободен (2 из 3), суточный исчерпан
    expect(await requestAndBurn(s, RU(4))).toEqual({ status: 'rate_limited', scope: 'phone_day', retryAfterSec: 86400 - 3720 });

    s.redis.advance(86400 - 3720);
    expect(await requestAndBurn(s, RU(4))).toEqual({ status: 'sent' });
    expect(s.sent).toHaveLength(6);
  });

  it('петля «5 неверных → новый код» через привязку телефона упирается в тот же лимит', async () => {
    // Код для привязки запрашивается тем же /sms/:phone, что и для входа.
    const s = makeController();
    const phone = RU(5);
    let res = fakeRes();
    await askSms(s.controller, phone, res);
    expect(res.out.code).toBe(200);

    for (let i = 0; i < SMS_CODE_MAX_ATTEMPTS; i++) {
      await s.controller.linkPhone({ phone, code: 'wrong!' }, { user: { userId: 'u1' } }, fakeRes() as any);
    }
    expect(s.redis.peek(smsCodeKey(phone))).toBeNull(); // код погашен лимитом попыток

    res = fakeRes();
    await askSms(s.controller, phone, res);
    expect(res.out.code).toBe(429);
    expect(s.sent).toEqual([phone]);
    expect(s.links).toEqual([]);
  });
});

describe('новые номера: общий потолок закрыт — ответ как при успехе, но без SMS', () => {
  it('не больше 30 в час: 31-й новый номер — «отправлено», а SMS, кода и ключей номера нет', async () => {
    const s = makeService();
    await fillGlobal(s, 30);
    s.redis.advance(600);

    expect(await s.service.requestSmsCode(RU(200))).toEqual({ status: 'suppressed' });
    expect(s.sent).toHaveLength(30);
    expect(s.redis.peek(smsCodeKey(RU(200)))).toBeNull();
    expect(s.redis.snapshot(`sms-lim:phone:${RU(200)}`)).toEqual(new Map());
    expect(s.redis.peek('sms-lim:global:h')).toBe('30');
  });

  it('не больше 100 в сутки', async () => {
    const s = makeService();
    let n = 0;
    for (const batch of [30, 30, 30, 10]) {
      await fillGlobal(s, batch, 1000 + n);
      n += batch;
      s.redis.advance(3600);
    }
    // t = 4 ч: часовой окно свободно, суточное исчерпано.
    expect(await s.service.requestSmsCode(RU(2000))).toEqual({ status: 'suppressed' });
    expect(s.sent).toHaveLength(100);
  });

  it('номера не на 7 — не больше 5 в час, а +7 при этом уходят', async () => {
    const s = makeService();
    for (let i = 0; i < 5; i++) expect(await requestAndBurn(s, DE(i))).toEqual({ status: 'sent' });

    expect(await requestAndBurn(s, DE(5))).toEqual({ status: 'suppressed' });
    expect(await requestAndBurn(s, RU(6))).toEqual({ status: 'sent' });
    expect(s.sent).toEqual([DE(0), DE(1), DE(2), DE(3), DE(4), RU(6)]);
  });

  it('номера не на 7 — не больше 15 в сутки', async () => {
    const s = makeService();
    let n = 0;
    for (let h = 0; h < 3; h++) {
      for (let i = 0; i < 5; i++) expect(await requestAndBurn(s, DE(n++))).toEqual({ status: 'sent' });
      s.redis.advance(3600);
    }
    expect(await requestAndBurn(s, DE(99))).toEqual({ status: 'suppressed' });
  });

  it('номера не на 7 входят и в общий лимит', async () => {
    process.env.SMS_LIMIT_GLOBAL_PER_HOUR = '3';
    const s = makeService();
    for (let i = 0; i < 3; i++) expect(await requestAndBurn(s, DE(i))).toEqual({ status: 'sent' });
    expect(await requestAndBurn(s, RU(9))).toEqual({ status: 'suppressed' });
  });

  it('пачка параллельных запросов не проскакивает потолок', async () => {
    process.env.SMS_LIMIT_GLOBAL_PER_HOUR = '5';
    const s = makeService();
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => s.service.requestSmsCode(RU(500 + i))));
    expect(results.filter((r) => r.status === 'sent')).toHaveLength(5);
    expect(results.filter((r) => r.status === 'suppressed')).toHaveLength(15);
    expect(s.sent).toHaveLength(5);
  });

  it('подавленный запрос квоту номера не тратит: потолок открылся — SMS уходит сразу', async () => {
    const s = makeService();
    await fillGlobal(s, 30); // общий час заполнен в t = 0
    for (const t of [100, 100, 100]) {
      s.redis.advance(t);
      expect(await requestAndBurn(s, RU(400))).toEqual({ status: 'suppressed' });
    }
    s.redis.advance(3600 - 300);
    expect(await requestAndBurn(s, RU(400))).toEqual({ status: 'sent' });
  });
});

describe('известные номера: свой общий счётчик', () => {
  it('global закрыт накруткой — известные номера по-прежнему получают SMS', async () => {
    const s = makeService();
    await fillGlobal(s, 30);
    for (const p of [RU(1), DE(1)]) {
      s.known.add(p);
      expect(await requestAndBurn(s, p)).toEqual({ status: 'sent' });
    }
    expect(s.redis.peek('sms-lim:global:h')).toBe('30');
    expect(s.redis.peek('sms-lim:known:h')).toBe('2');
  });

  it('global и intl известных не касаются, их SMS считает только known', async () => {
    const s = makeService();
    s.known.add(DE(1));
    await requestAndBurn(s, DE(1));
    expect(s.redis.peek('sms-lim:known:h')).toBe('1');
    expect(s.redis.peek('sms-lim:global:h')).toBeNull();
    expect(s.redis.peek('sms-lim:intl:h')).toBeNull();
  });

  it('known: не больше 60 в час — дальше 429 со сроком окна', async () => {
    const s = makeService();
    for (let i = 0; i < 60; i++) {
      s.known.add(RU(700 + i));
      expect(await requestAndBurn(s, RU(700 + i))).toEqual({ status: 'sent' });
    }
    s.redis.advance(600);
    s.known.add(RU(800));
    expect(await requestAndBurn(s, RU(800))).toEqual({ status: 'rate_limited', scope: 'known_hour', retryAfterSec: 3000 });
    expect(s.sent).toHaveLength(60);
  });

  it('known: не больше 200 в сутки', async () => {
    const s = makeService();
    let n = 0;
    for (let h = 0; h < 4; h++) {
      for (let i = 0; i < 50; i++) {
        s.known.add(RU(3000 + n));
        expect(await requestAndBurn(s, RU(3000 + n++))).toEqual({ status: 'sent' });
      }
      s.redis.advance(3600);
    }
    s.known.add(RU(4000));
    expect(await requestAndBurn(s, RU(4000))).toEqual({ status: 'rate_limited', scope: 'known_day', retryAfterSec: 86400 - 4 * 3600 });
  });
});

describe('приватность: по ответу не узнать, зарегистрирован ли номер', () => {
  it('ответ новому номеру при закрытом потолке неотличим от успеха', async () => {
    const s = makeController();
    await fillGlobal(s, 29);

    const real = fakeRes();
    await askSms(s.controller, RU(100), real); // 30-я — настоящая
    const suppressed = fakeRes();
    await askSms(s.controller, RU(101), suppressed); // потолок закрыт

    expect(s.sent).toContain(RU(100));
    expect(s.sent).not.toContain(RU(101));
    expect(suppressed.out).toEqual(real.out);
    expect(real.out).toEqual({ code: 200, body: 'SMS sent', headers: expect.objectContaining({ 'Access-Control-Allow-Origin': '*' }) });
  });

  it('ответ не ждёт SMS Aero: по времени подавленную отправку не отличить', async () => {
    const s = makeService();
    (s.service as any).sendSms.mockImplementation(() => new Promise(() => undefined)); // SMS Aero «висит»
    const timeout = new Promise((resolve) => setTimeout(() => resolve('ждал SMS Aero'), 200));
    expect(await Promise.race([s.service.requestSmsCode(RU(1)), timeout])).toEqual({ status: 'sent' });
  });

  it('свой лимит номера старше общего: исчерпавший его новый номер получает 429 и при закрытом global — как известный', async () => {
    // Если бы первым решал общий счётчик, новый номер получил бы «успех», а
    // известный в том же положении — 429, и разница выдала бы регистрацию.
    const s = makeService();
    const fresh = RU(10);
    const member = RU(11);
    s.known.add(member);
    for (const t of [0, 60, 60]) {
      s.redis.advance(t);
      expect(await requestAndBurn(s, fresh)).toEqual({ status: 'sent' });
      expect(await requestAndBurn(s, member)).toEqual({ status: 'sent' });
    }
    await fillGlobal(s, 27); // вместе с тремя SMS на fresh — 30, потолок закрыт
    s.redis.advance(60); // t = 180

    const expected = { status: 'rate_limited', scope: 'phone_hour', retryAfterSec: 3600 - 180 };
    expect(await requestAndBurn(s, fresh)).toEqual(expected);
    expect(await requestAndBurn(s, member)).toEqual(expected);
  });

  it('срок 429 новому номеру — только по его окнам: закрытый global в него не попадает', async () => {
    const s = makeService();
    await fillGlobal(s, 29);
    expect(await requestAndBurn(s, RU(12))).toEqual({ status: 'sent' }); // 30-я, общий час закрыт до t = 3600
    s.redis.advance(10);
    expect(await requestAndBurn(s, RU(12))).toEqual({ status: 'rate_limited', scope: 'phone_interval', retryAfterSec: 50 });
  });
});

describe('отказ ничего не пишет (проверка и учёт — один Lua-скрипт)', () => {
  it('после исчерпания общего лимита запрос на новый номер не оставляет ключей sms-lim:phone:*', async () => {
    const s = makeService();
    await fillGlobal(s, 30);
    const before = counters(s);
    for (let i = 0; i < 10; i++) expect(await s.service.requestSmsCode(RU(300 + i))).toEqual({ status: 'suppressed' });
    expect(counters(s)).toEqual(before);
    expect(s.redis.snapshot('sms-lim:phone:')).toEqual(new Map([...before].filter(([k]) => k.startsWith('sms-lim:phone:'))));
  });

  it('отказ по номеру не меняет ни одного счётчика', async () => {
    const s = makeService();
    await requestAndBurn(s, RU(13));
    const before = counters(s);
    for (let i = 0; i < 20; i++) expect((await requestAndBurn(s, RU(13))).status).toBe('rate_limited');
    expect(counters(s)).toEqual(before);
  });

  it('ошибка Redis — нет полу-насчитанных ключей: учтено во всех окнах или ни в одном', async () => {
    const keysOf = (p: string) => [`sms-lim:phone:${p}:interval`, `sms-lim:phone:${p}:h`, `sms-lim:phone:${p}:d`, 'sms-lim:global:h', 'sms-lim:global:d'];
    for (let writes = 0; writes <= 4; writes++) {
      const s = makeService();
      await requestAndBurn(s, RU(14)); // общие счётчики уже не пустые
      const before = s.redis.snapshot('sms-lim:');
      s.redis.breakAfter(writes);
      await s.service.requestSmsCode(RU(15)).catch(() => undefined);
      s.redis.breakAfter(Infinity);
      const after = s.redis.snapshot('sms-lim:');
      const deltas = keysOf(RU(15)).map((k) => Number(after.get(k) ?? 0) - Number(before.get(k) ?? 0));
      expect({ writes, deltas }).toEqual({ writes, deltas: writes === 0 ? [0, 0, 0, 0, 0] : [1, 1, 1, 1, 1] });
    }
  });

  it('счётчики не уходят в минус и равны числу настоящих SMS', async () => {
    process.env.SMS_LIMIT_GLOBAL_PER_HOUR = '4';
    const s = makeService();
    for (let i = 0; i < 4; i++) await requestAndBurn(s, RU(20 + i));
    for (let i = 0; i < 6; i++) await requestAndBurn(s, RU(20)); // отказы по номеру
    for (let i = 0; i < 6; i++) await requestAndBurn(s, RU(40 + i)); // подавлены потолком
    expect([...counters(s).values()].every((v) => Number(v) >= 0)).toBe(true);
    expect(s.redis.peek('sms-lim:global:h')).toBe(String(s.sent.length));
    expect(s.redis.peek(`sms-lim:phone:${RU(20)}:h`)).toBe('1');
  });
});

describe('алерт владельцу: раз за окно на общий счётчик', () => {
  it('global закрылся — один алерт, один error и одно событие на окно, сколько бы ни было отказов', async () => {
    const s = makeService();
    await fillGlobal(s, 30);
    s.redis.advance(600);
    for (let i = 0; i < 10; i++) await s.service.requestSmsCode(RU(300 + i));

    expect(alerts).toHaveBeenCalledTimes(1);
    expect(alerts.mock.calls[0][0]).toContain('global_hour');
    expect(s.logs.error).toHaveLength(1);
    expect(s.logs.error[0]).toContain('global_hour');
    expect(sharedEvents(s)).toEqual(['global_hour']);
    // Отметка живёт ровно остаток окна.
    expect(await s.redis.ttl('sms-lim:alerted:global:h')).toBe(3000);
  });

  it('в алерте и в логе — ни одного номера', async () => {
    const s = makeService();
    await fillGlobal(s, 30);
    await s.service.requestSmsCode(RU(301));
    const text = alerts.mock.calls[0][0] + s.logs.error.join('\n');
    expect(text).not.toMatch(/\d{7,}/);
  });

  it('в следующем окне — снова один алерт', async () => {
    const s = makeService();
    await fillGlobal(s, 30, 9000);
    await s.service.requestSmsCode(RU(301));
    s.redis.advance(3600);
    await fillGlobal(s, 30, 9100);
    await s.service.requestSmsCode(RU(302));
    await s.service.requestSmsCode(RU(303));
    expect(alerts).toHaveBeenCalledTimes(2);
    expect(sharedEvents(s)).toEqual(['global_hour', 'global_hour']);
  });

  it('intl и known — свои алерты; лимит номера алерта не шлёт', async () => {
    const s = makeService();
    await requestAndBurn(s, RU(30));
    await requestAndBurn(s, RU(30)); // отказ по номеру: warn и событие, без алерта
    expect(alerts).not.toHaveBeenCalled();

    for (let i = 0; i < 5; i++) await requestAndBurn(s, DE(i));
    await requestAndBurn(s, DE(9));
    expect(alerts.mock.calls.map(([t]) => t.match(/intl_hour|known_hour|global_hour/)?.[0])).toEqual(['intl_hour']);

    process.env.SMS_LIMIT_KNOWN_PER_HOUR = '1';
    s.known.add(RU(31)).add(RU(32)).add(RU(34));
    await requestAndBurn(s, RU(31));
    expect(await requestAndBurn(s, RU(32))).toMatchObject({ status: 'rate_limited', scope: 'known_hour' });
    expect(await requestAndBurn(s, RU(34))).toMatchObject({ status: 'rate_limited', scope: 'known_hour' });
    expect(await requestAndBurn(s, RU(33))).toEqual({ status: 'sent' }); // новый номер known не касается
    expect(alerts.mock.calls.map(([t]) => t.match(/intl_hour|known_hour|global_hour/)?.[0])).toEqual(['intl_hour', 'known_hour']);
    expect(sharedEvents(s)).toEqual(['intl_hour', 'known_hour']);
    // По общему счётчику — одно событие на окно, сколько бы ни было отказов.
    expect(s.tracked.filter(([n, o]) => n === 'sms_limit_hit' && o.props.scope === 'known_hour')).toHaveLength(1);
  });
});

describe('что лимит не считает', () => {
  it('тестовые номера (без реальной SMS) — сколько угодно раз', async () => {
    const s = makeService();
    for (let i = 0; i < 10; i++) {
      for (const phone of ['70000000000', '79030169187', '79030012345']) {
        expect(await requestAndBurn(s, phone)).toEqual({ status: 'sent' });
      }
    }
    expect(s.redis.snapshot('sms-lim:')).toEqual(new Map());
    expect(s.sent).toEqual([]);
  });

  it('номера из SMS_AERO_SKIP_PHONES — тоже', async () => {
    process.env.SMS_AERO_SKIP_PHONES = `${RU(8)}, ${RU(9)}`;
    const s = makeService();
    for (let i = 0; i < 10; i++) expect(await requestAndBurn(s, RU(8))).toEqual({ status: 'sent' });
    expect(s.redis.snapshot('sms-lim:')).toEqual(new Map());
  });

  it('«двойной» номер с ?nosms=1 не считается, без флага — считается', async () => {
    const s = makeService();
    for (let i = 0; i < 5; i++) {
      expect(await s.service.requestSmsCode('79656445804', null, null, { suppressSms: true })).toEqual({ status: 'sent' });
      await burn(s.redis, '79656445804');
    }
    expect(s.redis.snapshot('sms-lim:')).toEqual(new Map());

    expect(await requestAndBurn(s, '79656445804')).toEqual({ status: 'sent' });
    expect(s.redis.peek('sms-lim:phone:79656445804:h')).toBe('1');
  });

  it('путь «код уже выслан» не считается', async () => {
    // Повторы — с шагом больше минутного зазора, но пока код жив (5 минут).
    const s = makeService();
    expect(await s.service.requestSmsCode(RU(10))).toEqual({ status: 'sent' });
    for (let i = 0; i < 4; i++) {
      s.redis.advance(70);
      expect(await s.service.requestSmsCode(RU(10))).toEqual({ status: 'exists' });
    }
    expect(s.redis.peek(`sms-lim:phone:${RU(10)}:h`)).toBe('1');
    expect(s.redis.peek('sms-lim:global:h')).toBe('1');
    expect(s.sent).toEqual([RU(10)]);
  });
});

describe('отказ по лимиту номера', () => {
  it('код не записан, SMS не ушла, otp_request нет; warn и событие с номером', async () => {
    const s = makeService();
    await requestAndBurn(s, RU(11));
    s.tracked.length = 0;

    s.redis.advance(10);
    expect((await s.service.requestSmsCode(RU(11))).status).toBe('rate_limited');
    expect(s.redis.peek(smsCodeKey(RU(11)))).toBeNull();
    expect(s.sent).toEqual([RU(11)]);
    expect(s.tracked).toEqual([['sms_limit_hit', { userId: RU(11), props: { scope: 'phone_interval' } }]]);
    expect(s.logs.warn).toHaveLength(1);
    expect(s.logs.warn[0]).toContain('phone_interval');
    expect(s.logs.warn[0]).not.toContain(RU(11));
  });

  it('клиенту — 429 too_many_requests, retryAfterSec и Retry-After', async () => {
    const s = makeController();
    let res = fakeRes();
    await askSms(s.controller, RU(12), res);
    expect(res.out.code).toBe(200);
    expect(res.out.body).toBe('SMS sent');
    await burn(s.redis, RU(12));

    s.redis.advance(15);
    res = fakeRes();
    await askSms(s.controller, RU(12), res);
    expect(res.out.code).toBe(429);
    expect(res.out.body).toEqual({ error: 'too_many_requests', retryAfterSec: 45 });
    expect(res.out.headers['Retry-After']).toBe('45');
    expect(res.out.headers['Access-Control-Allow-Origin']).toBe('*');
  });
});

describe('пороги', () => {
  it('по умолчанию — те, что в задаче', () => {
    expect(SMS_LIMIT_DEFAULTS).toEqual({
      phoneIntervalSec: 60, phonePerHour: 3, phonePerDay: 5,
      globalPerHour: 30, globalPerDay: 100, intlPerHour: 5, intlPerDay: 15,
      knownPerHour: 60, knownPerDay: 200,
    });
  });

  it('поднимаются через SMS_LIMIT_* без правки кода', async () => {
    process.env.SMS_LIMIT_PHONE_PER_HOUR = '10';
    process.env.SMS_LIMIT_PHONE_INTERVAL_SEC = '120';
    const s = makeService();
    await requestAndBurn(s, RU(13));
    s.redis.advance(60);
    expect(await requestAndBurn(s, RU(13))).toMatchObject({ status: 'rate_limited', scope: 'phone_interval', retryAfterSec: 60 });
    for (let i = 0; i < 4; i++) {
      s.redis.advance(120);
      expect(await requestAndBurn(s, RU(13))).toEqual({ status: 'sent' });
    }
    expect(s.sent).toHaveLength(5); // больше трёх в час
  });

  it('неверное значение — умолчание и одно предупреждение, а не по одному на SMS', async () => {
    process.env.SMS_LIMIT_PHONE_PER_HOUR = 'десять';
    process.env.SMS_LIMIT_GLOBAL_PER_HOUR = '0';
    const s = makeService();
    for (const t of [0, 60, 60, 60]) {
      s.redis.advance(t);
      await requestAndBurn(s, RU(14));
    }
    expect(s.sent).toHaveLength(3);
    const envWarns = s.logs.warn.filter((m) => m.includes('SMS_LIMIT_'));
    expect(envWarns).toHaveLength(2);
    expect(envWarns.join('\n')).toContain('SMS_LIMIT_PHONE_PER_HOUR=десять');
    expect(envWarns.join('\n')).toContain('SMS_LIMIT_GLOBAL_PER_HOUR=0');
  });

  it('счётчик без срока получает срок: при учёте и при отказе (иначе окно не откроется никогда)', async () => {
    const s = makeService();
    await s.redis.set('sms-lim:global:h', '7'); // не полный, без срока
    expect(await requestAndBurn(s, RU(15))).toEqual({ status: 'sent' });
    expect(await s.redis.ttl('sms-lim:global:h')).toBe(3600);

    await s.redis.set('sms-lim:global:d', '100'); // полный, без срока
    expect(await requestAndBurn(s, RU(16))).toEqual({ status: 'suppressed' });
    expect(await s.redis.ttl('sms-lim:global:d')).toBe(86400);
  });
});
