import { TgHealthService } from './tg-health.service';

/**
 * Мониторинг Telegram-бота.
 *
 * Бот не был покрыт ничем: synthetic не трогает Telegram, а внутри src/tg-bot
 * все отказы уходят в logger.warn. Проверяем ровно те свойства, ради которых
 * сервис заведён, — и в обе стороны: зелёный результат сам по себе ничего не
 * доказывает, поэтому в каждом кейсе есть парный, где проверка обязана краснеть.
 */

jest.mock('axios');
jest.mock('../common/telegram-alert', () => ({
  sendTelegramPayload: jest.fn(async () => {}),
}));

import axios from 'axios';
import { sendTelegramPayload } from '../common/telegram-alert';

const mockedGet = axios.get as jest.Mock;
const mockedSend = sendTelegramPayload as jest.Mock;

const SECRET = 'url-secret-do-not-leak';
const OK_URL = `https://my.linkeon.io/webhook/telegram/${SECRET}`;

function webhookInfo(over: Record<string, any> = {}) {
  return {
    status: 200,
    data: { ok: true, result: { url: OK_URL, pending_update_count: 0, ...over } },
  };
}

function makeService(rows: any[] = []) {
  const pg = { query: jest.fn(async (_sql: string, _params?: any[]) => ({ rows })) };
  const synthetic = { record: jest.fn(async () => {}) };
  const svc = new TgHealthService(pg as any, synthetic as any);
  return { svc, pg, synthetic };
}

const alertTexts = () => mockedSend.mock.calls.map((c) => String(c[0].text));

beforeEach(() => {
  jest.clearAllMocks();
  process.env.TG_BOT_TOKEN = 'bot-token';
  process.env.TG_WEBHOOK_URL_SECRET = SECRET;
  process.env.TG_WEBHOOK_BASE_URL = 'https://my.linkeon.io';
  process.env.TELEGRAM_BOT_TOKEN = 'alert-token';
  process.env.TELEGRAM_CHAT_ID = '123';
});

