/**
 * Детектор «мониторинг ослеп» считает свежесть по внешнему раннеру (cron на
 * node-3), а не по всем строкам synthetic_runs.
 *
 * Ловушка: TgHealthService пишет сценарий tg_webhook в ту же таблицу изнутри
 * бэкенда каждые 5 минут. Если считать свежесть по максимуму среди ВСЕХ
 * сценариев, эта запись держит «newest» вечно свежим, и падение внешнего
 * раннера перестаёт детектироваться — то есть добавление мониторинга бота
 * молча выключило бы мониторинг всего остального.
 */

jest.mock('../common/telegram-alert', () => ({
  sendTelegramPayload: jest.fn(async () => {}),
}));

import { SyntheticService } from './synthetic.service';
import { sendTelegramPayload } from '../common/telegram-alert';

const mockedSend = sendTelegramPayload as jest.Mock;
const alertTexts = () => mockedSend.mock.calls.map((c) => String(c[0].text));

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

/** Строка в формате, который возвращает getOverview из БД. */
function row(scenario: string, ageMin: number) {
  return {
    scenario,
    latest_success: true,
    latest_ts: minutesAgo(ageMin),
    latest_duration_ms: 100,
    latest_message: null,
    runs_24h: 96,
    successes_24h: 96,
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
});

describe('SyntheticService: протухание результатов', () => {
  it('внешний раннер умер, а in-process сценарий свежий — всё равно алерт', async () => {
    const svc = makeService([
      row('chat_streaming', 180), // раннер молчит три часа
      row('tg_webhook', 1), // пишем сами, всегда свежий
    ]);

    await svc.checkAndAlert();

    expect(alertTexts().some((t) => t.includes('ослеп'))).toBe(true);
  });

  it('внешний раннер жив — алерта нет, хотя порог общий', async () => {
    const svc = makeService([
      row('chat_streaming', 5),
      row('tg_webhook', 1),
    ]);

    await svc.checkAndAlert();

    expect(alertTexts().some((t) => t.includes('ослеп'))).toBe(false);
  });

  it('только in-process сценарии (раннер ещё не заводили) — молчим', async () => {
    const svc = makeService([row('tg_webhook', 1)]);

    await svc.checkAndAlert();

    expect(mockedSend).not.toHaveBeenCalled();
  });
});
