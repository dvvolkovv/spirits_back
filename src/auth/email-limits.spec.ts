import { AuthController } from './auth.controller';
import { EmailService, MAGIC_LINK_LIMIT_DEFAULTS, MAGIC_LINK_LIMIT_ENV, mailboxKey } from './email.service';
import { clockRedis, FakeRedis } from './fake-redis.forspec';
import { sendTelegramAlert } from '../common/telegram-alert';

jest.mock('../common/telegram-alert', () => ({ sendTelegramAlert: jest.fn(async () => undefined) }));
const alerts = jest.mocked(sendTelegramAlert);

/**
 * Лимит писем со ссылкой входа (POST /auth/email/request).
 *
 * Прежний второй счётчик шёл по первому адресу из X-Forwarded-For, а на проде
 * там у всех 127.0.0.1: «10 писем за 10 минут» было общим потолком на весь
 * вход по почте. Теперь — по ящику и общий потолок повыше. Redis — в памяти
 * со своими часами (fake-redis.forspec.ts), SMTP подменён.
 */

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
  };
}

function makeEmail(redis: FakeRedis = clockRedis()) {
  const email = new EmailService(redis as any, undefined);
  const mailed: string[] = [];
  jest.spyOn(email, 'sendMagicLink').mockImplementation(async (to: string) => { mailed.push(to); });
  const logs = { warn: [] as string[], error: [] as string[] };
  const logger = (email as any).logger;
  jest.spyOn(logger, 'warn').mockImplementation((m: unknown) => { logs.warn.push(String(m)); });
  jest.spyOn(logger, 'error').mockImplementation((m: unknown) => { logs.error.push(String(m)); });
  const unused = {} as any;
  const controller = new AuthController(unused, email, unused, unused, redis as any, unused, unused, unused, unused, unused);
  const ask = async (address: string) => {
    const res = fakeRes();
    await controller.emailRequest({ email: address }, res as any);
    return res.out;
  };
  return { email, redis, mailed, logs, ask };
}

/** Счётчики писем — без отметки «об этом уже сообщили». */
const counters = (redis: FakeRedis) =>
  new Map([...redis.snapshot('ml-rate-')].filter(([k]) => !k.startsWith('ml-rate-alerted:')));

/** Выданные ссылки входа: ml-<token>, не ключи счёта. */
const tokens = (redis: FakeRedis) => [...redis.snapshot('ml-').keys()].filter((k) => !k.startsWith('ml-rate-'));

const SENT = { code: 200, body: { sent: true }, headers: expect.objectContaining({ 'Access-Control-Allow-Origin': '*' }) };

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = Object.values(MAGIC_LINK_LIMIT_ENV);
beforeAll(() => { for (const k of ENV_KEYS) savedEnv[k] = process.env[k]; });
beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  alerts.mockClear();
});
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
});

describe('mailboxKey: синонимы адреса — один ящик', () => {
  it('метка после «+», регистр, точки Gmail, googlemail.com, синонимы Яндекса', () => {
    expect(mailboxKey(' Ivan.Petrov+promo@GMAIL.com ')).toBe('ivanpetrov@gmail.com');
    expect(mailboxKey('ivanpetrov@googlemail.com')).toBe('ivanpetrov@gmail.com');
    expect(mailboxKey('ivan.ivanov@ya.ru')).toBe('ivan-ivanov@yandex.ru');
    expect(mailboxKey('ivan-ivanov+x@yandex.com')).toBe('ivan-ivanov@yandex.ru');
    expect(mailboxKey('anna.k+news@mail.ru')).toBe('anna.k@mail.ru'); // у mail.ru точки значимы
  });
});

describe('письмо со ссылкой входа: лимит на ящик', () => {
  it('не чаще раза в минуту — 429 с прежним телом, сроком и Retry-After', async () => {
    const m = makeEmail();
    expect(await m.ask('a@example.com')).toEqual(SENT);
    m.redis.advance(20);
    const out = await m.ask('a@example.com');
    expect(out.code).toBe(429);
    // Веб разбирает error === 'rate_limit', мобилка — статус 429.
    expect(out.body).toEqual({ error: 'rate_limit', reason: 'per_email', retryAfterSec: 40 });
    expect(out.headers['Retry-After']).toBe('40');
    expect(m.mailed).toEqual(['a@example.com']);
  });

  it('не больше 3 за 10 минут', async () => {
    const m = makeEmail();
    for (const t of [0, 60, 60]) {
      m.redis.advance(t);
      expect(await m.ask('a@example.com')).toEqual(SENT);
    }
    m.redis.advance(60); // t = 180
    expect((await m.ask('a@example.com')).body).toEqual({ error: 'rate_limit', reason: 'per_email', retryAfterSec: 600 - 180 });
    m.redis.advance(600 - 180);
    expect(await m.ask('a@example.com')).toEqual(SENT);
    expect(m.mailed).toHaveLength(4);
  });

  it('синонимы одного ящика считаются вместе', async () => {
    const m = makeEmail();
    for (const address of ['Ivan.Petrov+promo@gmail.com', 'ivanpetrov@googlemail.com', 'ivan.petrov+x@gmail.com']) {
      expect(await m.ask(address)).toEqual(SENT);
      m.redis.advance(60);
    }
    expect((await m.ask('ivanpetrov@gmail.com')).code).toBe(429);

    expect(await m.ask('ivan.ivanov@ya.ru')).toEqual(SENT);
    expect((await m.ask('ivan-ivanov@yandex.ru')).code).toBe(429); // та же минута, тот же ящик
  });

  it('разные ящики друг другу не мешают', async () => {
    const m = makeEmail();
    expect(await m.ask('a@example.com')).toEqual(SENT);
    expect(await m.ask('b@example.com')).toEqual(SENT);
  });

  it('отказ ничего не считает', async () => {
    const m = makeEmail();
    await m.ask('a@example.com');
    const before = counters(m.redis);
    for (let i = 0; i < 5; i++) expect((await m.ask('a@example.com')).code).toBe(429);
    expect(counters(m.redis)).toEqual(before);
  });
});

