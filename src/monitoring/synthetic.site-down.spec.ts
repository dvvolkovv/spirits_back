/**
 * Сайт не открывается — один алерт о первопричине, а не каскад.
 *
 * Инцидент 2026-10-23: Selectel заблокировал прокси my.linkeon.io (92.53.64.147)
 * за неуплату. Раннер на node-3 ходит через тот же прокси, поэтому при его
 * падении краснеют все сценарии разом: refresh_jwt («fetch failed»),
 * chat_streaming («нет JWT»), agents_endpoint. Без отдельного сценария
 * site_reachable алерт пришёл бы с ярлыком refresh_jwt и отправил бы дежурного
 * чинить авторизацию, хотя сайт просто недоступен.
 */

jest.mock('../common/telegram-alert', () => ({
  sendTelegramPayload: jest.fn(async () => {}),
}));

import { SyntheticService } from './synthetic.service';
import { sendTelegramPayload } from '../common/telegram-alert';

const mockedSend = sendTelegramPayload as jest.Mock;
const alertTexts = () => mockedSend.mock.calls.map((c) => String(c[0].text));

function row(scenario: string, success: boolean, message: string | null = null) {
  return {
    scenario,
    latest_success: success,
    latest_ts: new Date(),
    latest_duration_ms: success ? 300 : 0,
    latest_message: message,
    runs_24h: 96,
    successes_24h: success ? 96 : 90,
  };
}

const proxyDown = () => [
  row('site_reachable', false, 'fetch failed'),
  row('refresh_jwt', false, 'fetch failed (попыток: 3)'),
  row('agents_endpoint', false, 'fetch failed'),
  row('chat_streaming', false, 'не проверялся: нет JWT (причина — refresh_jwt)'),
];

/** pg-заглушка, у которой можно подменить строки между проверками. */
function makeService(initial: any[]) {
  const state = { rows: initial };
  const pg = { query: jest.fn(async () => ({ rows: state.rows })) };
  return { svc: new SyntheticService(pg as any), state };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.TELEGRAM_BOT_TOKEN = 'alert-token';
  process.env.TELEGRAM_CHAT_ID = '123';
  delete process.env.SYNTHETIC_CRITICAL_SCENARIOS;
});

describe('SyntheticService: сайт не открывается', () => {
  it('прокси лёг — ровно один алерт, и он про сайт, а не про авторизацию', async () => {
    const { svc } = makeService(proxyDown());

    await svc.checkAndAlert();

    const texts = alertTexts();
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('my.linkeon.io не открывается');
    expect(texts[0]).not.toContain('refresh_jwt');
  });

  it('сайт поднялся, а авторизация лежит — теперь алерт про refresh_jwt', async () => {
    const { svc, state } = makeService(proxyDown());
    await svc.checkAndAlert();
    mockedSend.mockClear();

    state.rows = [
      row('site_reachable', true),
      row('refresh_jwt', false, 'refresh HTTP 401'),
      row('agents_endpoint', true),
      row('chat_streaming', false, 'не проверялся: нет JWT (причина — refresh_jwt)'),
    ];
    await svc.checkAndAlert();

    const texts = alertTexts();
    expect(texts.some((t) => t.includes('my.linkeon.io') && t.includes('🟢'))).toBe(true);
    expect(texts.some((t) => t.includes('🔴') && t.includes('refresh_jwt'))).toBe(true);
  });

  it('всё поднялось — отбой только по сайту, без «восстановлен» для заглушённых', async () => {
    // Про падение refresh_jwt и chat_streaming мы не сообщали, значит и
    // «восстановлен» по ним был бы ответом на вопрос, которого никто не задавал.
    const { svc, state } = makeService(proxyDown());
    await svc.checkAndAlert();
    mockedSend.mockClear();

    state.rows = [
      row('site_reachable', true),
      row('refresh_jwt', true),
      row('agents_endpoint', true),
      row('chat_streaming', true),
    ];
    await svc.checkAndAlert();

    const texts = alertTexts();
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('🟢');
    expect(texts[0]).toContain('my.linkeon.io');
  });

  it('сайт жив — каскадная логика авторизации работает как раньше', async () => {
    // Проверка в обратную сторону: глушение не должно задевать обычный сбой.
    const { svc } = makeService([
      row('site_reachable', true),
      row('refresh_jwt', false, 'refresh HTTP 401'),
      row('chat_streaming', false, 'не проверялся: нет JWT (причина — refresh_jwt)'),
    ]);

    await svc.checkAndAlert();

    const texts = alertTexts();
    expect(texts.some((t) => t.includes('refresh_jwt'))).toBe(true);
    expect(texts.some((t) => t.includes('my.linkeon.io не открывается'))).toBe(false);
  });
});
