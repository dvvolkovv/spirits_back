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

/**
 * Опрос висящих платежей — страховка на случай, когда коллбэк не дошёл.
 * Заведена по факту: 2026-08-08 платёж дошёл у «Приёма» до settled, а коллбэк
 * не пришёл ни разу. Без опроса такой платёж висит в pending, пока кто-то не
 * заметит руками.
 */
describe('PriemService.pollPendingPayments', () => {
  const OLD_KEY = process.env.PRIEM_API_KEY;
  beforeAll(() => { process.env.PRIEM_API_KEY = 'priem_test'; });
  afterAll(() => { process.env.PRIEM_API_KEY = OLD_KEY; });

  function harness(pendingRows: { payment_id: string }[]) {
    const queries: { sql: string; params: any[] }[] = [];
    const pg = {
      query: jest.fn(async (sql: string, params: any[] = []) => {
        queries.push({ sql, params });
        if (/SELECT payment_id FROM payments/.test(sql)) return { rows: pendingRows };
        return { rows: [] };
      }),
    };
    const svc = new PriemService(pg as any, { processSucceededPayment: jest.fn() } as any);
    return { svc, queries, pg };
  }

  it('не опрашивает строки, где создание в «Приёме» не удалось', async () => {
    // У таких payment_id так и остался нашим ключом идемпотентности —
    // платежа на их стороне не существует, спрашивать не о чем.
    const { svc, queries } = harness([]);
    await svc.pollPendingPayments();

    const sel = queries.find((q) => /SELECT payment_id FROM payments/.test(q.sql));
    expect(sel!.sql).toMatch(/NOT LIKE 'linkeon-%'/);
    expect(sel!.sql).toMatch(/provider = 'priem'/);
    expect(sel!.sql).toMatch(/status = 'pending'/);
  });

  it('опрашивает каждый висящий платёж', async () => {
    const { svc } = harness([{ payment_id: 'a' }, { payment_id: 'b' }]);
    const sync = jest.spyOn(svc, 'syncPayment').mockResolvedValue('confirming');
    await svc.pollPendingPayments();

    expect(sync).toHaveBeenCalledTimes(2);
    expect(sync).toHaveBeenCalledWith('a');
    expect(sync).toHaveBeenCalledWith('b');
  });

  it('помечает failed те, что уже не оплатят — иначе опрос вечен', async () => {
    const { svc, queries } = harness([{ payment_id: 'protuh' }]);
    jest.spyOn(svc, 'syncPayment').mockResolvedValue('expired');
    await svc.pollPendingPayments();

    const upd = queries.find((q) => /UPDATE payments SET status = 'failed'/.test(q.sql));
    expect(upd).toBeDefined();
    expect(upd!.params).toContain('protuh');
  });

  it('не помечает failed те, что ещё в пути', async () => {
    const { svc, queries } = harness([{ payment_id: 'v-puti' }]);
    jest.spyOn(svc, 'syncPayment').mockResolvedValue('converting');
    await svc.pollPendingPayments();

    expect(queries.find((q) => /UPDATE payments SET status = 'failed'/.test(q.sql))).toBeUndefined();
  });

  it('сбой опроса одного платежа не срывает остальные', async () => {
    const { svc } = harness([{ payment_id: 'a' }, { payment_id: 'b' }]);
    const sync = jest.spyOn(svc, 'syncPayment')
      .mockRejectedValueOnce(new Error('сеть отвалилась'))
      .mockResolvedValueOnce('settled');
    await expect(svc.pollPendingPayments()).resolves.toBeUndefined();
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it('без ключа API не ходит в базу вовсе', async () => {
    const saved = process.env.PRIEM_API_KEY;
    delete process.env.PRIEM_API_KEY;
    const { svc, queries } = harness([{ payment_id: 'a' }]);
    await svc.pollPendingPayments();
    expect(queries).toHaveLength(0);
    process.env.PRIEM_API_KEY = saved;
  });
});
