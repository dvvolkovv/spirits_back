import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SMS_CODE_MAX_ATTEMPTS, smsCodeKey } from './sms-code';
import { isSmsPhone, SMS_LIMIT_DEFAULTS, SMS_LIMIT_ENV } from './sms-limits';

/**
 * Лимиты отправки SMS (sms-limits.ts) — как их видит запрос кода: сервис
 * AuthService.requestSmsCode и ответ эндпоинта /sms/:phone.
 *
 * Redis — в памяти, со своими часами: ключи истекают, TTL/INCR/DECR ведут себя
 * как у настоящего (INCR на отсутствующем ключе заводит его без срока). Время
 * двигает advance(). SMS Aero подменён: считаем, на какие номера ушла SMS.
 */

function clockRedis() {
  let now = 0; // мс
  const data = new Map<string, string>();
  const expiresAt = new Map<string, number>();
  const alive = (key: string) => {
    const exp = expiresAt.get(key);
    if (exp !== undefined && exp <= now) {
      data.delete(key);
      expiresAt.delete(key);
    }
    return data.has(key);
  };
  const add = (key: string, delta: number) => {
    const n = Number(alive(key) ? data.get(key) : 0) + delta;
    data.set(key, String(n));
    return n;
  };
  return {
    advance(sec: number) { now += sec * 1000; },
    /** Значение без побочных эффектов теста — для проверок. */
    peek(key: string) { return alive(key) ? data.get(key)! : null; },
    limitKeys() { return [...data.keys()].filter((k) => k.startsWith('sms-lim:') && alive(k)); },
    async get(key: string) { return alive(key) ? data.get(key)! : null; },
    async set(key: string, value: string, ttlSeconds?: number) {
      data.set(key, value);
      if (ttlSeconds) expiresAt.set(key, now + ttlSeconds * 1000); else expiresAt.delete(key);
    },
    async del(key: string) { data.delete(key); expiresAt.delete(key); },
    async incr(key: string) { return add(key, 1); },
    async decr(key: string) { return add(key, -1); },
    async expire(key: string, seconds: number) { if (alive(key)) expiresAt.set(key, now + seconds * 1000); },
    async ttl(key: string) {
      if (!alive(key)) return -2;
      const exp = expiresAt.get(key);
      return exp === undefined ? -1 : Math.round((exp - now) / 1000);
    },
  };
}

type Redis = ReturnType<typeof clockRedis>;

function makeService(redis: Redis = clockRedis()) {
  const pg = { async query() { return { rows: [] }; } };
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
  return { service, redis, tracked, sent, logs };
}

/** Код погашен — входом или пятью неверными (sms-code.ts): следующий запрос заводит новый. */
const burn = (redis: Redis, phone: string) => redis.del(smsCodeKey(phone));

/** Запросить код и сразу погасить его — как в петле накрутки. */
async function requestAndBurn(s: ReturnType<typeof makeService>, phone: string) {
  const r = await s.service.requestSmsCode(phone);
  await burn(s.redis, phone);
  return r;
}

/** Настоящие на вид номера, не из тестовых списков AuthService. */
const RU = (i: number) => `7999${String(1000000 + i).slice(-7)}`;
const DE = (i: number) => `49151${String(1000000 + i).slice(-7)}`;

const ENV_KEYS = ['DEBUG_SMS_CODES', 'SMS_AERO_SKIP_PHONES', ...Object.values(SMS_LIMIT_ENV)];
const savedEnv: Record<string, string | undefined> = {};
beforeAll(() => { for (const k of ENV_KEYS) savedEnv[k] = process.env[k]; });
beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.DEBUG_SMS_CODES = 'true'; // как на проде и на тест-стенде
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
      expect(s.redis.peek(smsCodeKey(phone))).toBeNull();
      expect(s.redis.limitKeys()).toEqual([]);
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
});

