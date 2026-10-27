import { NotImplementedException } from '@nestjs/common';
import { ProductActionsController } from './product-actions.controller';

const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

/** Безликая строка — ни с чем в текстах отказов не пересекается случайно. */
const CANARY = 'CANARY-9e4f-do-not-leak';

const pendingRow = () => ({
  id: ID, user_id: 'u1', product_id: 'p1', kind: 'keys', status: 'pending', channel: 'web', confirmed_via: null,
  payload: { keyNames: ['A'] }, result: null, created_at: new Date(), expires_at: new Date(Date.now() + 60_000),
  resolved_at: null, tg_chat_id: null, tg_message_id: null, product_name: 'Бот',
});

describe('отправка карточки ключей', () => {
  it('set и remove уходят в сервис ключей; ответ — вид без значений', async () => {
    // Два РАЗНЫХ объекта на два вызова actions.get: первый — карточка до
    // отправки (её читает submit, чтобы узнать kind), второй — состояние
    // ПОСЛЕ ProductKeysService.complete (из него строится ответ). Разные
    // объекты — не совпадение: если бы submit() склеивал ответ из body
    // (а не из второго get), тест поймал бы канарейку именно здесь, а не
    // случайно прошёл бы из-за общего мока.
    const before = pendingRow();
    const after = { ...pendingRow(), status: 'working', result: null };
    const actions = { get: jest.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(after) };
    const keys = { complete: jest.fn(async () => ({ ok: true, queued: true })) };
    const limiter = { check: jest.fn(async () => undefined) };
    const ctrl = new ProductActionsController(actions as any, {} as any, limiter as any, keys as any);
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const out = await ctrl.submit({ userId: 'u1' }, ID, { set: { B: CANARY }, remove: ['A'], via: 'chat' } as any);
      // Сервис ключей ДЕЙСТВИТЕЛЬНО получил канарейку в теле — без этого
      // проверка ниже ничего не гарантирует (мог просто не дойти туда).
      expect(keys.complete).toHaveBeenCalledWith({ userId: 'u1', actionId: ID, set: { B: CANARY }, remove: ['A'], via: 'chat' });
      expect(actions.get).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(out)).not.toContain(CANARY);
      // И ничего похожего не ушло в лог (защитно: у этого контроллера своего
      // логгера нет, но регрессия могла бы его завести).
      const logged = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls].flat().map(String).join('\n');
      expect(logged).not.toContain(CANARY);
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('remove не пришёл — уходит в сервис пустым массивом, а не undefined', async () => {
    const row = pendingRow();
    const actions = { get: jest.fn(async () => row) };
    const keys = { complete: jest.fn(async () => ({ ok: true, queued: true })) };
    const limiter = { check: jest.fn(async () => undefined) };
    const ctrl = new ProductActionsController(actions as any, {} as any, limiter as any, keys as any);
    await ctrl.submit({ userId: 'u1' }, ID, { set: { B: 'x' }, via: 'chat' } as any);
    expect(keys.complete).toHaveBeenCalledWith({ userId: 'u1', actionId: ID, set: { B: 'x' }, remove: [], via: 'chat' });
  });

  it('без ProductKeysService в модуле — 501, карточка не трогается, claim не зовётся', async () => {
    // Четвёртый параметр конструктора не передан — та же форма, что у
    // @Optional-зависимости, не зарегистрированной в ProductsModule (сторож
    // регистрации — products.routes.spec.ts). claim — метод
    // ProductActionsService, который звал бы НАСТОЯЩИЙ ProductKeysService.complete;
    // здесь его вообще нет, и сам факт, что actions.claim не тронут,
    // показывает: до "забора" карточки в работу дело не дошло.
    const row = pendingRow();
    const actions = { get: jest.fn(async () => row), claim: jest.fn() };
    const limiter = { check: jest.fn(async () => undefined) };
    const ctrl = new ProductActionsController(actions as any, {} as any, limiter as any);
    await expect(ctrl.submit({ userId: 'u1' }, ID, {} as any)).rejects.toBeInstanceOf(NotImplementedException);
    expect(actions.claim).not.toHaveBeenCalled();
    expect((await actions.get('u1', ID)).status).toBe('pending');
  });
});