describe('письмо со ссылкой входа: общий потолок', () => {
  it('адрес клиента больше не участвует: 11-й адрес за 10 минут проходит (раньше — 429 на всех)', async () => {
    const m = makeEmail();
    for (let i = 0; i < 11; i++) expect(await m.ask(`user${i}@example.com`)).toEqual(SENT);
    // Считать письма, а не ответы: подавленный ответ неотличим от успеха.
    expect(m.mailed).toHaveLength(11);
    expect([...m.redis.snapshot('ml-rate-ip').keys()]).toEqual([]);
  });

  it('60 за 10 минут — дальше ответ как при успехе, но без письма и без ссылки', async () => {
    const m = makeEmail();
    for (let i = 0; i < 60; i++) expect(await m.ask(`user${i}@example.com`)).toEqual(SENT);
    expect(tokens(m.redis)).toHaveLength(60);

    const before = counters(m.redis);
    for (let i = 60; i < 65; i++) expect(await m.ask(`user${i}@example.com`)).toEqual(SENT);
    expect(m.mailed).toHaveLength(60);
    expect(tokens(m.redis)).toHaveLength(60);
    expect(counters(m.redis)).toEqual(before);
  });

  it('о закрытом потолке — один алерт и один error на окно, без адресов', async () => {
    const m = makeEmail();
    for (let i = 0; i < 60; i++) await m.ask(`user${i}@example.com`);
    m.redis.advance(120);
    for (let i = 60; i < 70; i++) await m.ask(`user${i}@example.com`);

    expect(alerts).toHaveBeenCalledTimes(1);
    expect(m.logs.error).toHaveLength(1);
    expect(alerts.mock.calls[0][0] + m.logs.error[0]).not.toMatch(/@/);
    expect(await m.redis.ttl('ml-rate-alerted:global:10m')).toBe(600 - 120);

    m.redis.advance(600); // следующее окно
    for (let i = 70; i < 131; i++) await m.ask(`user${i}@example.com`);
    expect(alerts).toHaveBeenCalledTimes(2);
  });

  it('свой лимит ящика старше общего: 429, а не «успех»', async () => {
    process.env.EMAIL_LIMIT_GLOBAL_10MIN = '2';
    const m = makeEmail();
    expect(await m.ask('a@example.com')).toEqual(SENT);
    expect(await m.ask('b@example.com')).toEqual(SENT); // общий потолок закрыт
    expect((await m.ask('a@example.com')).code).toBe(429);
    expect(await m.ask('c@example.com')).toEqual(SENT); // подавлено
    expect(m.mailed).toEqual(['a@example.com', 'b@example.com']);
  });

  it('пороги — по умолчанию 3 и 60, поднимаются через EMAIL_LIMIT_*', async () => {
    expect(MAGIC_LINK_LIMIT_DEFAULTS).toEqual({ perAddress: 3, global: 60 });
    process.env.EMAIL_LIMIT_PER_ADDRESS_10MIN = '5';
    const m = makeEmail();
    for (let i = 0; i < 5; i++) {
      expect(await m.ask('a@example.com')).toEqual(SENT);
      m.redis.advance(60);
    }
    expect((await m.ask('a@example.com')).code).toBe(429);
  });
});

describe('письмо со ссылкой входа: проверки до квоты', () => {
  it('неверный адрес и временная почта — 400, квота не тронута', async () => {
    const m = makeEmail();
    expect((await m.ask('not-an-email')).code).toBe(400);
    jest.spyOn(m.email, 'isTempmail').mockReturnValue(true);
    expect((await m.ask('x@10minutemail.com')).body.error).toBe('tempmail_blocked');
    expect(counters(m.redis)).toEqual(new Map());
  });
});
