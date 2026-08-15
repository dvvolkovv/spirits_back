/**
 * Отказ платёжного провайдера не должен выглядеть как наша пятисотка.
 *
 * Инцидент 14–15.08.2026: магазин ЮKassa перевели в status=disabled, POST
 * /v3/payments начал отдавать 403. Наружу это выходило как «Internal server
 * error», а причина — тело ответа провайдера — не попадала ни в лог, ни в БД:
 * строка в payments пишется только ПОСЛЕ успешного ответа. Двое суток никто не
 * знал, что оплаты не работают, а причину пришлось доставать руками отдельным
 * запросом к API.
 *
 * Три требования: причина сохраняется, попытка остаётся в журнале (иначе
 * мониторингу не на что смотреть), наружу уходит 503 с понятным текстом.
 */

jest.mock('axios');

import axios from 'axios';
import { PaymentsService } from './payments.service';

const mockedPost = axios.post as jest.Mock;

/** Ошибка в форме, в которой её отдаёт axios: со status и телом ответа. */
function axiosError(status: number, data: any) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data },
  });
}

function makeService() {
  const queries: Array<{ sql: string; params: any[] }> = [];
  const pg = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      queries.push({ sql, params });
      return { rows: [] };
    }),
  };
  const svc = new PaymentsService(pg as any, null as any, undefined);
  return { svc, queries };
}

const attemptInsert = (q: Array<{ sql: string; params: any[] }>) =>
  q.find((c) => /INSERT INTO payment_attempts/.test(c.sql));
const paymentInsert = (q: Array<{ sql: string; params: any[] }>) =>
  q.find((c) => /INSERT INTO payments/.test(c.sql));

beforeEach(() => {
  jest.clearAllMocks();
  process.env.YOOKASSA_SHOP_ID = '1207563';
  process.env.YOOKASSA_SECRET_KEY = 'live_secret';
});

describe('createPayment: провайдер отказал', () => {
  const denied = () => axiosError(403, { type: 'error', code: 'forbidden', description: 'Shop is disabled' });

  it('отдаёт 503 с понятным текстом, а не голую пятисотку', async () => {
    mockedPost.mockRejectedValue(denied());
    const { svc } = makeService();

    await expect(svc.createPayment('79030169187', 1990, 'professional')).rejects.toMatchObject({
      status: 503,
    });
  });

  it('сохраняет тело ответа провайдера — иначе причину не найти', async () => {
    mockedPost.mockRejectedValue(denied());
    const { svc, queries } = makeService();

    await svc.createPayment('79030169187', 1990, 'professional').catch(() => {});

    const rec = attemptInsert(queries);
    expect(rec).toBeDefined();
    expect(rec!.params).toContain(403);
    expect(String(rec!.params.find((p) => typeof p === 'string' && p.includes('disabled')))).toContain('Shop is disabled');
  });

  it('пишет неудачную попытку — на неё смотрит мониторинг', async () => {
    mockedPost.mockRejectedValue(denied());
    const { svc, queries } = makeService();

    await svc.createPayment('79030169187', 1990, 'professional').catch(() => {});

    expect(attemptInsert(queries)!.params).toContain(false); // ok=false
    // Записи о самом платеже быть не должно: платежа не существует.
    expect(paymentInsert(queries)).toBeUndefined();
  });

  it('журнал не роняет платёж: упавшая вставка не превращается в другую ошибку', async () => {
    mockedPost.mockRejectedValue(denied());
    const pg = { query: jest.fn(async () => { throw new Error('БД недоступна'); }) };
    const svc = new PaymentsService(pg as any, null as any, undefined);

    // Пользователь всё равно должен получить внятный 503, а не «БД недоступна».
    await expect(svc.createPayment('u1', 1990, 'professional')).rejects.toMatchObject({ status: 503 });
  });
});

describe('createPayment: успех', () => {
  it('пишет и платёж, и успешную попытку', async () => {
    mockedPost.mockResolvedValue({
      data: { id: 'pay-1', confirmation: { confirmation_url: 'https://yoo/pay' } },
    });
    const { svc, queries } = makeService();

    const out = await svc.createPayment('79030169187', 1990, 'professional');

    expect(out).toMatchObject({ payment_id: 'pay-1', confirmation_url: 'https://yoo/pay' });
    expect(paymentInsert(queries)).toBeDefined();
    // Без записи успеха «три отказа подряд» не отличить от трёх отказов,
    // размазанных по месяцу вперемешку с успехами.
    expect(attemptInsert(queries)!.params).toContain(true);
  });
});
