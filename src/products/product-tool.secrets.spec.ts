import { BadRequestException, ConflictException } from '@nestjs/common';
import { ProductToolService } from './product-tool.service';
import { PROMPT_TOO_LONG, REKEY_REFUSAL } from './turns.service';

/**
 * Задача бэклога 642c5198, действие edit: ключи скрывает TurnsService.enqueue
 * (turns.enqueue.spec.ts), а инструмент обязан ДОНЕСТИ это до ассистента —
 * иначе тот скажет «поправил» про правку, в которой ключа уже нет, и человек
 * будет ждать, что ключ применён. Маску инструмент считает сам из того же
 * текста — поэтому знает о ней и при отказе правки.
 *
 * Значения собираются во время прогона — см. шапку prompt-secrets.spec.ts.
 */
const PRODUCT = { id: 'p1', name: 'Магазин', slug: 'magazin', domain: 'magazin.c.linkeon.io', kind: 'site', status: 'running' };
const A = ['Ab', '3k', 'Q9', 'zX', '7mN', 'p2R'].join('');
const B = ['Zq', '8w', 'L1', 'mN', '4tR', 'x9K'].join('');
const PROMPT = `подключи погоду A_KEY=${A} и бота B_TOKEN=${B}`;

function harness(enqueue: () => Promise<any>) {
  const pg = {
    query: jest.fn(async (sql: string) => {
      if (sql.includes('FROM products')) return { rows: [PRODUCT] };
      if (sql.includes('FROM product_turns')) return { rows: [{ id: 't-1', status: 'done', result: 'ok', error: null, tokens_spent: '12' }] };
      return { rows: [] };
    }),
  };
  const turns = { enqueue: jest.fn(enqueue) };
  const svc = new ProductToolService(pg as any, turns as any, {} as any);
  (svc as any).waitMs = 0;
  return { svc, turns };
}

describe('manage_product edit: скрытые ключи', () => {
  it('исход правки сохраняется, к нему — secretsMasked и фраза для человека', async () => {
    const { svc } = harness(async () => ({ id: 't-1', status: 'queued', masked: { count: 2, names: ['A_KEY', 'B_TOKEN'] } }));
    const r: any = await svc.execute('u1', { action: 'edit', product: 'Магазин', prompt: PROMPT }, 'web');
    expect(r).toMatchObject({ ok: true, outcome: 'done', turnId: 't-1', product: PRODUCT });
    expect(r.secretsMasked).toEqual({ count: 2, names: ['A_KEY', 'B_TOKEN'] });
    expect(r.say).toMatch(/^Правка применена\. Списано за ход: 12 токенов\. /);
    expect(r.say).toContain('(A_KEY, B_TOKEN)');
    expect(r.say).toMatch(/Если это ключ — посоветуй выпустить новый/);
  });

  it('отказ правки (смена ключей) — о ключах всё равно сказано, без «заменила»', async () => {
    const { svc } = harness(async () => { throw new ConflictException(REKEY_REFUSAL); });
    const r: any = await svc.execute('u1', { action: 'edit', product: 'Магазин', prompt: PROMPT }, 'web');
    expect(r).toMatchObject({ ok: false, reason: 'rekeying', secretsMasked: { count: 2, names: ['A_KEY', 'B_TOKEN'] } });
    expect(r.say).toMatch(/правка не поставлена/);
    expect(r.say).not.toContain('заменила');
  });

  it('слишком длинный текст — своя причина и совет сократить', async () => {
    const { svc } = harness(async () => { throw new BadRequestException(PROMPT_TOO_LONG); });
    const r: any = await svc.execute('u1', { action: 'edit', product: 'Магазин', prompt: 'а'.repeat(32_001) }, 'web');
    expect(r).toMatchObject({ ok: false, reason: 'too_long' });
    expect(r.say).toMatch(/Сократи текст правки/);
    expect('secretsMasked' in r).toBe(false);
  });

  it('без ключей — ответ как прежде', async () => {
    const { svc } = harness(async () => ({ id: 't-1', status: 'queued' }));
    const r: any = await svc.execute('u1', { action: 'edit', product: 'Магазин', prompt: 'поправь футер' }, 'web');
    expect('secretsMasked' in r).toBe(false);
    expect(r.say).toBe('Правка применена. Списано за ход: 12 токенов.');
  });
});
