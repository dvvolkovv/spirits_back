/**
 * Мониторинг приёма платежей.
 *
 * Инцидент 14–15.08.2026: магазин ЮKassa перевели в status=disabled, создание
 * платежа стало отдавать 403, пользователи видели «Internal server error».
 * Узнали через двое суток от владельца — ни одна проверка этого не ловила.
 *
 * Ключевое свойство, ради которого всё затевалось: проба ДОЛЖНА краснеть при
 * status != enabled, хотя HTTP при этом 200 и ключи валидны. Проверка «ответ
 * 200 — значит всё хорошо» пропустила бы ровно эту аварию.
 */

jest.mock('axios');
jest.mock('../common/telegram-alert', () => ({
  sendTelegramPayload: jest.fn(async () => {}),
}));

import axios from 'axios';
import { sendTelegramPayload } from '../common/telegram-alert';
import { PaymentsHealthService } from './payments-health.service';

const mockedGet = axios.get as jest.Mock;
const mockedSend = sendTelegramPayload as jest.Mock;
const alertTexts = () => mockedSend.mock.calls.map((c) => String(c[0].text));

const me = (status: string) => ({ status: 200, data: { account_id: '1207563', status } });

function makeService(rows: any[] = []) {
  const pg = { query: jest.fn(async (_sql: string, _params?: any[]) => ({ rows })) };
  const synthetic = { record: jest.fn(async () => {}) };
  return { svc: new PaymentsHealthService(pg as any, synthetic as any), pg, synthetic };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.YOOKASSA_SHOP_ID = '1207563';
  process.env.YOOKASSA_SECRET_KEY = 'live_secret';
  process.env.TELEGRAM_BOT_TOKEN = 'alert-token';
  process.env.TELEGRAM_CHAT_ID = '123';
});

describe('Слой 1: проба магазина', () => {
  it('status=enabled — зелено, тишина', async () => {
    mockedGet.mockResolvedValue(me('enabled'));
    const { svc, synthetic } = makeService();

    await svc.probeShop();

    expect(svc.getOverview().shop.healthy).toBe(true);
    expect(synthetic.record).toHaveBeenCalledWith('yookassa_shop', true, expect.any(Number), null);
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it('status=disabled при HTTP 200 — красно и алерт (ровно случай 14.08)', async () => {
    mockedGet.mockResolvedValue(me('disabled'));
    const { svc, synthetic } = makeService();

    await svc.probeShop();

    expect(svc.getOverview().shop.healthy).toBe(false);
    expect(svc.getOverview().shop.status).toBe('disabled');
    expect(synthetic.record).toHaveBeenCalledWith(
      'yookassa_shop', false, expect.any(Number), expect.stringContaining('disabled'),
    );
    expect(alertTexts()[0]).toContain('Приём платежей не работает');
  });

  it('401 — отдельная диагностика про ключи', async () => {
    mockedGet.mockResolvedValue({ status: 401, data: {} });
    const { svc } = makeService();

    await svc.probeShop();

    expect(svc.getOverview().shop.healthy).toBe(false);
    expect(svc.getOverview().shop.error).toContain('YOOKASSA_SECRET_KEY');
  });

  it('сеть недоступна — красно, а не тихое падение', async () => {
    mockedGet.mockRejectedValue(new Error('ETIMEDOUT'));
    const { svc } = makeService();

    await svc.probeShop();

    expect(svc.getOverview().shop.healthy).toBe(false);
    expect(svc.getOverview().shop.error).toContain('ETIMEDOUT');
  });

  it('восстановление — один отбойный алерт', async () => {
    mockedGet.mockResolvedValue(me('disabled'));
    const { svc } = makeService();
    await svc.probeShop();
    jest.clearAllMocks();

    mockedGet.mockResolvedValue(me('enabled'));
    await svc.probeShop();

    expect(alertTexts()).toHaveLength(1);
    expect(alertTexts()[0]).toContain('восстановлен');
  });

  it('ключей нет — не пробуем и не шумим', async () => {
    delete process.env.YOOKASSA_SHOP_ID;
    const { svc, synthetic } = makeService();

    await svc.probeShop();

    expect(mockedGet).not.toHaveBeenCalled();
    expect(synthetic.record).not.toHaveBeenCalled();
    expect(svc.getOverview().shop.healthy).toBeNull();
  });
});

describe('Слой 2: серия неудачных попыток', () => {
  const fail = (error = 'HTTP 403') => ({ ok: false, error, created_at: new Date('2026-08-14T16:05:00Z') });
  const success = () => ({ ok: true, error: null, created_at: new Date('2026-08-14T16:06:00Z') });

  it('три неудачи подряд — алерт', async () => {
    const { svc } = makeService([fail(), fail(), fail()]);

    await svc.checkAttempts();

    expect(svc.getOverview().attempts.failStreak).toBe(3);
    expect(alertTexts()[0]).toContain('Пополнение падает');
  });

  it('две неудачи — ещё не авария, молчим', async () => {
    const { svc } = makeService([fail(), fail(), success()]);

    await svc.checkAttempts();

    expect(svc.getOverview().attempts.failStreak).toBe(2);
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it('серия считается с конца: успех обрывает счёт старых неудач', async () => {
    // Иначе давние отказы вперемешку с успехами вечно держали бы алерт.
    const { svc } = makeService([success(), fail(), fail(), fail(), fail()]);

    await svc.checkAttempts();

    expect(svc.getOverview().attempts.failStreak).toBe(0);
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it('после починки приходит отбой', async () => {
    const pg = { query: jest.fn(async () => ({ rows: [fail(), fail(), fail()] as any[] })) };
    const svc = new PaymentsHealthService(pg as any, { record: jest.fn() } as any);
    await svc.checkAttempts();
    jest.clearAllMocks();

    pg.query.mockResolvedValue({ rows: [success()] } as any);
    await svc.checkAttempts();

    expect(alertTexts()[0]).toContain('снова проходит');
  });
});

describe('Слой 3: воронка создан → оплачен', () => {
  const funnel = (created: number, succeeded: number) => [{ created, succeeded }];

  it('платежи создаются, успешных ноль — алерт', async () => {
    const { svc } = makeService(funnel(5, 0));

    await svc.checkFunnel();

    expect(svc.getOverview().funnel.healthy).toBe(false);
    expect(alertTexts()[0]).toContain('ни один не оплачен');
  });

  it('мало попыток — судить не по чему, молчим', async () => {
    // Без этого условия при 1–2 платежах в сутки алерт орал бы на любых
    // выходных, когда просто никто не покупал.
    const { svc } = makeService(funnel(2, 0));

    await svc.checkFunnel();

    expect(svc.getOverview().funnel.healthy).toBeNull();
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it('хоть один успех — путь рабочий, остальное брошенные корзины', async () => {
    const { svc } = makeService(funnel(10, 1));

    await svc.checkFunnel();

    expect(svc.getOverview().funnel.healthy).toBe(true);
    expect(mockedSend).not.toHaveBeenCalled();
  });
});
