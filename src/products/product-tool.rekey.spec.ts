import { ConflictException } from '@nestjs/common';
import { ProductToolService } from './product-tool.service';
import { REKEY_REFUSAL } from './turns.service';

const PRODUCT = { id: 'p1', name: 'Магазин', slug: 'magazin', domain: null, kind: 'bot', status: 'running' };

describe('отказ правке во время смены ключей — ассистенту свой reason', () => {
  it('reason rekeying, без предложения пополнить', async () => {
    const pg = { query: jest.fn(async (sql: string) => (sql.includes('FROM products') ? { rows: [PRODUCT] } : { rows: [] })) };
    const turns = { enqueue: jest.fn(async () => { throw new ConflictException(REKEY_REFUSAL); }) };
    const svc = new ProductToolService(pg as any, turns as any, {} as any);
    const r: any = await svc.execute('u1', { action: 'edit', product: 'Магазин', prompt: 'поменяй приветствие' });
    expect(r).toMatchObject({ ok: false, reason: 'rekeying', canTopUp: false });
    expect(r.say).toMatch(/через пару минут/);
    // Приписка к константе не повторяет её же «через пару минут» — у неё
    // своё продолжение: что делать (status) и что не поможет (пополнение).
    expect(r.say).toMatch(/действие status/);
    expect(r.say).toMatch(/пополнение не поможет/);
  });
});
