import { AuthController, TOO_MANY_ATTEMPTS_ERROR } from './auth.controller';
import { AuthService } from './auth.service';
import { SMS_CODE_MAX_ATTEMPTS, SMS_CODE_TTL_SECONDS, smsAttemptsKey, smsCodeKey } from './sms-code';

/**
 * Лимит попыток кода из SMS: вход (check-code) и привязка телефона
 * (auth/identities/link/phone). Redis — в памяти, с той же семантикой
 * get/set/del/incr/expire, что у RedisService.
 */

const PHONE = '70000000000';
const CODE = '123456';
const WRONG = '000000';

function fakeRedis() {
  const data = new Map<string, string>();
  const ttl = new Map<string, number>();
  return {
    data,
    ttl,
    async get(key: string) { return data.has(key) ? data.get(key)! : null; },
    async set(key: string, value: string, ttlSeconds?: number) {
      data.set(key, value);
      if (ttlSeconds) ttl.set(key, ttlSeconds); else ttl.delete(key);
    },
    async del(key: string) { data.delete(key); ttl.delete(key); },
    async incr(key: string) {
      const n = Number(data.get(key) ?? '0') + 1;
      data.set(key, String(n));
      return n;
    },
    async expire(key: string, seconds: number) { if (data.has(key)) ttl.set(key, seconds); },
  };
}

function makeService() {
  const redis = fakeRedis();
  const identity = {
    calls: 0,
    async resolveOrCreate() { identity.calls++; return { status: 'ok', userId: PHONE, isNew: false }; },
  };
  const jwt = { signAccess: (u: string) => `A-${u}`, signRefresh: (u: string) => `R-${u}` };
  const pg = { async query() { return { rows: [] }; } };
  const service = new AuthService(pg as any, redis as any, jwt as any, identity as any);
  return { service, redis, identity };
}

const savedFlag = process.env.DEBUG_SMS_CODES;
beforeAll(() => { process.env.DEBUG_SMS_CODES = 'true'; }); // 70000000000 — без реальной SMS
afterAll(() => {
  if (savedFlag === undefined) delete process.env.DEBUG_SMS_CODES; else process.env.DEBUG_SMS_CODES = savedFlag;
});