describe('лимит на номер', () => {
  it('не чаще раза в 60 секунд', async () => {
    const s = makeService();
    expect(await requestAndBurn(s, RU(1))).toEqual({ status: 'sent' });

    s.redis.advance(59);
    expect(await requestAndBurn(s, RU(1))).toEqual({ status: 'rate_limited', scope: 'phone_interval', retryAfterSec: 1 });

    s.redis.advance(1);
    expect(await requestAndBurn(s, RU(1))).toEqual({ status: 'sent' });
    expect(s.sent).toEqual([RU(1), RU(1)]);
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

describe('общий лимит', () => {
  it('не больше 30 в час на все номера; срабатывание — logger.error и событие', async () => {
    const s = makeService();
    for (let i = 0; i < 30; i++) expect(await requestAndBurn(s, RU(100 + i))).toEqual({ status: 'sent' });

    s.redis.advance(600);
    expect(await requestAndBurn(s, RU(200))).toEqual({ status: 'rate_limited', scope: 'global_hour', retryAfterSec: 3000 });
    expect(s.sent).toHaveLength(30);
    expect(s.logs.error).toHaveLength(1);
    expect(s.logs.error[0]).toContain('global_hour');
    expect(s.logs.error[0]).toContain(`***${RU(200).slice(-4)}`); // номер замаскирован
    expect(s.logs.error[0]).not.toContain(RU(200));
    expect(s.tracked.filter(([n]) => n === 'sms_limit_hit')).toEqual([
      ['sms_limit_hit', { userId: RU(200), props: { scope: 'global_hour' } }],
    ]);
  });

  it('не больше 100 в сутки на все номера', async () => {
    const s = makeService();
    let n = 0;
    for (const batch of [30, 30, 30, 10]) {
      for (let i = 0; i < batch; i++) expect(await requestAndBurn(s, RU(1000 + n++))).toEqual({ status: 'sent' });
      s.redis.advance(3600);
    }
    // t = 4 ч: часовой лимит свободен, суточный исчерпан.
    expect(await requestAndBurn(s, RU(2000))).toEqual({ status: 'rate_limited', scope: 'global_day', retryAfterSec: 86400 - 4 * 3600 });
    expect(s.sent).toHaveLength(100);
    expect(s.logs.error).toHaveLength(1);
  });

  it('номера не на 7 — не больше 5 в час, а +7 при этом проходят', async () => {
    const s = makeService();
    for (let i = 0; i < 5; i++) expect(await requestAndBurn(s, DE(i))).toEqual({ status: 'sent' });

    expect(await requestAndBurn(s, DE(5))).toEqual({ status: 'rate_limited', scope: 'intl_hour', retryAfterSec: 3600 });
    expect(s.logs.error).toHaveLength(1);
    expect(await requestAndBurn(s, RU(6))).toEqual({ status: 'sent' });
  });

  it('номера не на 7 — не больше 15 в сутки', async () => {
    const s = makeService();
    let n = 0;
    for (let h = 0; h < 3; h++) {
      for (let i = 0; i < 5; i++) expect(await requestAndBurn(s, DE(n++))).toEqual({ status: 'sent' });
      s.redis.advance(3600);
    }
    expect(await requestAndBurn(s, DE(99))).toEqual({ status: 'rate_limited', scope: 'intl_day', retryAfterSec: 86400 - 3 * 3600 });
  });

  it('отказ по номеру общих счётчиков не трогает: долбёжка одного номера не мешает чужим', async () => {
    const s = makeService();
    await requestAndBurn(s, RU(7));
    for (let i = 0; i < 50; i++) {
      expect((await requestAndBurn(s, RU(7))).status).toBe('rate_limited');
    }
    expect(s.redis.peek('sms-lim:global:h')).toBe('1');
    expect(s.redis.peek('sms-lim:global:d')).toBe('1');
    expect(s.logs.error).toEqual([]); // это не общий лимит
  });

  it('отказ по общему лимиту не тратит квоту номера', async () => {
    const s = makeService();
    for (let i = 0; i < 30; i++) await requestAndBurn(s, RU(300 + i));
    // Общий час заполнен в t = 0. Человек трижды пробует за этот час.
    for (const t of [100, 100, 100]) {
      s.redis.advance(t);
      expect(await requestAndBurn(s, RU(400))).toMatchObject({ status: 'rate_limited', scope: 'global_hour' });
    }
    s.redis.advance(3600 - 300); // общий час освободился, а его собственный — нет
    expect(await requestAndBurn(s, RU(400))).toEqual({ status: 'sent' });
  });

  it('пачка параллельных запросов не проскакивает лимит', async () => {
    process.env.SMS_LIMIT_GLOBAL_PER_HOUR = '5';
    const s = makeService();
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => s.service.requestSmsCode(RU(500 + i))));
    expect(results.filter((r) => r.status === 'sent')).toHaveLength(5);
    expect(s.sent).toHaveLength(5);
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
    expect(s.redis.limitKeys()).toEqual([]);
    expect(s.sent).toEqual([]);
  });

  it('номера из SMS_AERO_SKIP_PHONES — тоже', async () => {
    process.env.SMS_AERO_SKIP_PHONES = `${RU(8)}, ${RU(9)}`;
    const s = makeService();
    for (let i = 0; i < 10; i++) expect(await requestAndBurn(s, RU(8))).toEqual({ status: 'sent' });
    expect(s.redis.limitKeys()).toEqual([]);
  });

  it('«двойной» номер с ?nosms=1 не считается, без флага — считается', async () => {
    const s = makeService();
    for (let i = 0; i < 5; i++) {
      expect(await s.service.requestSmsCode('79656445804', null, null, { suppressSms: true })).toEqual({ status: 'sent' });
      await burn(s.redis, '79656445804');
    }
    expect(s.redis.limitKeys()).toEqual([]);

    expect(await requestAndBurn(s, '79656445804')).toEqual({ status: 'sent' });
    expect(s.redis.peek('sms-lim:phone:79656445804:h')).toBe('1');
  });

  it('путь «код уже выслан» не считается', async () => {
    const s = makeService();
    expect(await s.service.requestSmsCode(RU(10))).toEqual({ status: 'sent' });
    for (let i = 0; i < 5; i++) expect(await s.service.requestSmsCode(RU(10))).toEqual({ status: 'exists' });
    expect(s.redis.peek(`sms-lim:phone:${RU(10)}:h`)).toBe('1');
    expect(s.redis.peek('sms-lim:global:h')).toBe('1');
    expect(s.sent).toEqual([RU(10)]);
  });
});

describe('отказ по лимиту', () => {
  it('код не записан, SMS не ушла, otp_request нет', async () => {
    const s = makeService();
    await requestAndBurn(s, RU(11));
    s.tracked.length = 0;

    s.redis.advance(10);
    expect((await s.service.requestSmsCode(RU(11))).status).toBe('rate_limited');
    expect(s.redis.peek(smsCodeKey(RU(11)))).toBeNull();
    expect(s.sent).toEqual([RU(11)]);
    expect(s.tracked.map(([n]) => n)).toEqual(['sms_limit_hit']);
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

  it('счётчик, оставшийся без срока (EXPIRE не дошёл), получает срок со следующим ударом', async () => {
    const s = makeService();
    await s.redis.set('sms-lim:global:d', '7'); // без TTL
    expect(await requestAndBurn(s, RU(15))).toEqual({ status: 'sent' });
    expect(await s.redis.ttl('sms-lim:global:d')).toBe(86400);
  });
});
