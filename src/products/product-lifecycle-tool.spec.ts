import { HttpException } from '@nestjs/common';
import { ProductToolService } from './product-tool.service';
import { ProductLifecycleTool } from './product-lifecycle-tool';
import { SLEEPING_REFUSAL } from './turns.service';

const PRODUCT = { id: 'p1', name: 'Магазин', slug: 'magazin', domain: 'magazin.c.linkeon.io', kind: 'site', status: 'running' };

function harness() {
  const pg = {
    query: jest.fn(async (sql: string) => {
      if (sql.includes('archived_at IS NOT NULL') && sql.includes('purge_after > now()')) {
        return { rows: [{ id: 'p9', name: 'Старый бот', slug: 'old', kind: 'bot', purge_after: '2026-11-24T10:00:00.000Z' }] };
      }
      if (sql.includes('FROM products')) return { rows: [PRODUCT] };
      if (sql.includes('FROM product_turns')) return { rows: [{ id: 't-rev', status: 'done', result: 'ok', error: null, tokens_spent: '10' }] };
      return { rows: [] };
    }),
  };
  const lifecycle = {
    createSite: jest.fn(async () => ({ ok: true, productId: 'p-new', slug: 'magazin', domain: 'magazin.c.linkeon.io' })),
    openCreateBot: jest.fn(async () => ({ ok: true, actionId: 'a1', expiresAt: '2026-10-25T10:30:00.000Z' })),
    openDelete: jest.fn(async () => ({ ok: true, actionId: 'a2', expiresAt: '2026-10-25T10:30:00.000Z' })),
    restore: jest.fn(async () => ({ ok: true, status: 'sleeping', waking: true })),
    revert: jest.fn(async () => ({ ok: true, turnId: 't-rev' })),
  };
  const actions = { get: jest.fn(async () => null) };
  const tool = new ProductLifecycleTool(pg as any, lifecycle as any, actions as any);
  const svc = new ProductToolService(pg as any, { enqueue: jest.fn() } as any, {} as any, tool);
  (svc as any).waitMs = 0;
  return { svc, lifecycle, actions };
}

