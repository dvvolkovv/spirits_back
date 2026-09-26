import { ProductToolService } from './product-tool.service';

/**
 * Канал хода правки (web / telegram) приезжает в инструмент из подписи токена
 * — точка /webhook/mcp/products разбирает его и передаёт третьим аргументом.
 * До этой правки edit писал в product_turns 'web' всегда: правка, поставленная
 * из Telegram-бота, в истории продукта выглядела бы веб-правкой.
 *
 * Postgres здесь подменён: проверяется только, с каким каналом ставится ход.
 * Сама постановка против живой базы — в product-tool.spec.ts.
 */

const OWNER = '79030169187';
const PRODUCT = { id: 'p-1', name: 'Магазин цветов', slug: 'flowers', domain: null, kind: 'site', status: 'running' };

function make() {
  const pg = {
    query: jest.fn(async (sql: string) => {
      // Порядок проверок важен: 'FROM product_turns' не содержит 'FROM products'.
      if (sql.includes('FROM product_turns')) {
        return { rows: [{ id: 't-1', status: 'done', result: 'ok', error: null, tokens_spent: '120' }] };
      }
      if (sql.includes('FROM products')) return { rows: [PRODUCT] };
      return { rows: [] };
    }),
  };
  const turns = { enqueue: jest.fn(async (_input: any) => ({ id: 't-1' })) };
  const svc = new ProductToolService(pg as any, turns as any, {} as any);
  (svc as any).waitMs = 0;
  return { svc, turns };
}

describe('канал хода правки', () => {
  it('правка из Telegram ставится с channel=telegram', async () => {
    const { svc, turns } = make();
    const out: any = await svc.execute(OWNER, { action: 'edit', product: 'цветов', prompt: 'Добавь «О нас»' }, 'telegram');
    expect(out.outcome).toBe('done');
    expect(turns.enqueue).toHaveBeenCalledTimes(1);
    expect(turns.enqueue.mock.calls[0][0]).toMatchObject({ productId: 'p-1', userId: OWNER, channel: 'telegram' });
  });

  it('правка из веба ставится с channel=web', async () => {
    const { svc, turns } = make();
    await svc.execute(OWNER, { action: 'edit', product: 'цветов', prompt: 'Добавь «О нас»' }, 'web');
    expect(turns.enqueue.mock.calls[0][0].channel).toBe('web');
  });

  // Прежние вызовы (и любой, кто не знает про канал) — это веб, как и было.
  it('без канала — web, как до правки', async () => {
    const { svc, turns } = make();
    await svc.execute(OWNER, { action: 'edit', product: 'цветов', prompt: 'Добавь «О нас»' });
    expect(turns.enqueue.mock.calls[0][0].channel).toBe('web');
  });

  // Канал — не поле запроса: модель, написавшая channel в аргументах, его не меняет.
  it('channel в аргументах инструмента не переопределяет канал из токена', async () => {
    const { svc, turns } = make();
    await svc.execute(OWNER, { action: 'edit', product: 'цветов', prompt: 'x', channel: 'telegram' }, 'web');
    expect(turns.enqueue.mock.calls[0][0].channel).toBe('web');
  });
});
