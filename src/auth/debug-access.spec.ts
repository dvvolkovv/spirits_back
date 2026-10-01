import { AuthController } from './auth.controller';
import { isDebugConfigured, isDebugRequestAllowed, isTestEmail } from './debug-access';

/**
 * Замок на debug-ручках (/webhook/debug/*). Ручки нужны смоуку и e2e на живых
 * средах; доступ только по секрету из .env сервера. Здесь проверяется, что
 * замок закрыт во всех случаях, кроме одного — флаг, пригодный секрет и
 * совпавший заголовок.
 */

const SECRET = 'a'.repeat(31) + 'b'.repeat(33); // 64 знака, как openssl rand -hex 32
const ON = { DEBUG_SMS_CODES: 'true', DEBUG_SECRET: SECRET };

describe('isDebugRequestAllowed', () => {
  it('без флага DEBUG_SMS_CODES — закрыто, даже с верным заголовком', () => {
    expect(isDebugRequestAllowed(SECRET, { DEBUG_SECRET: SECRET })).toBe(false);
    expect(isDebugRequestAllowed(SECRET, { DEBUG_SMS_CODES: 'false', DEBUG_SECRET: SECRET })).toBe(false);
  });

  it('флаг есть, секрета нет — закрыто (fail closed), в том числе пустой заголовок', () => {
    expect(isDebugRequestAllowed('', { DEBUG_SMS_CODES: 'true' })).toBe(false);
    expect(isDebugRequestAllowed(undefined, { DEBUG_SMS_CODES: 'true' })).toBe(false);
    expect(isDebugRequestAllowed('', { DEBUG_SMS_CODES: 'true', DEBUG_SECRET: '' })).toBe(false);
  });

  it('секрет короче 32 знаков — закрыто, даже если заголовок совпал', () => {
    const short = 'x'.repeat(31);
    expect(isDebugRequestAllowed(short, { DEBUG_SMS_CODES: 'true', DEBUG_SECRET: short })).toBe(false);
  });

  it('неверный заголовок той же длины — закрыто', () => {
    expect(isDebugRequestAllowed('c'.repeat(SECRET.length), ON)).toBe(false);
  });

  it('заголовок другой длины не роняет timingSafeEqual, а просто закрыто', () => {
    expect(() => isDebugRequestAllowed('short', ON)).not.toThrow();
    expect(isDebugRequestAllowed('short', ON)).toBe(false);
    expect(isDebugRequestAllowed(SECRET + 'x', ON)).toBe(false);
    // Многобайтовые символы: длина строки та же, длина буфера — нет.
    expect(() => isDebugRequestAllowed('я'.repeat(SECRET.length), ON)).not.toThrow();
    expect(isDebugRequestAllowed('я'.repeat(SECRET.length), ON)).toBe(false);
  });

  it('не строка (повтор заголовка, отсутствие) — закрыто', () => {
    expect(isDebugRequestAllowed([SECRET, SECRET], ON)).toBe(false);
    expect(isDebugRequestAllowed(undefined, ON)).toBe(false);
  });

  it('флаг, секрет и верный заголовок — открыто', () => {
    expect(isDebugRequestAllowed(SECRET, ON)).toBe(true);
  });

  it('isDebugConfigured отражает только флаг и пригодность секрета', () => {
    expect(isDebugConfigured(ON)).toBe(true);
    expect(isDebugConfigured({ DEBUG_SMS_CODES: 'true' })).toBe(false);
    expect(isDebugConfigured({ DEBUG_SECRET: SECRET })).toBe(false);
  });
});

describe('isTestEmail', () => {
  it.each([
    'e2e-test-1727700000000@example.com',
    'claude.itest@linkeon.io',
    'claude.link+1727700000000@linkeon.io',
  ])('пускает тестовый адрес %s', (email) => {
    expect(isTestEmail(email)).toBe(true);
  });

  it.each([
    'someone@gmail.com',
    'support@linkeon.io',
    'claude@linkeon.io',
    'claude.itest@linkeon.io.evil.com',
    'x@example.com.evil.com',
    'x@sub.example.com',
    'a@b@example.com',
  ])('не пускает %s', (email) => {
    expect(isTestEmail(email)).toBe(false);
  });
});

// ── Контроллер: замок стоит на всех трёх ручках ───────────────────────────

function fakeRes() {
  const out: any = {};
  return {
    out,
    set() { return this; },
    status(code: number) { out.code = code; return this; },
    json(body: any) { out.body = body; return this; },
  };
}

const req = (headers: Record<string, string> = {}) => ({ headers }) as any;
const withSecret = (value: string = SECRET) => req({ 'x-debug-secret': value });

const unused = {} as any;

function makeController() {
  const calls: any[] = [];
  const authService = {
    async getDebugCode(phone: string) { calls.push(['getDebugCode', phone]); return '123456'; },
    async debugAddTokens(phone: string, delta: number) {
      calls.push(['debugAddTokens', phone, delta]);
      return { phone, balance_before: 0, balance_after: delta };
    },
  };
  const redis = {
    async keys() { calls.push(['keys']); return ['ml-rate-x', 'ml-TOKEN']; },
    async get(key: string) { return key === 'ml-TOKEN' ? 'claude.itest@linkeon.io' : null; },
  };
  const controller = new AuthController(
    authService as any,
    unused, // email
    unused, // identity
    unused, // jwt
    redis as any,
    unused, // googleOAuth
    unused, // yandexOAuth
    unused, // appleOAuth
    unused, // devices
    unused, // pg
  );
  return { controller, calls };
}