describe('TgHealthService.probeWebhook', () => {
  it('исправный вебхук — успех, алерта нет', async () => {
    mockedGet.mockResolvedValue(webhookInfo());
    const { svc, synthetic } = makeService();

    await svc.probeWebhook();

    expect(svc.getOverview().webhook.healthy).toBe(true);
    expect(synthetic.record).toHaveBeenCalledWith('tg_webhook', true, expect.any(Number), null);
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it('вебхук снесён (url пустой) — падение и алерт', async () => {
    // Самый тихий отказ: getMe отвечает 200, токен валиден, бот выглядит живым,
    // но Telegram ему ничего не шлёт.
    mockedGet.mockResolvedValue(webhookInfo({ url: '' }));
    const { svc, synthetic } = makeService();

    await svc.probeWebhook();

    expect(svc.getOverview().webhook.healthy).toBe(false);
    expect(synthetic.record).toHaveBeenCalledWith(
      'tg_webhook', false, expect.any(Number), expect.stringContaining('не зарегистрирован'),
    );
    expect(alertTexts()[0]).toContain('не принимает сообщения');
  });

  it('вебхук уведён на чужой инстанс — падение, и секрет не утекает в алерт', async () => {
    mockedGet.mockResolvedValue(webhookInfo({ url: 'https://evil.example/webhook/telegram/other-secret' }));
    const { svc } = makeService();

    await svc.probeWebhook();

    expect(svc.getOverview().webhook.healthy).toBe(false);
    const text = alertTexts().join('\n');
    expect(text).toContain('чужому инстансу');
    expect(text).not.toContain('other-secret');
    expect(text).not.toContain(SECRET);
    expect(svc.getOverview().webhook.url).not.toContain('other-secret');
  });

  it('свежая ошибка доставки — падение; протухшая — норма', async () => {
    const nowSec = Math.floor(Date.now() / 1000);

    mockedGet.mockResolvedValue(webhookInfo({
      last_error_date: nowSec - 5 * 60,
      last_error_message: 'Connection timed out',
    }));
    const fresh = makeService();
    await fresh.svc.probeWebhook();
    expect(fresh.svc.getOverview().webhook.healthy).toBe(false);
    expect(alertTexts().join('\n')).toContain('Connection timed out');

    jest.clearAllMocks();
    // Та же ошибка, но многочасовой давности: Telegram держит last_error_date до
    // следующего успеха, поэтому без проверки свежести алерт залипал бы навсегда.
    mockedGet.mockResolvedValue(webhookInfo({
      last_error_date: nowSec - 6 * 3600,
      last_error_message: 'Connection timed out',
    }));
    const stale = makeService();
    await stale.svc.probeWebhook();
    expect(stale.svc.getOverview().webhook.healthy).toBe(true);
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it('очередь апдейтов выше порога — падение; в пределах порога — норма', async () => {
    process.env.TG_PENDING_UPDATES_MAX = '20';

    mockedGet.mockResolvedValue(webhookInfo({ pending_update_count: 500 }));
    const over = makeService();
    await over.svc.probeWebhook();
    expect(over.svc.getOverview().webhook.healthy).toBe(false);
    expect(over.svc.getOverview().webhook.pendingUpdateCount).toBe(500);

    jest.clearAllMocks();
    mockedGet.mockResolvedValue(webhookInfo({ pending_update_count: 3 }));
    const under = makeService();
    await under.svc.probeWebhook();
    expect(under.svc.getOverview().webhook.healthy).toBe(true);
  });

  it('401 от Telegram — падение с подсказкой про токен', async () => {
    mockedGet.mockResolvedValue({ status: 401, data: { ok: false, description: 'Unauthorized' } });
    const { svc } = makeService();

    await svc.probeWebhook();

    expect(svc.getOverview().webhook.healthy).toBe(false);
    expect(svc.getOverview().webhook.error).toContain('TG_BOT_TOKEN');
  });

  it('восстановление после падения — один отбойный алерт', async () => {
    mockedGet.mockResolvedValue(webhookInfo({ url: '' }));
    const { svc } = makeService();
    await svc.probeWebhook();
    jest.clearAllMocks();

    mockedGet.mockResolvedValue(webhookInfo());
    await svc.probeWebhook();

    expect(svc.getOverview().webhook.healthy).toBe(true);
    expect(alertTexts()).toHaveLength(1);
    expect(alertTexts()[0]).toContain('снова принимает сообщения');
  });

  it('без TG_BOT_TOKEN не пробует и не шумит', async () => {
    delete process.env.TG_BOT_TOKEN;
    const { svc, synthetic } = makeService();

    await svc.probeWebhook();

    expect(mockedGet).not.toHaveBeenCalled();
    expect(synthetic.record).not.toHaveBeenCalled();
    expect(mockedSend).not.toHaveBeenCalled();
    expect(svc.getOverview().webhook.healthy).toBeNull();
  });
});

describe('TgHealthService.checkUnanswered', () => {
  it('ищет только помеченные answer_expected_at и только без ответа после отметки', async () => {
    const { svc, pg } = makeService([]);

    await svc.checkUnanswered();

    const sql = pg.query.mock.calls[0][0] as unknown as string;
    // Без этого условия детектор считал бы сбоем каждое сообщение, которое бот
    // игнорирует намеренно (группа, strict-режим) — а таких большинство.
    expect(sql).toContain('answer_expected_at IS NOT NULL');
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain("a.role IN ('assistant', 'system')");
    expect(sql).toContain('a.created_at > m.answer_expected_at');
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it('след упавшего хода закрывает чат: разобранный сбой — не молчание', async () => {
    // Падение генерации пишет system-строку (tg-router persistTurnFailure).
    // Пока в NOT EXISTS стояла только 'assistant', такой чат висел в алерте
    // сутки — юзер ошибку уже увидел, а детектор считал его замолчавшим.
    const { svc, pg } = makeService([]);

    await svc.checkUnanswered();

    const sql = pg.query.mock.calls[0][0] as unknown as string;
    expect(sql).toContain("'system'");
  });

  it('зависшие чаты — алерт с их числом и временем ожидания', async () => {
    const { svc } = makeService([
      { tg_chat_id: '-100123', tg_chat_title: 'Рабочий чат', waiting_minutes: '42.6' },
      { tg_chat_id: '275385039', tg_chat_title: null, waiting_minutes: '18.2' },
    ]);

    await svc.checkUnanswered();

    const text = alertTexts()[0];
    expect(text).toContain('в 2 чат');
    expect(text).toContain('Рабочий чат');
    expect(text).toContain('43 мин');
    expect(svc.getOverview().unanswered.stuckChats).toBe(2);
  });

  it('повторный прогон с теми же висяками не спамит, а отбой приходит один раз', async () => {
    const stuck = [{ tg_chat_id: '-100123', tg_chat_title: 'Чат', waiting_minutes: '30' }];
    const pg = { query: jest.fn(async (_sql: string, _params?: any[]) => ({ rows: stuck as any[] })) };
    const svc = new TgHealthService(pg as any, { record: jest.fn() } as any);

    await svc.checkUnanswered();
    await svc.checkUnanswered();
    expect(alertTexts()).toHaveLength(1); // второй раз — кулдаун

    jest.clearAllMocks();
    pg.query.mockResolvedValue({ rows: [] } as any);
    await svc.checkUnanswered();
    await svc.checkUnanswered();

    expect(alertTexts()).toHaveLength(1);
    expect(alertTexts()[0]).toContain('зависших чатов не осталось');
    expect(svc.getOverview().unanswered.stuckChats).toBe(0);
  });

  it('HTML в названии чата экранируется', async () => {
    const { svc } = makeService([
      { tg_chat_id: '-1', tg_chat_title: '<b>bold</b> & co', waiting_minutes: '20' },
    ]);

    await svc.checkUnanswered();

    const text = alertTexts()[0];
    expect(text).toContain('&lt;b&gt;bold&lt;/b&gt; &amp; co');
  });
});
