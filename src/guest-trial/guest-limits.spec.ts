import { clockRedis } from '../auth/fake-redis.forspec';
import { DEFAULT_GUEST_LIMITS } from './guest-trial.types';
import { answerRules, takeGuestQuota, trialRules } from './guest-limits';

const L = { ...DEFAULT_GUEST_LIMITS, trialsPerHour: 2, trialsPerDay: 3, answersPerHour: 2, answersPerDay: 5 };

describe('общие окна пробы', () => {
  it('новые пробы: часовое окно закрывается и открывается через час, суточное держит', async () => {
    const r = clockRedis();
    expect((await takeGuestQuota(r, trialRules(L), 1000)).counted).toBe(true);
    expect((await takeGuestQuota(r, trialRules(L), 1000)).counted).toBe(true);
    const third = await takeGuestQuota(r, trialRules(L), 1000);
    expect(third.counted).toBe(false);
    expect(third.redisDown).toBe(false);
    expect(third.full.map((f) => f.scope)).toEqual(['trials_hour']);
    expect(third.full[0].leftMs).toBeGreaterThan(0);
    r.advance(3600);
    expect((await takeGuestQuota(r, trialRules(L), 1000)).counted).toBe(true); // третья за сутки
    r.advance(3600);
    const fifth = await takeGuestQuota(r, trialRules(L), 1000);
    expect(fifth.full.map((f) => f.scope)).toEqual(['trials_day']);
  });

  it('ответы считаются отдельно от проб', async () => {
    const r = clockRedis();
    await takeGuestQuota(r, trialRules(L), 1000);
    await takeGuestQuota(r, trialRules(L), 1000);
    expect((await takeGuestQuota(r, answerRules(L), 1000)).counted).toBe(true);
    expect(r.peek('guest-lim:answers:h')).toBe('1');
  });

  it('Redis упал — проба закрыта без учёта', async () => {
    const r = clockRedis();
    r.breakAfter(0);
    expect(await takeGuestQuota(r, answerRules(L), 1000)).toEqual({ counted: false, redisDown: true, full: [] });
  });

  it('Redis висит — ждём не дольше срока', async () => {
    const hanging = { eval: () => new Promise<unknown>(() => {}) };
    const started = Date.now();
    const reply = await takeGuestQuota(hanging, answerRules(L), 50);
    expect(reply.redisDown).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
