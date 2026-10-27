import { ProductToolService } from './product-tool.service';

/**
 * Задача бэклога 642c5198, действие edit: ключи скрывает TurnsService.enqueue
 * (turns.enqueue.spec.ts), а инструмент обязан ДОНЕСТИ это до ассистента —
 * иначе тот скажет «поправил» про правку, в которой ключа уже нет, и человек
 * будет ждать, что ключ применён.
 */
const PRODUCT = { id: 'p1', name: 'Магазин', slug: 'magazin', domain: 'magazin.c.linkeon.io', kind: 'site', status: 'running' };

function harness(enqueued: any) {
  const pg = {
    query: jest.fn(async (sql: string) => {
      if (sql.includes('FROM products')) return { rows: [PRODUCT] };
      if (sql.includes('FROM product_turns')) return { rows: [{ id: 't-1', status: 'done', result: 'ok', error: null, tokens_spent: '12' }] };
      return { rows: [] };
    }),
  };
  const turns = { enqueue: jest.fn(async () => enqueued) };
  const svc = new ProductToolService(pg as any, turns as any, {} as any);
  (svc as any).waitMs = 0;
  return { svc, turns };
}

describe('manage_product edit: скрытые ключи', () => {
  it('исход правки сохраняется, к нему — secretsMasked и фраза для человека', async () => {
    const { svc } = harness({ id: 't-1', status: 'queued', masked: { count: 2, names: ['A_KEY', 'B_TOKEN'] } });
    const r: any = await svc.execute('u1', { action: 'edit', product: 'Магазин', prompt: 'что угодно' }, 'web');
    expect(r).toMatchObject({ ok: true, outcome: 'done', turnId: 't-1', product: PRODUCT });
    expect(r.secretsMasked).toEqual({ count: 2, names: ['A_KEY', 'B_TOKEN'] });
    expect(r.say).toMatch(/^Правка применена\. Списано за ход: 12 токенов\. /);
    expect(r.say).toContain('(A_KEY, B_TOKEN)');
    expect(r.say).toMatch(/выпустить новый ключ/);
  });

  it('без маски — ответ как прежде', async () => {
    const { svc } = harness({ id: 't-1', status: 'queued' });
    const r: any = await svc.execute('u1', { action: 'edit', product: 'Магазин', prompt: 'что угодно' }, 'web');
    expect('secretsMasked' in r).toBe(false);
    expect(r.say).toBe('Правка применена. Списано за ход: 12 токенов.');
  });
});
