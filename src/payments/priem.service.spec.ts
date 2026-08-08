import { createHmac } from 'node:crypto';
import { PriemService } from './priem.service';

/**
 * Подпись коллбэка — единственное, что отличает настоящее «оплачено» от
 * подделанного: обработчик публичный, без JWT, и по нему начисляются токены.
 *
 * Отдельно проверяется то, о чём предупреждает документация «Приёма»: подпись
 * считается по СЫРЫМ байтам. Разобрать JSON и собрать обратно нельзя — порядок
 * ключей и пробелы изменятся. Тест ниже это воспроизводит.
 */

const SECRET = 'whsec-test-секрет';

function sign(rawBody: string, timestamp: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex');
}

const nowTs = () => String(Math.floor(Date.now() / 1000));

function makeService(rows: any[] = []) {
  const queries: { sql: string; params: any[] }[] = [];
  const pg = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      queries.push({ sql, params });
      if (/SELECT user_id, status FROM payments/.test(sql)) return { rows };
      return { rows: [] };
    }),
  };
  const payments = { processSucceededPayment: jest.fn(async () => {}) };
  const svc = new PriemService(pg as any, payments as any);
  return { svc, payments, queries };
}

describe('PriemService.verifySignature', () => {
  const OLD = process.env.PRIEM_WEBHOOK_SECRET;
  beforeAll(() => { process.env.PRIEM_WEBHOOK_SECRET = SECRET; });
  afterAll(() => { process.env.PRIEM_WEBHOOK_SECRET = OLD; });

  const body = '{"event":"payment.settled","paymentId":"p-1","state":"settled","amount":"25.00"}';

  it('принимает подлинную подпись', () => {
    const { svc } = makeService();
    const ts = nowTs();
    expect(svc.verifySignature(Buffer.from(body), ts, sign(body, ts))).toBe(true);
  });

  it('отвергает подделанное тело', () => {
    const { svc } = makeService();
    const ts = nowTs();
    const signature = sign(body, ts);
    // Злоумышленник поднял сумму, подпись оставил прежней.
    const tampered = body.replace('"25.00"', '"9999.00"');
    expect(svc.verifySignature(Buffer.from(tampered), ts, signature)).toBe(false);
  });

  it('отвергает подпись чужим секретом', () => {
    const { svc } = makeService();
    const ts = nowTs();
    expect(svc.verifySignature(Buffer.from(body), ts, sign(body, ts, 'не-тот-секрет'))).toBe(false);
  });

  it('отвергает старую подпись — это повтор перехваченного запроса', () => {
    const { svc } = makeService();
    const old = String(Math.floor(Date.now() / 1000) - 600); // 10 минут назад
    expect(svc.verifySignature(Buffer.from(body), old, sign(body, old))).toBe(false);
  });

  it('отвергает подпись из будущего', () => {
    const { svc } = makeService();
    const future = String(Math.floor(Date.now() / 1000) + 600);
    expect(svc.verifySignature(Buffer.from(body), future, sign(body, future))).toBe(false);
  });

  it('отвергает запрос без заголовков', () => {
    const { svc } = makeService();
    const ts = nowTs();
    expect(svc.verifySignature(Buffer.from(body), undefined, sign(body, ts))).toBe(false);
    expect(svc.verifySignature(Buffer.from(body), ts, undefined)).toBe(false);
  });

  it('пересобранный JSON подпись НЕ проходит — считать нужно по сырым байтам', () => {
    // Ровно та ошибка, о которой предупреждает документация: тело разобрали
    // до проверки. JSON.stringify(JSON.parse(x)) меняет пробелы, и HMAC другой.
    const { svc } = makeService();
    // Тело с отступами — так его и присылают. Компактный JSON без пробелов
    // пересобрался бы байт-в-байт, и проверка оказалась бы пустой.
    const pretty = JSON.stringify(JSON.parse(body), null, 2);
    const ts = nowTs();
    const signature = sign(pretty, ts);
    const reserialized = JSON.stringify(JSON.parse(pretty));

    expect(reserialized).not.toBe(pretty); // предпосылка: пересборка что-то меняет
    expect(svc.verifySignature(reserialized, ts, signature)).toBe(false);
    expect(svc.verifySignature(Buffer.from(pretty), ts, signature)).toBe(true);
  });
});

describe('PriemService.handleCallback', () => {
  it('зачисляет только по settled', async () => {
    const { svc, payments } = makeService([{ user_id: 'u1', status: 'pending' }]);
    expect(await svc.handleCallback({ paymentId: 'p-1', state: 'settled' })).toBe(true);
    expect(payments.processSucceededPayment).toHaveBeenCalledWith('p-1', 'u1');
  });

  it.each(['created', 'awaiting_payment', 'detected', 'confirming', 'converting', 'underpaid', 'expired', 'failed'])(
    'не зачисляет в состоянии %s',
    async (state) => {
      const { svc, payments } = makeService([{ user_id: 'u1', status: 'pending' }]);
      expect(await svc.handleCallback({ paymentId: 'p-1', state })).toBe(false);
      expect(payments.processSucceededPayment).not.toHaveBeenCalled();
    },
  );

  it('повтор по уже зачисленному платежу не зачисляет второй раз', async () => {
    const { svc, payments } = makeService([{ user_id: 'u1', status: 'succeeded' }]);
    expect(await svc.handleCallback({ paymentId: 'p-1', state: 'settled' })).toBe(true);
    expect(payments.processSucceededPayment).not.toHaveBeenCalled();
  });

  it('неизвестный платёж не зачисляется', async () => {
    const { svc, payments } = makeService([]);
    expect(await svc.handleCallback({ paymentId: 'чужой', state: 'settled' })).toBe(false);
    expect(payments.processSucceededPayment).not.toHaveBeenCalled();
  });

  it('коллбэк без paymentId игнорируется', async () => {
    const { svc, payments } = makeService([{ user_id: 'u1', status: 'pending' }]);
    expect(await svc.handleCallback({ state: 'settled' })).toBe(false);
    expect(payments.processSucceededPayment).not.toHaveBeenCalled();
  });

  it('ищет платёж только среди своих, не задевая YooKassa', async () => {
    const { svc, queries } = makeService([{ user_id: 'u1', status: 'pending' }]);
    await svc.handleCallback({ paymentId: 'p-1', state: 'settled' });
    const sel = queries.find((q) => /SELECT user_id, status FROM payments/.test(q.sql));
    expect(sel!.sql).toMatch(/provider = 'priem'/);
  });
});

describe('PriemService.packages', () => {
  it('не содержит пакетов дешевле $10 — на них комиссия сети непозволительна', () => {
    const { svc } = makeService();
    for (const p of svc.packages()) {
      expect(p.usd).toBeGreaterThanOrEqual(10);
    }
  });
});
