import { ProductActionsService, toView, ACTION_TTL_MINUTES, type ActionRow } from './product-actions.service';

const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const row = (over: Partial<ActionRow> = {}): ActionRow => ({
  id: ID, user_id: 'u1', product_id: 'p1', kind: 'delete', status: 'pending', channel: 'web', confirmed_via: null,
  payload: { name: 'Магазин' }, result: null, created_at: new Date('2026-10-25T10:00:00Z'),
  expires_at: new Date('2026-10-25T10:30:00Z'), resolved_at: null, tg_chat_id: null, tg_message_id: null,
  product_name: 'Магазин', purge_after: null, ...over,
});

function make() {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const pg = { query: jest.fn(async (sql: string, params: any[] = []) => { calls.push({ sql, params }); return { rows: [], rowCount: 0 }; }) };
  return { svc: new ProductActionsService(pg as any), calls, pg };
}

describe('вид действия', () => {
  const now = new Date('2026-10-25T10:10:00Z');

  it('ожидающее после срока — expired', () => {
    expect(toView(row(), new Date('2026-10-25T10:31:00Z')).status).toBe('expired');
    expect(toView(row(), now).status).toBe('pending');
  });

  it('ожидающее удаление обещает дату возврата через 30 дней, сделанное — из итога', () => {
    expect(toView(row(), now).restoreUntil).toBe('2026-11-24T10:10:00.000Z');
    expect(toView(row({ status: 'done', result: { restoreUntil: '2026-11-24T10:12:00.000Z' } }), now).restoreUntil)
      .toBe('2026-11-24T10:12:00.000Z');
  });

  it('имена ключей — из payload, значений нет и взять неоткуда', () => {
    const v = toView(row({ kind: 'create_bot', product_id: null, product_name: null, payload: { name: 'Бот', keyNames: ['A'] } }), now);
    expect(v).toMatchObject({ productName: 'Бот', keyNames: ['A'], productId: null });
  });

  it('вид продукта — из payload; у карточки бота — всегда bot', () => {
    expect(toView(row({ payload: { productKind: 'site' } }), now).productKind).toBe('site');
    expect(toView(row({ kind: 'create_bot', payload: {} }), now).productKind).toBe('bot');
    expect(toView(row({ payload: {} }), now).productKind).toBeNull();
  });
});

describe('ProductActionsService', () => {
  it('open — ожидающее с меткой хода и сроком', async () => {
    const h = make();
    // mockResolvedValueOnce тут не годится: он подменяет саму реализацию мока,
    // поэтому пуш в h.calls (часть базовой реализации) для этого вызова не
    // происходит — calls[0] остаётся undefined. mockImplementationOnce делает
    // то же самое (отдаёт нужную строку из RETURNING), но не глушит запись вызова.
    h.pg.query.mockImplementationOnce(async (sql: string, params: any[] = []) => {
      h.calls.push({ sql, params });
      return { rows: [{ id: ID, expires_at: new Date('2026-10-25T10:30:00Z') }], rowCount: 1 } as any;
    });
    const r = await h.svc.open({ userId: 'u1', productId: null, kind: 'create_bot', channel: 'web', turn: 't-1', payload: { name: 'Бот' } });
    expect(r).toEqual({ id: ID, expiresAt: '2026-10-25T10:30:00.000Z' });
    expect(h.calls[0].sql).toMatch(/'pending'/);
    expect(h.calls[0].params).toEqual(['u1', null, 'create_bot', 'web', 't-1', JSON.stringify({ name: 'Бот' }), ACTION_TTL_MINUTES]);
  });

  it('claim и get с не-uuid не ходят в базу', async () => {
    const h = make();
    expect(await h.svc.claim('u1', 'nope', 'chat')).toBeNull();
    expect(await h.svc.get('u1', 'nope')).toBeNull();
    expect(h.pg.query).not.toHaveBeenCalled();
  });

  it('release и finish с не-uuid id не ходят в базу', async () => {
    const h = make();
    await h.svc.release('nope', { error: 'x' });
    await h.svc.finish('nope', 'done', {});
    expect(h.pg.query).not.toHaveBeenCalled();
  });

  it('claim — один оператор: только pending, только до срока, только свой, без шифротекста', async () => {
    const h = make();
    await h.svc.claim('u1', ID, 'cabinet');
    expect(h.calls[0].sql).toMatch(/status = 'working'/);
    expect(h.calls[0].sql).toMatch(/status = 'pending'/);
    expect(h.calls[0].sql).toMatch(/expires_at > now\(\)/);
    expect(h.calls[0].sql).not.toMatch(/RETURNING \*/);
    expect(h.calls[0].sql).not.toMatch(/secrets_box/);
    expect(h.calls[0].params).toEqual([ID, 'u1', 'cabinet']);
  });

  it('takeForTurn — по метке ИЛИ по окну хода, по порядку заведения', async () => {
    const h = make();
    // См. комментарий у теста open(): mockImplementationOnce вместо
    // mockResolvedValueOnce, иначе пуш в h.calls для этого вызова не произойдёт.
    h.pg.query.mockImplementationOnce(async (sql: string, params: any[] = []) => {
      h.calls.push({ sql, params });
      return {
        rows: [
          { id: 'b', kind: 'delete', payload: {}, created_at: new Date('2026-10-25T10:02:00Z') },
          { id: 'a', kind: 'create_bot', payload: {}, created_at: new Date('2026-10-25T10:01:00Z') },
        ], rowCount: 2,
      } as any;
    });
    const since = new Date('2026-10-25T10:00:00Z');
    const r = await h.svc.takeForTurn('u1', 't-1', since);
    expect(r.map((x) => x.id)).toEqual(['a', 'b']);
    expect(h.calls[0].sql).toMatch(/attached_at IS NULL/);
    expect(h.calls[0].sql).toMatch(/turn_nonce = \$2 OR created_at >= \$3/);
    expect(h.calls[0].sql).toMatch(/channel = \$4/);
    expect(h.calls[0].params).toEqual(['u1', 't-1', since, null]);
  });

  it('sweepStuck — только working старше 10 минут по сроку, общий текст без секретов', async () => {
    const h = make();
    const n = await h.svc.sweepStuck();
    expect(n).toBe(0); // мок отдаёт пустой RETURNING — считаем ровно по длине rows
    expect(h.calls[0].sql).toMatch(/status = 'working'/);
    expect(h.calls[0].sql).toMatch(/expires_at < now\(\) - interval '10 minutes'/);
    expect(h.calls[0].sql).toMatch(/status = 'failed'/);
    expect(h.calls[0].sql).toMatch(/Действие прервалось/);
    expect(h.calls[0].sql).not.toMatch(/BOT_TOKEN|pending/);
  });
});
