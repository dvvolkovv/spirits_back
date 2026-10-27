import { ProductActionsController } from './product-actions.controller';

const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

describe('отправка карточки ключей', () => {
  it('set и remove уходят в сервис ключей; ответ — вид без значений', async () => {
    const row = { id: ID, user_id: 'u1', product_id: 'p1', kind: 'keys', status: 'pending', channel: 'web', confirmed_via: null,
      payload: { keyNames: ['A'] }, result: null, created_at: new Date(), expires_at: new Date(Date.now() + 60_000),
      resolved_at: null, tg_chat_id: null, tg_message_id: null, product_name: 'Бот' };
    const actions = { get: jest.fn(async () => row) };
    const keys = { complete: jest.fn(async () => ({ ok: true, queued: true })) };
    const limiter = { check: jest.fn(async () => undefined) };
    const ctrl = new ProductActionsController(actions as any, {} as any, limiter as any, keys as any);
    const out = await ctrl.submit({ userId: 'u1' }, ID, { set: { B: 'секрет-значение' }, remove: ['A'], via: 'chat' } as any);
    expect(keys.complete).toHaveBeenCalledWith({ userId: 'u1', actionId: ID, set: { B: 'секрет-значение' }, remove: ['A'], via: 'chat' });
    expect(JSON.stringify(out)).not.toContain('секрет-значение');
  });
});
