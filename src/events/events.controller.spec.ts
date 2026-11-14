// src/events/events.controller.spec.ts
import { EventsController } from './events.controller';
import { GUEST_SERVER_EVENTS } from '../guest-trial/guest-trial.types';

function makeRes() {
  const res: any = {
    statusCode: 0,
    body: undefined,
    status(c: number) { this.statusCode = c; return this; },
    json(b: any) { this.body = b; return this; },
    end() { this.ended = true; return this; },
  };
  return res;
}

function harness() {
  const events = { track: jest.fn() };
  const c = new EventsController(events as any);
  return { c, events };
}

/**
 * Ревью A10: открытая (без JWT) events/track принимала любое имя. Подделанный
 * guest_trial_answer с мусорным cost_usd рушит status() админки на дни вперёд
 * (::numeric кидает исключение на нечисловых значениях), а guest_trial_error
 * с произвольным reason заводит фальшивый ключ статистики — цифры воронки
 * пробы подделываются кем угодно с доступом к сети.
 */
describe('events/track: серверные имена пробы не подделать', () => {
  it.each(GUEST_SERVER_EVENTS)('%s — молча отбрасывается (204, EventsService.track не вызван)', async (name) => {
    const h = harness();
    const res = makeRes();
    await h.c.track({ name, props: { cost_usd: 'x' } } as any, { headers: {} } as any, res);
    expect(res.statusCode).toBe(204);
    expect(h.events.track).not.toHaveBeenCalled();
  });

  it('клиентские guest_trial_view/guest_trial_wall идут как раньше', async () => {
    const h = harness();
    for (const name of ['guest_trial_view', 'guest_trial_wall']) {
      const res = makeRes();
      // eslint-disable-next-line no-await-in-loop
      await h.c.track({ name } as any, { headers: {} } as any, res);
      expect(res.statusCode).toBe(204);
    }
    expect(h.events.track).toHaveBeenCalledTimes(2);
  });

  it('обычное (не гостевое) имя — пишется как раньше', async () => {
    const h = harness();
    const res = makeRes();
    await h.c.track({ name: 'landing_view' } as any, { headers: {} } as any, res);
    expect(h.events.track).toHaveBeenCalledWith('landing_view', expect.objectContaining({ props: {} }));
    expect(res.statusCode).toBe(204);
  });

  it('без имени — 400, как и раньше', async () => {
    const h = harness();
    const res = makeRes();
    await h.c.track({} as any, { headers: {} } as any, res);
    expect(res.statusCode).toBe(400);
    expect(h.events.track).not.toHaveBeenCalled();
  });
});

/**
 * Task 16: body.userId — НЕ доказательство владения. Если запрос дошёл с
 * валидным JWT, аутентифицированный phone побеждает претензию из тела;
 * у анонимной ручки body.userId остаётся (загрязнение агрегатов терпимо,
 * ownership proof из body не извлекается — см. шапку контроллера).
 */
describe('events/track: body.userId не ownership proof', () => {
  it('JWT-пользователь важнее body.userId', async () => {
    const h = harness();
    const res = makeRes();
    await h.c.track(
      { name: 'chat_open', userId: 'u-victim' } as any,
      { headers: {}, user: { phone: 'u-jwt-owner' } } as any,
      res,
    );
    expect(res.statusCode).toBe(204);
    expect(h.events.track).toHaveBeenCalledWith(
      'chat_open',
      expect.objectContaining({ userId: 'u-jwt-owner' }),
    );
  });

  it('без JWT body.userId проходит как раньше (анонимная ручка)', async () => {
    const h = harness();
    const res = makeRes();
    await h.c.track(
      { name: 'chat_open', userId: 'u-claim' } as any,
      { headers: {} } as any,
      res,
    );
    expect(res.statusCode).toBe(204);
    expect(h.events.track).toHaveBeenCalledWith(
      'chat_open',
      expect.objectContaining({ userId: 'u-claim' }),
    );
  });
});
