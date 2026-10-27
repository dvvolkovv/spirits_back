import { ProductToolService } from './product-tool.service';
import { ProductLifecycleTool } from './product-lifecycle-tool';

const PRODUCT = { id: 'p1', name: 'Бот отчётов', slug: 'bot-otchet', domain: null, kind: 'bot', status: 'running' };

function harness(o: { gone?: 'purged' | 'expired' } = {}) {
  const pg = {
    query: jest.fn(async (sql: string) => {
      if (sql.includes('purged_at IS NOT NULL OR purge_after <= now()')) {
        return { rows: o.gone ? [{ id: 'p0', name: 'Старый сайт', slug: 'old', kind: 'site', purge_after: '2026-09-01T00:00:00.000Z',
          purged_at: o.gone === 'purged' ? '2026-09-01T01:00:00.000Z' : null }] : [] };
      }
      if (sql.includes('archived_at IS NOT NULL')) return { rows: [] };
      if (sql.includes('FROM products')) return { rows: [PRODUCT] };
      return { rows: [] };
    }),
  };
  const keysSvc = {
    open: jest.fn(async () => ({ ok: true, actionId: 'a-keys', expiresAt: '2026-10-26T10:30:00.000Z', keyNames: ['BOT_TOKEN', 'OZON_API_KEY'] })),
  };
  const actions = { get: jest.fn(async () => null) };
  const tool = new ProductLifecycleTool(pg as any, {} as any, actions as any, keysSvc as any);
  const svc = new ProductToolService(pg as any, { enqueue: jest.fn() } as any, {} as any, tool);
  return { svc, keysSvc, actions };
}

describe('действие keys', () => {
  it('открывает карточку: в ответе имена ключей, значений нет, ключи в переписке не просить', async () => {
    const h = harness();
    const r: any = await h.svc.execute('u1', { action: 'keys', product: 'бот отчётов' }, 'web', '11111111-2222-4333-8444-555555555555');
    expect(h.keysSvc.open).toHaveBeenCalledWith({ userId: 'u1', productId: 'p1', channel: 'web', turn: '11111111-2222-4333-8444-555555555555' });
    expect(r).toMatchObject({ ok: true, pending: { actionId: 'a-keys', kind: 'keys' }, keyNames: ['BOT_TOKEN', 'OZON_API_KEY'] });
    expect(r.say).toMatch(/Под твоим ответом появится защищённая карточка/);
    expect(r.say).toMatch(/в переписке ключи не проси/);
    expect(r.say).toMatch(/не говори «ключи обновлены»/);
  });

  it('в Telegram — «ниже сообщение с кнопкой»; без метки хода — кабинет', async () => {
    const h = harness();
    const tg: any = await h.svc.execute('u1', { action: 'keys', product: 'бот' }, 'telegram', '11111111-2222-4333-8444-555555555555');
    expect(tg.say).toMatch(/Ниже придёт сообщение с кнопкой/);
    const cab: any = await h.svc.execute('u1', { action: 'keys', product: 'бот' }, 'web', null);
    expect(cab.say).toMatch(/в кабинете/);
  });

  it('отказ сервиса (спит) — пересказ без карточки', async () => {
    const h = harness();
    h.keysSvc.open.mockResolvedValueOnce({ ok: false, reason: 'sleeping', message: 'Продукт спит: …' } as any);
    const r: any = await h.svc.execute('u1', { action: 'keys', product: 'бот' }, 'web', null);
    expect(r).toMatchObject({ ok: false, reason: 'sleeping' });
  });

  it('статус карточки ключей: done — «ключи обновлены», working — «перезапускается»', async () => {
    const h = harness();
    const base = { id: 'a-keys', user_id: 'u1', product_id: 'p1', kind: 'keys', channel: 'web', confirmed_via: 'chat', payload: { keyNames: [] },
      created_at: new Date(), expires_at: new Date(Date.now() + 60_000), resolved_at: null, tg_chat_id: null, tg_message_id: null, product_name: 'Бот' };
    h.actions.get.mockResolvedValueOnce({ ...base, status: 'done', result: { keyNames: ['BOT_TOKEN'] } } as any);
    expect(((await h.svc.execute('u1', { action: 'status', actionId: 'a-keys' })) as any).say).toMatch(/ключи обновлены/i);
    h.actions.get.mockResolvedValueOnce({ ...base, status: 'working', result: null } as any);
    expect(((await h.svc.execute('u1', { action: 'status', actionId: 'a-keys' })) as any).say).toMatch(/перезапускается/);
  });
});

describe('restore после срока', () => {
  it('стёртый — «уже стёрт», а не «такого нет»', async () => {
    const h = harness({ gone: 'purged' });
    const r: any = await h.svc.execute('u1', { action: 'restore', product: 'старый сайт' });
    expect(r).toMatchObject({ ok: false, reason: 'purged' });
    expect(r.say).toMatch(/уже стёрт/);
  });

  it('срок вышел, но машина ещё не стёрла — «стирается», а не «уже стёрт»', async () => {
    const h = harness({ gone: 'expired' });
    const r: any = await h.svc.execute('u1', { action: 'restore', product: 'старый сайт' });
    expect(r).toMatchObject({ ok: false, reason: 'expiring' });
    expect(r.say).toMatch(/стирается/);
    expect(r.say).not.toMatch(/уже стёрт/);
  });
});
