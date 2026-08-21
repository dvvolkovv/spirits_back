/**
 * Атрибуция критичных synthetic-алертов.
 *
 * Инцидент 2026-08-21 10:30 UTC: одиночный подвисший refresh на node-3 обнулил
 * JWT, из-за чего chat_streaming был помечен красным, ни разу не сходив в
 * /webhook/soulmate/chat. Алерт при этом ушёл с ярлыком «AI-чат (r.linkeon.io)»
 * — то есть отправил дежурного чинить релей, который даже не опрашивался.
 *
 * Второе, что вскрыл тот же инцидент: в CRITICAL_SCENARIOS по умолчанию стоял
 * несуществующий ключ `auth_refresh`, а раннер шлёт `refresh_jwt`. Настоящая
 * поломка авторизации не алертилась напрямую — только рикошетом через
 * chat_streaming, с той самой неверной атрибуцией.
 */

jest.mock('../common/telegram-alert', () => ({
  sendTelegramPayload: jest.fn(async () => {}),
}));

import { SyntheticService } from './synthetic.service';
import { sendTelegramPayload } from '../common/telegram-alert';

const mockedSend = sendTelegramPayload as jest.Mock;
const alertTexts = () => mockedSend.mock.calls.map((c) => String(c[0].text));

/** Строка в формате, который getOverview возвращает из БД. */
function row(scenario: string, success: boolean, message: string | null = null) {
  return {
    scenario,
    latest_success: success,
    latest_ts: new Date(),
    latest_duration_ms: success ? 300 : 0,
    latest_message: message,
    runs_24h: 288,
    successes_24h: success ? 288 : 285,
  };
}

function makeService(rows: any[]) {
  const pg = { query: jest.fn(async () => ({ rows })) };
  return new SyntheticService(pg as any);
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.TELEGRAM_BOT_TOKEN = 'alert-token';
  process.env.TELEGRAM_CHAT_ID = '123';
  delete process.env.SYNTHETIC_CRITICAL_SCENARIOS;
});

describe('SyntheticService: атрибуция падений', () => {
  it('падение авторизации алертится само по себе', async () => {
    const svc = makeService([
      row('refresh_jwt', false, 'refresh HTTP 401'),
      row('chat_streaming', true),
    ]);

    await svc.checkAndAlert();

    const texts = alertTexts();
    expect(texts.some((t) => t.includes('refresh_jwt'))).toBe(true);
  });

  it('каскад «нет JWT» не приписывается релею r.linkeon.io', async () => {
    const svc = makeService([
      row('refresh_jwt', false, 'refresh HTTP 401'),
      row('chat_streaming', false, 'не проверялся: нет JWT (см. refresh_jwt)'),
    ]);

    await svc.checkAndAlert();

    const chatAlert = alertTexts().find((t) => t.includes('chat_streaming'));
    expect(chatAlert).toBeDefined();
    expect(chatAlert).not.toContain('r.linkeon.io');
    expect(chatAlert).toContain('refresh_jwt');
  });

  it('настоящее падение чата по-прежнему указывает на r.linkeon.io', async () => {
    // Проверка в обратную сторону: чинить атрибуцию нельзя ценой того, что
    // реальный отказ AI перестанет показывать, где искать.
    const svc = makeService([
      row('refresh_jwt', true),
      row('chat_streaming', false, 'AI error placeholder in stream: «временный сбой связи с моделью»'),
    ]);

    await svc.checkAndAlert();

    const chatAlert = alertTexts().find((t) => t.includes('chat_streaming') || t.includes('AI-чат'));
    expect(chatAlert).toContain('AI-чат (r.linkeon.io)');
  });
});