describe('новые действия инструмента', () => {
  it('create site — сразу, без карточки', async () => {
    const h = harness();
    const r = await h.svc.execute('u1', { action: 'create', kind: 'site', name: 'Магазин', prompt: 'лендинг' }, 'web', 'turn-1');
    expect(r).toMatchObject({ ok: true, created: { kind: 'site', productId: 'p-new' } });
    expect(h.lifecycle.createSite).toHaveBeenCalledWith({ userId: 'u1', name: 'Магазин', prompt: 'лендинг', channel: 'web' });
  });

  it('create bot — карточка с меткой хода, ключи не просить', async () => {
    const h = harness();
    const r = await h.svc.execute('u1', { action: 'create', kind: 'bot', name: 'Бот' }, 'web', 'turn-1');
    expect(r).toMatchObject({ ok: true, pending: { actionId: 'a1', kind: 'create_bot' } });
    expect(h.lifecycle.openCreateBot).toHaveBeenCalledWith(expect.objectContaining({ turn: 'turn-1', channel: 'web' }));
    expect(r.say).toMatch(/не проси/);
  });

  it('create без вида — подсказка', async () => {
    expect(await harness().svc.execute('u1', { action: 'create', name: 'X' })).toMatchObject({ ok: false, reason: 'bad_kind' });
  });

  it('delete — карточка, «удалил» до done не говорить', async () => {
    const h = harness();
    const r = await h.svc.execute('u1', { action: 'delete', product: 'магазин' }, 'telegram', 't');
    expect(r).toMatchObject({ ok: true, pending: { kind: 'delete' }, product: PRODUCT });
    expect(h.lifecycle.openDelete).toHaveBeenCalledWith({ userId: 'u1', productId: 'p1', channel: 'telegram', turn: 't' });
    expect(r.say).toMatch(/ниже придёт сообщение/i);
    expect(r.say).toMatch(/Не говори «удалил»/);
  });

  it('restore — по удалённым', async () => {
    const h = harness();
    const r = await h.svc.execute('u1', { action: 'restore', product: 'старый' });
    expect(r).toMatchObject({ ok: true, restored: { status: 'sleeping', waking: true } });
    expect(h.lifecycle.restore).toHaveBeenCalledWith({ userId: 'u1', productId: 'p9', channel: 'web' });
  });

  it('revert — исход отката, как у правки, плюс пометка «это был откат»', async () => {
    const h = harness();
    const r = await h.svc.execute('u1', { action: 'revert', product: 'магазин' }, 'web');
    expect(r).toMatchObject({ outcome: 'done', turnId: 't-rev', product: PRODUCT });
    expect(r.say).toMatch(/Это был откат: продукт вернулся к версии до выбранной правки\./);
  });

  it('revert — отказ очереди правок (сон) превращается в reason="sleeping", а не бросается наружу', async () => {
    const pg = { query: jest.fn(async (sql: string) => (sql.includes('FROM products') ? { rows: [PRODUCT] } : { rows: [] })) };
    const lifecycle = { revert: jest.fn(async () => { throw new HttpException(SLEEPING_REFUSAL, 402); }) };
    const actions = { get: jest.fn(async () => null) };
    const tool = new ProductLifecycleTool(pg as any, lifecycle as any, actions as any);
    const svc = new ProductToolService(pg as any, { enqueue: jest.fn() } as any, {} as any, tool);
    const r: any = await svc.execute('u1', { action: 'revert', product: 'магазин' });
    expect(r).toMatchObject({ ok: false, reason: 'sleeping', product: PRODUCT });
  });

  it('delete — несколько совпадений под описанием: reason="ambiguous", карточка не заводится', async () => {
    const pg = { query: jest.fn(async (sql: string) => (sql.includes('FROM products') ? { rows: [PRODUCT, { ...PRODUCT, id: 'p2' }] } : { rows: [] })) };
    const lifecycle = { openDelete: jest.fn() };
    const actions = { get: jest.fn(async () => null) };
    const tool = new ProductLifecycleTool(pg as any, lifecycle as any, actions as any);
    const svc = new ProductToolService(pg as any, { enqueue: jest.fn() } as any, {} as any, tool);
    const r: any = await svc.execute('u1', { action: 'delete', product: 'магазин' });
    expect(r).toMatchObject({ ok: false, reason: 'ambiguous' });
    expect(lifecycle.openDelete).not.toHaveBeenCalled();
  });

  it('delete — ни одного совпадения: reason="not_found"', async () => {
    const pg = { query: jest.fn(async () => ({ rows: [] })) };
    const lifecycle = { openDelete: jest.fn() };
    const actions = { get: jest.fn(async () => null) };
    const tool = new ProductLifecycleTool(pg as any, lifecycle as any, actions as any);
    const svc = new ProductToolService(pg as any, { enqueue: jest.fn() } as any, {} as any, tool);
    const r: any = await svc.execute('u1', { action: 'delete', product: 'несуществующий' });
    expect(r).toMatchObject({ ok: false, reason: 'not_found' });
    expect(lifecycle.openDelete).not.toHaveBeenCalled();
  });

  it('restore — ни одного совпадения среди удалённых: reason="not_found" и список deleted', async () => {
    const pg = {
      query: jest.fn(async (sql: string) => {
        // resolveDeleted (поиск по описанию) — своя ветка, отличимая по LIKE;
        // listDeleted (запасной список в ответе) должна остаться с одной строкой.
        if (sql.includes('lower(name) LIKE')) return { rows: [] };
        if (sql.includes('archived_at IS NOT NULL') && sql.includes('purge_after > now()')) {
          return { rows: [{ id: 'p9', name: 'Старый бот', slug: 'old', kind: 'bot', purge_after: '2026-11-24T10:00:00.000Z' }] };
        }
        return { rows: [] };
      }),
    };
    const lifecycle = { restore: jest.fn() };
    const actions = { get: jest.fn(async () => null) };
    const tool = new ProductLifecycleTool(pg as any, lifecycle as any, actions as any);
    const svc = new ProductToolService(pg as any, { enqueue: jest.fn() } as any, {} as any, tool);
    const r: any = await svc.execute('u1', { action: 'restore', product: 'несуществующий' });
    expect(r).toMatchObject({ ok: false, reason: 'not_found' });
    expect(r.deleted).toEqual([{ id: 'p9', name: 'Старый бот', slug: 'old', kind: 'bot', purge_after: '2026-11-24T10:00:00.000Z' }]);
    expect(lifecycle.restore).not.toHaveBeenCalled();
  });

  it('create bot — канал telegram: карточка приходит отдельным сообщением', async () => {
    const h = harness();
    const r = await h.svc.execute('u1', { action: 'create', kind: 'bot', name: 'Бот' }, 'telegram', 'turn-1');
    expect(r.say).toMatch(/Ниже придёт сообщение/);
  });

  it('status по actionId — вид действия', async () => {
    const h = harness();
    h.actions.get.mockResolvedValue({ id: 'a2', user_id: 'u1', product_id: 'p1', kind: 'delete', status: 'done', channel: 'web', confirmed_via: 'chat', payload: {}, result: { restoreUntil: '2026-11-24T10:00:00.000Z' }, created_at: new Date(), expires_at: new Date(Date.now() + 60_000), resolved_at: new Date(), tg_chat_id: null, tg_message_id: null, product_name: 'Магазин', purge_after: null } as any);
    const r = await h.svc.execute('u1', { action: 'status', actionId: 'a2' });
    expect(r).toMatchObject({ ok: true, action: { status: 'done', restoreUntil: '2026-11-24T10:00:00.000Z' } });
  });

  it('status — pending/working тоже ok:true: карточка только что заведена, это не отказ', async () => {
    const h = harness();
    for (const status of ['pending', 'working'] as const) {
      h.actions.get.mockResolvedValue({ id: 'a3', user_id: 'u1', product_id: null, kind: 'create_bot', status, channel: 'web', confirmed_via: null, payload: {}, result: {}, created_at: new Date(), expires_at: new Date(Date.now() + 60_000), resolved_at: null, tg_chat_id: null, tg_message_id: null, product_name: null, purge_after: null } as any);
      const r: any = await h.svc.execute('u1', { action: 'status', actionId: 'a3' });
      expect(r.ok).toBe(true);
    }
  });

  it('status — failed/expired/cancelled остаются ok:false', async () => {
    const h = harness();
    for (const status of ['failed', 'expired', 'cancelled'] as const) {
      h.actions.get.mockResolvedValue({ id: 'a4', user_id: 'u1', product_id: null, kind: 'create_bot', status, channel: 'web', confirmed_via: null, payload: {}, result: {}, created_at: new Date(), expires_at: new Date(Date.now() - 1), resolved_at: null, tg_chat_id: null, tg_message_id: null, product_name: null, purge_after: null } as any);
      const r: any = await h.svc.execute('u1', { action: 'status', actionId: 'a4' });
      expect(r.ok).toBe(false);
    }
  });

  it('status — удаление done называет дату возврата и действие restore', async () => {
    const h = harness();
    const restoreUntil = '2026-11-24T10:00:00.000Z';
    h.actions.get.mockResolvedValue({ id: 'a5', user_id: 'u1', product_id: 'p1', kind: 'delete', status: 'done', channel: 'web', confirmed_via: 'chat', payload: {}, result: { restoreUntil }, created_at: new Date(), expires_at: new Date(Date.now() + 60_000), resolved_at: new Date(), tg_chat_id: null, tg_message_id: null, product_name: 'Магазин', purge_after: null } as any);
    const r: any = await h.svc.execute('u1', { action: 'status', actionId: 'a5' });
    const date = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' }).format(new Date(restoreUntil));
    expect(r.say).toBe(`Готово: продукт удалён, вернуть его можно до ${date} — действием restore.`);
  });

  it('list — с удалёнными, которые можно вернуть', async () => {
    const r = await harness().svc.execute('u1', { action: 'list' });
    expect(r.deleted).toEqual([{ id: 'p9', name: 'Старый бот', slug: 'old', kind: 'bot', purge_after: '2026-11-24T10:00:00.000Z' }]);
  });
});
