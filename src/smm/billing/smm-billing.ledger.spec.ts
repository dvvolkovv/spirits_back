/**
 * Списание и возврат по SMM-ролику должны попадать в общий реестр.
 *
 * До 20.08.2026 обе операции меняли баланс прямым `tokens = tokens ± N` и
 * писали только в свой smm_billing_ledger. Деньги считались верно, но в
 * token_transactions следа не оставалось — «История пополнений» и прогноз
 * расхода видели неполную картину. Сверка нашла 333 тыс. таких токенов у
 * десяти пользователей.
 *
 * Проверяем не «вызвана процедура», а два свойства: баланс двигает процедура
 * (значит есть FOR UPDATE и строка в реестре) и прямого UPDATE по балансу в
 * запросах нет вовсе.
 */
import { SmmBillingService } from './smm-billing.service';
import { InsufficientTokensError } from './insufficient-tokens.error';

const DIRECT_BALANCE_WRITE = /tokens\s*=\s*tokens\s*[-+]/i;

function makeFakePg(opts: { balance: number; charge?: { user_id: string; amount: number } | null }) {
  const calls: Array<{ sql: string; params: any[] }> = [];

  const client = {
    released: false,
    async query(sql: string, params: any[] = []) {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });

      if (/FROM ai_profiles_consolidated/i.test(sql) && /FOR UPDATE/i.test(sql)) {
        return { rows: [{ tokens: opts.balance }] };
      }
      if (/FROM smm_billing_ledger/i.test(sql)) {
        return { rows: opts.charge === null ? [] : [opts.charge ?? { user_id: 'u1', amount: 15000 }] };
      }
      if (/add_user_tokens|consume_user_tokens/i.test(sql)) {
        return { rows: [{ res: { success: true, new_balance: opts.balance } }] };
      }
      return { rows: [] };
    },
    release() { this.released = true; },
  };

  return {
    calls,
    client,
    pg: { async getClient() { return client; }, async query() { return { rows: [] }; } } as any,
  };
}

const pricing = { getTariff: () => ({ tokensCost: 15000 }) } as any;

describe('SmmBillingService и общий реестр токенов', () => {
  it('списывает через consume_user_tokens, а не прямым UPDATE', async () => {
    const fake = makeFakePg({ balance: 100000 });
    const svc = new SmmBillingService(fake.pg, pricing);

    await svc.charge({ userId: 'u1', videoId: 'v1', tier: 'basic' as any });

    const consume = fake.calls.find((c) => /consume_user_tokens/i.test(c.sql));
    expect(consume).toBeDefined();
    expect(consume!.params[0]).toBe('u1');
    expect(Number(consume!.params[1])).toBe(15000);
    expect(fake.calls.some((c) => DIRECT_BALANCE_WRITE.test(c.sql))).toBe(false);
    expect(fake.calls[fake.calls.length - 1].sql).toMatch(/COMMIT/i);
    expect(fake.client.released).toBe(true);
  });

  it('при нехватке баланса не зовёт процедуру и откатывается', async () => {
    const fake = makeFakePg({ balance: 100 });
    const svc = new SmmBillingService(fake.pg, pricing);

    await expect(svc.charge({ userId: 'u1', videoId: 'v1', tier: 'basic' as any }))
      .rejects.toBeInstanceOf(InsufficientTokensError);

    expect(fake.calls.some((c) => /consume_user_tokens/i.test(c.sql))).toBe(false);
    expect(fake.calls.some((c) => /ROLLBACK/i.test(c.sql))).toBe(true);
  });

  it('возврат начисляет через add_user_tokens с типом refund', async () => {
    const fake = makeFakePg({ balance: 0, charge: { user_id: 'u7', amount: 15000 } });
    const svc = new SmmBillingService(fake.pg, pricing);

    await svc.refund({ videoId: 'v1', reason: 'render_failed' });

    const credit = fake.calls.find((c) => /add_user_tokens/i.test(c.sql));
    expect(credit).toBeDefined();
    expect(credit!.sql).toMatch(/'refund'/);
    expect(credit!.params[0]).toBe('u7');
    expect(Number(credit!.params[1])).toBe(15000);
    expect(fake.calls.some((c) => DIRECT_BALANCE_WRITE.test(c.sql))).toBe(false);
  });

  it('без исходного списания возврат ничего не начисляет', async () => {
    const fake = makeFakePg({ balance: 0, charge: null });
    const svc = new SmmBillingService(fake.pg, pricing);

    await svc.refund({ videoId: 'v1', reason: 'render_failed' });

    expect(fake.calls.some((c) => /add_user_tokens/i.test(c.sql))).toBe(false);
  });
});
