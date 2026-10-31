// src/guest-trial/guest-trial.controller.spec.ts
import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { GuestTrialController } from './guest-trial.controller';
import { JwtGuard } from '../common/guards/jwt.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { DEFAULT_GUEST_LIMITS } from './guest-trial.types';
import { hashGuestToken, newGuestToken } from './guest-token';

const ADMIN_USER = { userId: 'admin-1' };

function makeRes() {
  const res: any = {
    statusCode: 0,
    body: undefined,
    headers: {} as Record<string, string>,
    status(c: number) { this.statusCode = c; return this; },
    json(b: any) { this.body = b; return this; },
    setHeader(k: string, v: string) { this.headers[k] = v; return this; },
  };
  return res;
}

/** @Req() в тестах контроллера не ходит через Nest — просто объект с headers. */
function makeReq(origin?: string): any {
  return { headers: origin === undefined ? {} : { origin } };
}

function harness() {
  const turns = { handle: jest.fn(async () => {}) };
  const claims = { claim: jest.fn(async () => ({ status: 200, body: { assistantId: '12', moved: 4 } })) };
  const store = {
    settings: jest.fn(async () => ({ mode: 'on', limits: DEFAULT_GUEST_LIMITS })),
    setMode: jest.fn(async () => {}),
    setLimits: jest.fn(async () => ({ limits: DEFAULT_GUEST_LIMITS, ignored: [], changed: true })),
  };
  const sessions = {
    findLive: jest.fn(async (): Promise<any> => null),
    messages: jest.fn(async () => [{ sender_type: 'human', content: 'В' }, { sender_type: 'ai', content: 'О' }]),
    status: jest.fn(async () => ({ trials_day: 1 })),
  };
  const redis = { get: jest.fn(async () => '5') };
  const c = new GuestTrialController(turns as any, claims as any, store as any, sessions as any, redis as any);
  return { c, turns, claims, store, sessions, redis };
}

describe('ручки пробы', () => {
  it('config без Origin — 200, режим и два числа, без остальных лимитов', async () => {
    const h = harness();
    const res = makeRes();
    await h.c.config(makeReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ mode: 'on', answersPerTrial: 3, maxChars: 2000 });
  });

  it('session: кривой ключ — 404 без похода в базу; найденная — роли и остаток', async () => {
    const h = harness();
    let res = makeRes();
    await h.c.session(makeReq(), { token: 'x' }, res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'trial' });
    expect(h.sessions.findLive).not.toHaveBeenCalled();

    const token = newGuestToken();
    h.sessions.findLive.mockImplementation(async (hash: string) =>
      hash === hashGuestToken(token) ? { id: 's1', assistant_id: 14, answers: 1, claimed_at: null } : null);
    res = makeRes();
    await h.c.session(makeReq(), { token }, res);
    expect(res.body).toEqual({ assistantId: '14', messages: [{ role: 'user', content: 'В' }, { role: 'assistant', content: 'О' }], left: 2 });
  });

  // Ревью A10: оба 404 пробы (кривой ключ выше, перенесённая проба здесь) должны
  // отдавать одинаковое тело — иначе форма ответа молча отличает «нет такой пробы»
  // от «эта проба чужая/перенесена», раскрывая больше, чем нужно анониму.
  it('session: перенесённая — 404, то же тело, что и у кривого ключа', async () => {
    const h = harness();
    h.sessions.findLive.mockImplementation(async () => ({ id: 's1', assistant_id: 14, answers: 1, claimed_at: new Date() }));
    const res = makeRes();
    await h.c.session(makeReq(), { token: newGuestToken() }, res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'trial' });
  });

  it('claim — userId из JWT, ответ как есть', async () => {
    const h = harness();
    const res = makeRes();
    await h.c.claim({ userId: 'u1' }, { token: 'T' }, res);
    expect(h.claims.claim).toHaveBeenCalledWith('u1', 'T');
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ assistantId: '12', moved: 4 });
  });

  it('админ: режимы логируются с userId, статус, незнакомое действие', async () => {
    const h = harness();
    for (const [action, mode] of [['enable', 'on'], ['preview', 'preview'], ['disable', 'off']] as const) {
      const res = makeRes();
      await h.c.admin(ADMIN_USER, { action }, res);
      expect(h.store.setMode).toHaveBeenLastCalledWith(mode);
      expect(res.body).toEqual({ mode });
    }
    let res = makeRes();
    await h.c.admin(ADMIN_USER, { action: 'status' }, res);
    expect(res.body).toMatchObject({ mode: 'on', counts: { trials_day: 1 }, windows: { 'guest-lim:answers:d': 5 } });
    res = makeRes();
    await h.c.admin(ADMIN_USER, { action: 'nope' }, res);
    expect(res.statusCode).toBe(400);
  });

  // Дополнение (ревью A3): store.setLimits теперь отдаёт changed — ручка отражает его в коде ответа.
  it('админ: set — лимиты применены (changed:true) — 200', async () => {
    const h = harness();
    const res = makeRes();
    await h.c.admin(ADMIN_USER, { action: 'set', limits: { answersPerDay: 500 } }, res);
    expect(h.store.setLimits).toHaveBeenCalledWith({ answersPerDay: 500 });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ limits: DEFAULT_GUEST_LIMITS, ignored: [], changed: true });
  });

  // Ревью A10: 400 несёт error:'limits' — как у остальной админки (код ответа
  // без узнаваемого поля error раньше ничем не отличался от обычного 400 ручки).
  it('админ: set — ни один ключ не применился (changed:false) — 400, error:"limits" + ignored', async () => {
    const h = harness();
    h.store.setLimits.mockResolvedValueOnce({
      limits: DEFAULT_GUEST_LIMITS,
      ignored: ['answerPerDay: неизвестный ключ'],
      changed: false,
    });
    const res = makeRes();
    await h.c.admin(ADMIN_USER, { action: 'set', limits: { answerPerDay: 500 } }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'limits', limits: DEFAULT_GUEST_LIMITS, ignored: ['answerPerDay: неизвестный ключ'], changed: false });
  });

  // Ревью A10 (1в): sessions.status() может упасть по причине, не связанной с
  // режимом/лимитами (БД моргнула) — админ-ручка не должна молчать про mode/
  // limits/windows только потому, что подсчёт счётчиков не задался.
  it('админ: status — сбой sessions.status() не роняет ручку, counts — null', async () => {
    const h = harness();
    h.sessions.status.mockRejectedValueOnce(new Error('нет базы'));
    const res = makeRes();
    await h.c.admin(ADMIN_USER, { action: 'status' }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.counts).toBeNull();
    expect(res.body.mode).toBe('on');
    expect(res.body.windows).toMatchObject({ 'guest-lim:answers:d': 5 });
  });
});

