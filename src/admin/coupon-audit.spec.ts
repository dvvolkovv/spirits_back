/**
 * Кто создал купон, кто применил и кто удалил.
 *
 * Сейчас в базе нет ничего из этого: `coupons` не хранит автора, а
 * `deleteCoupon` делает голый DELETE. Из-за этого 20.08.2026 не удалось
 * выяснить ни происхождение купона id=4 (по нему пользователь получил три
 * миллиона токенов), ни кто и когда стёр раздачи 37–39 по 5 000 000 — строки
 * просто исчезли, а `coupon_redemptions` осталась ссылаться в пустоту.
 *
 * Ключевое требование к удалению: снимок кода и суммы делается ДО DELETE.
 * После него восстанавливать уже нечего — ровно так мы и потеряли историю.
 */
import { AdminService } from './admin.service';

type Q = { sql: string; params: any[] };

function makePg(rows: Record<string, any[]> = {}) {
  const queries: Q[] = [];
  const pg: any = {
    queries,
    async query(sql: string, params: any[] = []) {
      const flat = sql.replace(/\s+/g, ' ').trim();
      queries.push({ sql: flat, params });

      if (/INSERT INTO coupons/i.test(flat)) {
        return { rows: [{ id: 77, code: params[0], token_amount: params[1], created_by: params[2] }] };
      }
      if (/^SELECT .* FROM coupons WHERE id/i.test(flat)) {
        return { rows: rows.coupon ?? [{ id: 5, code: 'MARKETSEPT26', token_amount: 1000000, usage_count: 2 }] };
      }
      if (/UPDATE coupons SET/i.test(flat)) {
        return { rows: [{ id: params[params.length - 1], code: 'MARKETSEPT26', token_amount: 1000000 }] };
      }
      // Список купонов проверяем ПЕРВЫМ: он содержит подзапрос по
      // coupon_redemptions, и по общей ветке ушёл бы не туда.
      if (/FROM coupons c/i.test(flat)) return { rows: rows.coupons ?? [] };
      if (/FROM coupon_audit/i.test(flat)) return { rows: rows.audit ?? [] };
      if (/FROM coupon_redemptions/i.test(flat)) return { rows: rows.redemptions ?? [] };
      if (/FROM coupons/i.test(flat)) return { rows: rows.coupons ?? [] };
      return { rows: [] };
    },
  };
  return pg;
}

const svc = (pg: any) => new (AdminService as any)(pg);
const find = (pg: any, re: RegExp) => pg.queries.filter((q: Q) => re.test(q.sql));

describe('AdminService — аудит купонов', () => {
  it('создание запоминает автора и пишет строку аудита', async () => {
    const pg = makePg();
    await svc(pg).createCoupon('MARKETSEPT26', 1000000, '79030169187');

    const insert = find(pg, /INSERT INTO coupons/i)[0];
    expect(insert.params).toEqual(expect.arrayContaining(['MARKETSEPT26', 1000000, '79030169187']));

    const audit = find(pg, /INSERT INTO coupon_audit/i)[0];
    expect(audit).toBeDefined();
    expect(audit.params).toEqual(expect.arrayContaining(['create', '79030169187']));
  });

  it('удаление снимает копию кода ДО DELETE — иначе восстанавливать нечего', async () => {
    const pg = makePg();
    await svc(pg).deleteCoupon(5, '79030169187');

    const order = pg.queries.map((q: Q) => q.sql);
    const snapshotAt = order.findIndex((s: string) => /^SELECT .* FROM coupons WHERE id/i.test(s));
    const deleteAt = order.findIndex((s: string) => /DELETE FROM coupons/i.test(s));
    expect(snapshotAt).toBeGreaterThanOrEqual(0);
    expect(deleteAt).toBeGreaterThan(snapshotAt);

    const audit = find(pg, /INSERT INTO coupon_audit/i)[0];
    expect(audit.params).toEqual(expect.arrayContaining(['delete', '79030169187', 'MARKETSEPT26']));
  });

  it('несуществующий купон не удаляется и аудит не пишет', async () => {
    const pg = makePg({ coupon: [] });
    const res: any = await svc(pg).deleteCoupon(999, '79030169187');

    expect(res).toMatchObject({ success: false });
    expect(find(pg, /DELETE FROM coupons/i)).toHaveLength(0);
    expect(find(pg, /INSERT INTO coupon_audit/i)).toHaveLength(0);
  });

  it('изменение купона тоже попадает в аудит', async () => {
    const pg = makePg();
    await svc(pg).updateCoupon(5, { is_active: false }, '79030169187');

    const audit = find(pg, /INSERT INTO coupon_audit/i)[0];
    expect(audit.params).toEqual(expect.arrayContaining(['update', '79030169187']));
  });

  it('история купона отдаёт применения и действия администраторов', async () => {
    const pg = makePg({
      redemptions: [{ user_id: '79001234567', redeemed_at: '2026-08-18T20:38:26Z', tokens_granted: '1000000', email: 'a@b.c' }],
      audit: [{ action: 'create', actor: '79030169187', created_at: '2026-08-01T10:00:00Z', code: 'MARKETAUGUST26', details: null }],
    });
    const data: any = await svc(pg).couponHistory(40);

    expect(data.redemptions[0]).toMatchObject({ userId: '79001234567', tokens: 1000000 });
    expect(data.audit[0]).toMatchObject({ action: 'create', actor: '79030169187' });
  });

  it('история удалённого купона доступна — по снимку в аудите', async () => {
    const pg = makePg({
      coupon: [],
      redemptions: [{ user_id: '79035281880', redeemed_at: '2026-03-05T08:00:09Z', tokens_granted: '1000000', email: null }],
      audit: [{ action: 'delete', actor: 'unknown', created_at: '2026-03-06T00:00:00Z', code: 'OLD4', details: { usage_count: 3 } }],
    });
    const data: any = await svc(pg).couponHistory(4);

    expect(data.code).toBe('OLD4');
    expect(data.deleted).toBe(true);
    expect(data.redemptions).toHaveLength(1);
  });

  it('список купонов показывает автора и число применений', async () => {
    const pg = makePg({
      coupons: [{ id: 40, code: 'MARKETAUGUST26', token_amount: '1000000', usage_count: 1, created_by: '79030169187', redeemed_count: '1' }],
    });
    const list: any = await svc(pg).listCoupons();

    expect(list[0]).toMatchObject({ code: 'MARKETAUGUST26', created_by: '79030169187', redeemed_count: 1 });
  });
});