describe('AuthService.checkCode — лимит попыток', () => {
  it('верный код с первой попытки: вход, код и счётчик погашены', async () => {
    const { service, redis, identity } = makeService();
    await redis.set(smsCodeKey(PHONE), CODE, SMS_CODE_TTL_SECONDS);

    const r = await service.checkCode(PHONE, CODE);

    expect(r.status).toBe('ok');
    expect((r as any).tokens['access-token']).toBe(`A-${PHONE}`);
    expect(identity.calls).toBe(1);
    expect(redis.data.has(smsCodeKey(PHONE))).toBe(false);
    expect(redis.data.has(smsAttemptsKey(PHONE))).toBe(false);
  });

  it('неверные попытки до лимита, затем верная — вход, счётчик погашен', async () => {
    const { service, redis } = makeService();
    await redis.set(smsCodeKey(PHONE), CODE, SMS_CODE_TTL_SECONDS);

    for (let i = 1; i < SMS_CODE_MAX_ATTEMPTS; i++) {
      expect((await service.checkCode(PHONE, WRONG)).status).toBe('invalid');
    }
    expect(redis.data.get(smsAttemptsKey(PHONE))).toBe(String(SMS_CODE_MAX_ATTEMPTS - 1));
    expect(redis.ttl.get(smsAttemptsKey(PHONE))).toBe(SMS_CODE_TTL_SECONDS);

    expect((await service.checkCode(PHONE, CODE)).status).toBe('ok');
    expect(redis.data.has(smsAttemptsKey(PHONE))).toBe(false);
  });

  it('5 неверных — код погашен; 6-я попытка с ВЕРНЫМ кодом не проходит', async () => {
    const { service, redis, identity } = makeService();
    await redis.set(smsCodeKey(PHONE), CODE, SMS_CODE_TTL_SECONDS);

    const statuses: string[] = [];
    for (let i = 0; i < SMS_CODE_MAX_ATTEMPTS; i++) statuses.push((await service.checkCode(PHONE, WRONG)).status);
    expect(SMS_CODE_MAX_ATTEMPTS).toBe(5);
    expect(statuses).toEqual(['invalid', 'invalid', 'invalid', 'invalid', 'too_many_attempts']);
    expect(redis.data.has(smsCodeKey(PHONE))).toBe(false);
    expect(redis.data.has(smsAttemptsKey(PHONE))).toBe(false);

    expect((await service.checkCode(PHONE, CODE)).status).not.toBe('ok');
    expect(identity.calls).toBe(0);
  });

  it('новый запрос SMS после погашения выдаёт новый код со свежим счётчиком', async () => {
    const { service, redis } = makeService();
    await redis.set(smsCodeKey(PHONE), CODE, SMS_CODE_TTL_SECONDS);
    for (let i = 0; i < SMS_CODE_MAX_ATTEMPTS; i++) await service.checkCode(PHONE, WRONG);
    expect(redis.data.has(smsCodeKey(PHONE))).toBe(false);

    expect((await service.requestSmsCode(PHONE)).status).toBe('sent');
    const fresh = redis.data.get(smsCodeKey(PHONE));
    expect(fresh).toMatch(/^\d{6}$/);
    expect(redis.ttl.get(smsCodeKey(PHONE))).toBe(SMS_CODE_TTL_SECONDS);
    expect(redis.data.has(smsAttemptsKey(PHONE))).toBe(false);

    // Свежему коду снова доступны все попытки.
    for (let i = 1; i < SMS_CODE_MAX_ATTEMPTS; i++) {
      expect((await service.checkCode(PHONE, fresh === WRONG ? '111111' : WRONG)).status).toBe('invalid');
    }
    expect((await service.checkCode(PHONE, fresh!)).status).toBe('ok');
  });

  it('новый код обнуляет счётчик, оставшийся от прежнего', async () => {
    const { service, redis } = makeService();
    await redis.set(smsAttemptsKey(PHONE), '4', SMS_CODE_TTL_SECONDS); // код истёк, счётчик пережил его
    expect((await service.requestSmsCode(PHONE)).status).toBe('sent');
    expect(redis.data.has(smsAttemptsKey(PHONE))).toBe(false);
  });

  it('повторный запрос SMS при живом коде код не меняет и счётчик не трогает', async () => {
    const { service, redis } = makeService();
    await redis.set(smsCodeKey(PHONE), CODE, SMS_CODE_TTL_SECONDS);
    await service.checkCode(PHONE, WRONG);
    expect((await service.requestSmsCode(PHONE)).status).toBe('exists');
    expect(redis.data.get(smsCodeKey(PHONE))).toBe(CODE);
    expect(redis.data.get(smsAttemptsKey(PHONE))).toBe('1');
  });

  it('кода нет — отказ без счётчика', async () => {
    const { service, redis } = makeService();
    expect((await service.checkCode(PHONE, CODE)).status).toBe('invalid');
    expect(redis.data.has(smsAttemptsKey(PHONE))).toBe(false);
  });

  it('пачка параллельных попыток: сравниваются только первые пять', async () => {
    const { service, redis, identity } = makeService();
    await redis.set(smsCodeKey(PHONE), CODE, SMS_CODE_TTL_SECONDS);

    // Двадцать запросов разом, верный код — десятым: до сравнения он дойти не должен.
    const guesses = Array.from({ length: 20 }, (_, i) => (i === 9 ? CODE : String(100000 + i)));
    const results = await Promise.all(guesses.map((g) => service.checkCode(PHONE, g)));

    expect(results.filter((r) => r.status === 'ok')).toHaveLength(0);
    expect(results[9].status).toBe('too_many_attempts');
    expect(identity.calls).toBe(0);
    expect(redis.data.has(smsCodeKey(PHONE))).toBe(false);
  });
});

// ── Контроллер: что видит клиент ──────────────────────────────────────────

function fakeRes() {
  const out: any = {};
  return {
    out,
    set() { return this; },
    status(code: number) { out.code = code; return this; },
    json(body: any) { out.body = body; return this; },
  };
}

const unused = {} as any;

function makeController() {
  const { service, redis, identity } = makeService();
  const links: any[] = [];
  const identityCtl = {
    async linkMethod(userId: string, provider: string, data: any) { links.push([userId, provider, data]); return { ok: true }; },
  };
  const devices = { async record() {} };
  const controller = new AuthController(
    service,
    unused, // email
    identityCtl as any,
    unused, // jwt
    redis as any,
    unused, // googleOAuth
    unused, // yandexOAuth
    unused, // appleOAuth
    devices as any,
    unused, // pg
  );
  return { controller, redis, identity, links };
}

const checkCode = (c: AuthController, code: string, res: any) =>
  c.checkCode(PHONE, code, undefined as any, undefined as any, { headers: {} } as any, res);

const linkPhone = (c: AuthController, code: string, res: any) =>
  c.linkPhone({ phone: `+${PHONE}`, code }, { user: { userId: 'u1' } }, res);