// Дополнение (ревью A7): main.ts держит CORS открытым для всех — чужим сайтам
// открытые ручки пробы (без JWT) не нужны, кабинет зовёт их со своего адреса.
describe('проверка Origin на открытых ручках пробы', () => {
  it('чужой Origin → 403 на config/session/chat; до базы и до turns.handle не доходит', async () => {
    const h = harness();

    let res = makeRes();
    await h.c.config(makeReq('https://evil.com'), res);
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'origin' });

    res = makeRes();
    await h.c.session(makeReq('https://evil.com'), { token: 'x' }, res);
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'origin' });
    expect(h.sessions.findLive).not.toHaveBeenCalled();

    res = makeRes();
    await h.c.chat(makeReq('https://evil.com'), { assistantId: '1', message: 'привет' }, res);
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'origin' });
    expect(h.turns.handle).not.toHaveBeenCalled();
  });

  it('свой Origin и отсутствие заголовка — доходят до turns.handle', async () => {
    const h = harness();

    let res = makeRes();
    await h.c.chat(makeReq('https://my.linkeon.io'), { assistantId: '1', message: 'привет' }, res);
    expect(h.turns.handle).toHaveBeenCalledTimes(1);

    res = makeRes();
    await h.c.chat(makeReq(), { assistantId: '1', message: 'привет' }, res);
    expect(h.turns.handle).toHaveBeenCalledTimes(2);
  });

  // Ревью A10 (мелочи): ответ открытых ручек зависит от Origin (200 или 403) —
  // промежуточный кеш не должен запомнить один ответ за всех посетителей.
  it('открытые ручки ставят Cache-Control: no-store — и при разрешённом, и при чужом Origin', async () => {
    const h = harness();

    let res = makeRes();
    await h.c.config(makeReq(), res);
    expect(res.headers['Cache-Control']).toBe('no-store');

    res = makeRes();
    await h.c.config(makeReq('https://evil.com'), res);
    expect(res.headers['Cache-Control']).toBe('no-store');
  });
});

// Та же дыра, которую admin-routes.spec.ts исторически находил в других
// контроллерах (AdminGuard забыт рядом с JwtGuard) — но этот контроллер родился
// позже и в тот общий сторож не попадает (там жёсткий список контроллеров).
// Проверяем сами, в своём файле, не трогая общий guard-сторож. guardsFor — тот
// же приём, что в src/common/guards/admin-routes.spec.ts: гарды с класса и с
// метода вместе — если кто-то повесит @UseGuards(JwtGuard) на сам класс,
// открытые ручки пробы (config/chat/session) умрут без единого Important-теста
// на одном только методе.
function guardsFor(controller: Function, method: string): unknown[] {
  const own = Reflect.getMetadata(
    GUARDS_METADATA,
    (controller.prototype as Record<string, unknown>)[method] as object,
  );
  const fromClass = Reflect.getMetadata(GUARDS_METADATA, controller);
  return [...(fromClass ?? []), ...(own ?? [])];
}

describe('гарды ручек пробы (класс + метод)', () => {
  it('admin/guest-trial закрыт JwtGuard и AdminGuard', () => {
    const guards = guardsFor(GuestTrialController, 'admin');
    expect(guards).toContain(JwtGuard);
    expect(guards).toContain(AdminGuard);
  });

  it('guest/claim закрыт JwtGuard', () => {
    expect(guardsFor(GuestTrialController, 'claim')).toContain(JwtGuard);
  });

  it('открытые ручки (config/chat/session) — без гардов даже с учётом класса', () => {
    for (const m of ['config', 'chat', 'session'] as const) {
      expect(guardsFor(GuestTrialController, m)).toEqual([]);
    }
  });
});