describe('debug-ручки AuthController', () => {
  const saved = { flag: process.env.DEBUG_SMS_CODES, secret: process.env.DEBUG_SECRET };

  function setEnv(flag?: string, secret?: string) {
    if (flag === undefined) delete process.env.DEBUG_SMS_CODES; else process.env.DEBUG_SMS_CODES = flag;
    if (secret === undefined) delete process.env.DEBUG_SECRET; else process.env.DEBUG_SECRET = secret;
  }

  afterEach(() => setEnv(saved.flag, saved.secret));

  // Каждая ручка вызывается одинаково: (request, response) с её параметрами.
  const routes: Array<[string, (c: AuthController, r: any, res: any) => Promise<any>]> = [
    ['sms-code', (c, r, res) => c.debugSmsCode('79030169187', r, res)],
    ['email-token', (c, r, res) => c.debugEmailToken('claude.itest@linkeon.io', r, res)],
    ['add-tokens', (c, r, res) => c.debugAddTokens('70000000000', '100', r, res)],
  ];

  describe.each(routes)('%s', (_name, call) => {
    it('нет флага → 404, сервис не тронут', async () => {
      setEnv(undefined, SECRET);
      const { controller, calls } = makeController();
      const res = fakeRes();
      await call(controller, withSecret(), res);
      expect(res.out.code).toBe(404);
      expect(res.out.body).toEqual({ error: 'Not found' });
      expect(calls).toEqual([]);
    });

    it('флаг есть, секрета нет → 404', async () => {
      setEnv('true', undefined);
      const { controller, calls } = makeController();
      const res = fakeRes();
      await call(controller, req(), res);
      expect(res.out.code).toBe(404);
      expect(calls).toEqual([]);
    });

    it('без заголовка → 404', async () => {
      setEnv('true', SECRET);
      const { controller, calls } = makeController();
      const res = fakeRes();
      await call(controller, req(), res);
      expect(res.out.code).toBe(404);
      expect(calls).toEqual([]);
    });

    it('неверный заголовок → 404', async () => {
      setEnv('true', SECRET);
      const { controller, calls } = makeController();
      const res = fakeRes();
      await call(controller, withSecret('c'.repeat(SECRET.length)), res);
      expect(res.out.code).toBe(404);
      expect(calls).toEqual([]);
    });

    it('заголовок другой длины → 404, без исключения', async () => {
      setEnv('true', SECRET);
      const { controller, calls } = makeController();
      const res = fakeRes();
      await call(controller, withSecret('short'), res); // бросок здесь — красный тест
      expect(res.out.code).toBe(404);
      expect(calls).toEqual([]);
    });

    it('верный заголовок → 200', async () => {
      setEnv('true', SECRET);
      const { controller, calls } = makeController();
      const res = fakeRes();
      await call(controller, withSecret(), res);
      expect(res.out.code).toBe(200);
      expect(calls.length).toBeGreaterThan(0);
    });
  });

  it('sms-code с верным секретом отдаёт код', async () => {
    setEnv('true', SECRET);
    const { controller } = makeController();
    const res = fakeRes();
    await controller.debugSmsCode('70000000000', withSecret(), res as any);
    expect(res.out.body).toEqual({ code: '123456' });
  });

  it('sms-code: номер вне белого списка → 403 даже с секретом', async () => {
    setEnv('true', SECRET);
    const { controller, calls } = makeController();
    const res = fakeRes();
    await controller.debugSmsCode('79991234567', withSecret(), res as any);
    expect(res.out.code).toBe(403);
    expect(calls).toEqual([]);
  });

  it('email-token: нетестовая почта → 403 даже с секретом, Redis не сканируется', async () => {
    setEnv('true', SECRET);
    const { controller, calls } = makeController();
    const res = fakeRes();
    await controller.debugEmailToken('someone@gmail.com', withSecret(), res as any);
    expect(res.out.code).toBe(403);
    expect(calls).toEqual([]);
  });

  it('email-token: тестовая почта с верным секретом отдаёт токен', async () => {
    setEnv('true', SECRET);
    const { controller } = makeController();
    const res = fakeRes();
    await controller.debugEmailToken('  Claude.Itest@linkeon.io ', withSecret(), res as any);
    expect(res.out.body).toEqual({ token: 'TOKEN', email: 'claude.itest@linkeon.io' });
  });

  // Замок стоит раньше белого списка: без секрета ответ один и тот же (404)
  // для любого номера и любой почты — по 403 нельзя понять, кто в списке.
  it.each([
    ['sms-code', (c: AuthController, r: any, res: any) => c.debugSmsCode('79991234567', r, res)],
    ['email-token', (c: AuthController, r: any, res: any) => c.debugEmailToken('someone@gmail.com', r, res)],
    ['add-tokens', (c: AuthController, r: any, res: any) => c.debugAddTokens('79991234567', '100', r, res)],
  ])('%s: вне белого списка и без заголовка → 404, а не 403', async (_name, call) => {
    setEnv('true', SECRET);
    const { controller, calls } = makeController();
    const res = fakeRes();
    await call(controller, req(), res);
    expect(res.out.code).toBe(404);
    expect(res.out.body).toEqual({ error: 'Not found' });
    expect(calls).toEqual([]);
  });

  it('add-tokens: номер вне белого списка → 403 даже с секретом', async () => {
    setEnv('true', SECRET);
    const { controller, calls } = makeController();
    const res = fakeRes();
    await controller.debugAddTokens('79991234567', '100', withSecret(), res as any);
    expect(res.out.code).toBe(403);
    expect(calls).toEqual([]);
  });
});