describe('check-code: ответ клиенту', () => {
  it('неверный код — прежний 401 «Invalid or expired code»', async () => {
    const { controller, redis } = makeController();
    await redis.set(smsCodeKey(PHONE), CODE, SMS_CODE_TTL_SECONDS);
    const res = fakeRes();
    await checkCode(controller, WRONG, res);
    expect(res.out).toEqual({ code: 401, body: { error: 'Invalid or expired code' } });
  });

  it('лимит исчерпан — тот же 401, отличимый текст с «Code not found»; дальше верный код не пускает', async () => {
    const { controller, redis, identity } = makeController();
    await redis.set(smsCodeKey(PHONE), CODE, SMS_CODE_TTL_SECONDS);

    let res = fakeRes();
    for (let i = 0; i < SMS_CODE_MAX_ATTEMPTS; i++) { res = fakeRes(); await checkCode(controller, WRONG, res); }
    expect(res.out.code).toBe(401);
    expect(res.out.body).toEqual({ error: TOO_MANY_ATTEMPTS_ERROR, reason: 'too_many_attempts' });
    // По этой подстроке веб-клиент говорит «Код не найден. Запросите новый код».
    expect(res.out.body.error).toContain('Code not found');

    const sixth = fakeRes();
    await checkCode(controller, CODE, sixth);
    expect(sixth.out.code).toBe(401);
    expect(identity.calls).toBe(0);
  });

  it('верный код — 200 с прежней формой тела', async () => {
    const { controller, redis } = makeController();
    await redis.set(smsCodeKey(PHONE), CODE, SMS_CODE_TTL_SECONDS);
    const res = fakeRes();
    await checkCode(controller, CODE, res);
    expect(res.out.code).toBe(200);
    expect(Object.keys(res.out.body).sort()).toEqual(['access-token', 'is-new-user', 'refresh-token']);
  });
});

/**
 * Как привязку зовут клиенты: веб (apiClient) и мобилка (ApiClient) на 401
 * обновляют access-токен и повторяют тот же запрос с тем же кодом.
 */
async function linkPhoneAsClient(c: AuthController, code: string) {
  let res = fakeRes();
  await linkPhone(c, code, res);
  if (res.out.code === 401) {
    res = fakeRes();
    await linkPhone(c, code, res);
  }
  return res;
}

describe('привязка телефона: тот же лимит', () => {
  it('неверный код — 400, и попытка тратится одна, а не две', async () => {
    // На 401 клиент принял бы отказ за протухший токен и повторил запрос:
    // каждый неверный ввод съедал бы две попытки из пяти.
    const { controller, redis } = makeController();
    await redis.set(smsCodeKey(PHONE), CODE, SMS_CODE_TTL_SECONDS);

    const res = await linkPhoneAsClient(controller, WRONG);

    expect(redis.data.get(smsAttemptsKey(PHONE))).toBe('1');
    expect(res.out).toEqual({ code: 400, body: { error: 'invalid code' } });
  });

  it('5 неверных — код погашен, 6-я с верным кодом не привязывает', async () => {
    const { controller, redis, links } = makeController();
    await redis.set(smsCodeKey(PHONE), CODE, SMS_CODE_TTL_SECONDS);

    const bodies: any[] = [];
    for (let i = 0; i < SMS_CODE_MAX_ATTEMPTS; i++) {
      const res = await linkPhoneAsClient(controller, WRONG);
      expect(res.out.code).toBe(400);
      bodies.push(res.out.body.error);
    }
    expect(bodies).toEqual(['invalid code', 'invalid code', 'invalid code', 'invalid code', 'too many attempts']);
    expect(redis.data.has(smsCodeKey(PHONE))).toBe(false);

    const sixth = fakeRes();
    await linkPhone(controller, CODE, sixth);
    expect(sixth.out.code).toBe(400);
    expect(links).toEqual([]);
  });

  it('счётчик общий со входом: неверные попытки входа съедают попытки привязки', async () => {
    const { controller, redis, links } = makeController();
    await redis.set(smsCodeKey(PHONE), CODE, SMS_CODE_TTL_SECONDS);
    for (let i = 0; i < SMS_CODE_MAX_ATTEMPTS; i++) await checkCode(controller, WRONG, fakeRes());
    const res = fakeRes();
    await linkPhone(controller, CODE, res);
    expect(res.out.code).toBe(400);
    expect(links).toEqual([]);
  });

  it('верный код — привязка, код и счётчик погашены', async () => {
    const { controller, redis, links } = makeController();
    await redis.set(smsCodeKey(PHONE), CODE, SMS_CODE_TTL_SECONDS);
    await linkPhone(controller, WRONG, fakeRes());
    const res = fakeRes();
    await linkPhone(controller, CODE, res);
    expect(res.out).toEqual({ code: 200, body: { ok: true } });
    expect(links).toEqual([['u1', 'phone', { phone: PHONE }]]);
    expect(redis.data.has(smsCodeKey(PHONE))).toBe(false);
    expect(redis.data.has(smsAttemptsKey(PHONE))).toBe(false);
  });
});
