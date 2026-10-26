import { ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { ProductLifecycleService, DELETE_GRACE_DAYS } from './product-lifecycle.service';

const ACT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const TOKEN = '1234567890:AAH9sdfjKJHkjh34kjh5kjh6KJHkjhKJHkj';

function harness(o: { pg?: (sql: string, params: any[]) => any; createErrors?: any[]; secrets?: any } = {}) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const dispatch = async (sql: string, params: any[] = []) => {
    calls.push({ sql, params });
    const custom = o.pg?.(sql, params);
    if (custom) return custom;
    if (sql.includes('FROM ai_profiles_consolidated')) return { rows: [{ isadmin: false }] };
    if (sql.includes('SELECT domain FROM products')) return { rows: [{ domain: 'magazin.c.linkeon.io' }] };
    // Захват строки продукта в restore() (M2) — по умолчанию «всё ещё
    // архивный», раз тест не сказал обратное через свой o.pg: без этого
    // default все существующие сценарии возврата читали бы not_found.
    if (sql.includes('FOR UPDATE') && sql.includes('archived_at IS NOT NULL AND purged_at IS NULL')) {
      return { rows: [{ x: 1 }] };
    }
    return { rows: [], rowCount: 0 };
  };
  // getClient — M2: restore() ведёт транзакцию на выделенном соединении, а
  // не через пул. Клиент здесь — тот же dispatch, что у pg.query: мок видит
  // BEGIN/COMMIT/ROLLBACK (падают в общий дефолт) и реальные SQL одинаково,
  // h.calls копит и те, и эти.
  const pg = {
    query: jest.fn((sql: string, params: any[] = []) => dispatch(sql, params)),
    getClient: jest.fn(async () => ({
      query: jest.fn((sql: string, params: any[] = []) => dispatch(sql, params)),
      release: jest.fn(),
    })),
  };
  const createErrors = [...(o.createErrors ?? [])];
  const provisioning = {
    create: jest.fn(async () => {
      const e = createErrors.shift();
      if (e) throw e;
      return { productId: 'p-new', freeMonth: true };
    }),
  };
  const limits = { assertCanCreate: jest.fn(async () => undefined) };
  const turns = { enqueue: jest.fn(async () => ({ id: 't-new', status: 'queued' })), revert: jest.fn(async () => ({ id: 't-rev', status: 'queued' })) };
  const actions = {
    open: jest.fn(async () => ({ id: ACT, expiresAt: '2026-10-25T10:30:00.000Z' })),
    record: jest.fn(async () => 'rec'),
    claim: jest.fn(async () => null as any),
    release: jest.fn(async () => undefined),
    finish: jest.fn(async () => undefined),
  };
  const secretsMock = o.secrets ?? { decrypt: jest.fn(() => ({ BOT_TOKEN: '1234567890:AAH9sdfjKJHkjh34kjh5kjh6KJHkjhKJHkj' })) };
  const svc = new ProductLifecycleService(pg as any, provisioning as any, limits as any, turns as any, actions as any, secretsMock as any);
  (svc as any).suffix = () => 'zzzzzz';
  (svc as any).checkBot = jest.fn(async () => ({ ok: true, id: 1234567890, username: 'shop_bot' }));
  return { svc, pg, calls, provisioning, limits, turns, actions, secrets: secretsMock };
}

describe('создание сайта', () => {
  it('занят чистый слаг — берётся с хвостом; первая правка запоминается; журнал', async () => {
    const h = harness({ createErrors: [new ConflictException('слаг уже занят')] });
    const r = await h.svc.createSite({ userId: 'u1', name: 'Магазин', prompt: 'Лендинг с ценами', channel: 'web' });
    expect(r).toEqual({ ok: true, productId: 'p-new', slug: 'magazin-zzzzzz', domain: 'magazin.c.linkeon.io', freeMonth: true });
    expect(h.provisioning.create.mock.calls.map((c: any) => c[0].slug)).toEqual(['magazin', 'magazin-zzzzzz']);
    expect(h.provisioning.create.mock.calls[1][0]).toMatchObject({ kind: 'site', secrets: {}, isAdmin: false });
    expect(h.calls.some((c) => c.sql.includes('SET first_prompt') && c.params[1] === 'Лендинг с ценами' && c.params[2] === 'web')).toBe(true);
    expect(h.actions.record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'create_site', status: 'done' }));
  });

  it('предел занят — reason limit с текстом заведения', async () => {
    const h = harness({ createErrors: [new UnprocessableEntityException('Предел — 2 продукта на один аккаунт')] });
    const r = await h.svc.createSite({ userId: 'u1', name: 'Магазин', channel: 'web' });
    expect(r).toEqual({ ok: false, reason: 'limit', message: 'Предел — 2 продукта на один аккаунт' });
    expect(h.actions.record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'create_site', status: 'failed' }));
  });

  it('пустое имя — без заведения', async () => {
    const h = harness();
    expect((await h.svc.createSite({ userId: 'u1', name: '  ', channel: 'web' })).ok).toBe(false);
    expect(h.provisioning.create).not.toHaveBeenCalled();
  });

  it('имя длиннее 80 знаков — без заведения', async () => {
    const h = harness();
    const r = await h.svc.createSite({ userId: 'u1', name: 'а'.repeat(81), channel: 'web' });
    expect(r).toMatchObject({ ok: false, reason: 'bad_name' });
    expect(h.provisioning.create).not.toHaveBeenCalled();
  });

  it('внутренняя ошибка create (не HttpException) — общий текст, сырая ошибка не наружу', async () => {
    const h = harness({ createErrors: [new Error('connection reset by peer')] });
    const r = await h.svc.createSite({ userId: 'u1', name: 'Магазин', channel: 'web' });
    expect(r).toEqual({ ok: false, reason: 'failed', message: 'Не получилось — попробуйте ещё раз позже' });
  });

  it('сайт создан, но первая правка/домен/журнал упали — всё равно ok:true, второй сайт не заводится', async () => {
    const h = harness({ pg: (sql) => (sql.includes('SET first_prompt') ? Promise.reject(new Error('connection reset by peer')) : undefined) });
    const warn = jest.spyOn((h.svc as any).logger, 'warn').mockImplementation(() => undefined);
    const r = await h.svc.createSite({ userId: 'u1', name: 'Магазин', prompt: 'Лендинг', channel: 'web' });
    expect(r).toEqual({ ok: true, productId: 'p-new', slug: 'magazin', domain: null, freeMonth: true });
    // Один вызов create — отказ ПОСЛЕ заведения не должен выглядеть как
    // занятый слаг и запускать повторную попытку со следующим кандидатом.
    expect(h.provisioning.create).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
  });
});

describe('создание бота', () => {
  const claimed = { id: ACT, kind: 'create_bot', product_id: null, channel: 'web', payload: { name: 'Бот магазина', prompt: 'Отчёт в 8:00' }, result: null };

  it('имя длиннее 80 знаков — карточка не открывается', async () => {
    const h = harness();
    const r = await h.svc.openCreateBot({ userId: 'u1', name: 'б'.repeat(81), channel: 'web', turn: null });
    expect(r).toMatchObject({ ok: false, reason: 'bad_name' });
    expect(h.actions.open).not.toHaveBeenCalled();
  });

  it('предел занят — отказ до открытия карточки (M8), токен бота у человека не просим напрасно', async () => {
    const h = harness();
    h.limits.assertCanCreate.mockRejectedValue(new UnprocessableEntityException('Предел — 2 продукта на один аккаунт'));
    const r = await h.svc.openCreateBot({ userId: 'u1', name: 'Бот', channel: 'web', turn: null });
    expect(r).toEqual({ ok: false, reason: 'limit', message: 'Предел — 2 продукта на один аккаунт' });
    expect(h.actions.open).not.toHaveBeenCalled();
  });

  it('Telegram не принял токен — карточка снова ждёт, с ошибкой; заведения нет', async () => {
    const h = harness();
    h.actions.claim.mockResolvedValue(claimed);
    (h.svc as any).checkBot = jest.fn(async () => ({ ok: false, reason: 'rejected' }));
    const r = await h.svc.completeCreateBot({ userId: 'u1', actionId: ACT, set: { BOT_TOKEN: TOKEN }, via: 'chat' });
    expect(r).toMatchObject({ ok: false, reason: 'bad_token' });
    expect(h.actions.release).toHaveBeenCalledWith(ACT, expect.objectContaining({ field: 'BOT_TOKEN' }));
    expect(h.provisioning.create).not.toHaveBeenCalled();
  });

  it('бот уже у другого живого продукта — снова ждёт', async () => {
    const h = harness({ pg: (sql) => (sql.includes('WHERE tg_bot_id = $1') ? { rows: [{ '?column?': 1 }] } : null) });
    h.actions.claim.mockResolvedValue(claimed);
    const r = await h.svc.completeCreateBot({ userId: 'u1', actionId: ACT, set: { BOT_TOKEN: TOKEN }, via: 'chat' });
    expect(r).toMatchObject({ ok: false, reason: 'bot_in_use' });
    expect(h.provisioning.create).not.toHaveBeenCalled();
  });

  it('успех: бот с ключами, id бота через create (не отдельным UPDATE), первая правка, итог done', async () => {
    const h = harness();
    h.actions.claim.mockResolvedValue(claimed);
    const r = await h.svc.completeCreateBot({ userId: 'u1', actionId: ACT, set: { BOT_TOKEN: ` ${TOKEN} `, OZON_KEY: 'k' }, via: 'tma' });
    expect(r).toEqual({ ok: true, productId: 'p-new', freeMonth: true });
    expect(h.provisioning.create).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'bot', name: 'Бот магазина', slug: 'bot-magazina-zzzzzz', secrets: { BOT_TOKEN: TOKEN, OZON_KEY: 'k' }, tgBotId: 1234567890,
    }));
    // id бота уходит в тот же INSERT, что заводит продукт (через create) —
    // отдельного UPDATE products SET tg_bot_id больше нет: партиционный
    // UNIQUE products_tg_bot_live ловит гонку только на INSERT.
    expect(h.calls.some((c) => c.sql.includes('SET tg_bot_id'))).toBe(false);
    expect(h.actions.finish).toHaveBeenCalledWith(ACT, 'done', { productId: 'p-new', botUsername: 'shop_bot', freeMonth: true }, 'p-new');
  });

  it('гонка: вторая карточка с тем же ботом успела пройти раннюю проверку, но проиграла create — тот же текст bot_in_use', async () => {
    const h = harness({ createErrors: [new ConflictException('бот уже работает в другом продукте')] });
    h.actions.claim.mockResolvedValue(claimed);
    const r = await h.svc.completeCreateBot({ userId: 'u1', actionId: ACT, set: { BOT_TOKEN: TOKEN }, via: 'chat' });
    expect(r).toEqual({
      ok: false, reason: 'bot_in_use',
      message: 'Этот бот уже работает в другом продукте — создайте в @BotFather нового бота',
    });
    expect(h.actions.release).toHaveBeenCalledWith(ACT, expect.objectContaining({ field: 'BOT_TOKEN' }));
    expect(h.actions.finish).not.toHaveBeenCalled();
  });

  it('карточка уже закрыта — not_pending', async () => {
    const h = harness();
    expect(await h.svc.completeCreateBot({ userId: 'u1', actionId: ACT, set: {}, via: 'chat' })).toMatchObject({ reason: 'not_pending' });
  });

  it('обрыв с базой на проверке занятости бота — карточка возвращается в pending, не умирает навсегда', async () => {
    const h = harness({ pg: (sql) => (sql.includes('WHERE tg_bot_id = $1') ? Promise.reject(new Error('connection reset by peer')) : undefined) });
    h.actions.claim.mockResolvedValue(claimed);
    const r = await h.svc.completeCreateBot({ userId: 'u1', actionId: ACT, set: { BOT_TOKEN: TOKEN }, via: 'chat' });
    expect(r).toEqual({ ok: false, reason: 'failed', message: 'Не получилось — попробуйте ещё раз позже' });
    expect(h.actions.release).toHaveBeenCalledWith(ACT, expect.objectContaining({ error: expect.any(String) }));
    expect(h.actions.finish).not.toHaveBeenCalled();
    expect(h.provisioning.create).not.toHaveBeenCalled();
  });

  it('бот создан, но первая правка не поставилась — карточка всё равно закрывается done, а не failed', async () => {
    const h = harness({ pg: (sql) => (sql.includes('SET first_prompt') ? Promise.reject(new Error('connection reset by peer')) : undefined) });
    h.actions.claim.mockResolvedValue(claimed);
    const warn = jest.spyOn((h.svc as any).logger, 'warn').mockImplementation(() => undefined);
    const r = await h.svc.completeCreateBot({ userId: 'u1', actionId: ACT, set: { BOT_TOKEN: TOKEN }, via: 'tma' });
    expect(r).toEqual({ ok: true, productId: 'p-new', freeMonth: true });
    expect(h.actions.finish).toHaveBeenCalledWith(ACT, 'done', { productId: 'p-new', botUsername: 'shop_bot', freeMonth: true }, 'p-new');
    expect(h.actions.release).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });
});

describe('удаление', () => {
  it('заводится — не удаляем', async () => {
    const h = harness({ pg: (sql) => (sql.includes('FROM products WHERE id = $1 AND user_id = $2 AND archived_at IS NULL') ? { rows: [{ id: 'p1', name: 'М', slug: 'm', kind: 'site', status: 'provisioning' }] } : null) });
    expect(await h.svc.openDelete({ userId: 'u1', productId: 'p1', channel: 'web', turn: null })).toMatchObject({ ok: false, reason: 'provisioning' });
    expect(h.actions.open).not.toHaveBeenCalled();
  });

  it('продукт остановлен администратором — удалить нельзя, карточка не открывается', async () => {
    const h = harness({ pg: (sql) => (sql.includes('FROM products WHERE id = $1 AND user_id = $2 AND archived_at IS NULL') ? { rows: [{ id: 'p1', name: 'М', slug: 'm', kind: 'site', status: 'blocked', block_reason: 'жалоба' }] } : null) });
    const r = await h.svc.openDelete({ userId: 'u1', productId: 'p1', channel: 'web', turn: null });
    expect(r).toMatchObject({ ok: false, reason: 'blocked' });
    expect(h.actions.open).not.toHaveBeenCalled();
  });

  it('по нажатию: архив на 30 дней, чужие задания сняты, сон поставлен, итог с датой и прежним статусом', async () => {
    const until = new Date('2026-11-24T10:00:00Z');
    const h = harness({ pg: (sql) => (sql.includes("SET archived_at = now()") ? { rows: [{ purge_after: until, prev_status: 'running' }] } : null) });
    h.actions.claim.mockResolvedValue({ id: ACT, kind: 'delete', product_id: 'p1', channel: 'web', payload: {} });
    const r = await h.svc.completeDelete({ userId: 'u1', actionId: ACT, via: 'chat' });
    expect(r).toEqual({ ok: true, restoreUntil: until.toISOString() });
    const archive = h.calls.find((c) => c.sql.includes('SET archived_at = now()'))!;
    expect(archive.params).toEqual(['p1', 'u1', DELETE_GRACE_DAYS]);
    expect(h.calls.some((c) => c.sql.includes("error = 'снято удалением'"))).toBe(true);
    expect(h.calls.some((c) => c.sql.includes("'sleep', 'queued'") && c.params[0] === 'p1')).toBe(true);
    // prevStatus — чтобы возврат мог отличить «спал за неуплату» от «вернуть
    // туда, где и был сломан»: продукту, удалённому в failed, пополнение не
    // поможет, и сон за неуплату был бы неправдой.
    expect(h.actions.finish).toHaveBeenCalledWith(ACT, 'done', { restoreUntil: until.toISOString(), prevStatus: 'running' });
  });

  it('queued/running правки продукта снимаются вместе с заданиями — иначе держат замок и выполнятся после возврата', async () => {
    const until = new Date('2026-11-24T10:00:00Z');
    const h = harness({ pg: (sql) => (sql.includes("SET archived_at = now()") ? { rows: [{ purge_after: until }] } : null) });
    h.actions.claim.mockResolvedValue({ id: ACT, kind: 'delete', product_id: 'p1', channel: 'web', payload: {} });
    const r = await h.svc.completeDelete({ userId: 'u1', actionId: ACT, via: 'chat' });
    expect(r).toEqual({ ok: true, restoreUntil: until.toISOString() });
    const turnsCancel = h.calls.find((c) => c.sql.includes('UPDATE product_turns') && c.sql.includes("status IN ('queued','running')"));
    expect(turnsCancel).toBeTruthy();
    expect(turnsCancel!.params[0]).toBe('p1');
  });

  it('карточка другого вида — освобождена, not_pending', async () => {
    const h = harness();
    h.actions.claim.mockResolvedValue({ id: ACT, kind: 'create_bot', product_id: null, channel: 'web', payload: {}, result: null });
    const r = await h.svc.completeDelete({ userId: 'u1', actionId: ACT, via: 'chat' });
    expect(r).toMatchObject({ ok: false, reason: 'not_pending' });
    expect(h.actions.release).toHaveBeenCalledWith(ACT, {});
  });

  it('обрыв с базой на архивации — карточка возвращается в pending, не умирает навсегда', async () => {
    const h = harness({ pg: (sql) => (sql.includes('SET archived_at = now()') ? Promise.reject(new Error('connection reset by peer')) : undefined) });
    h.actions.claim.mockResolvedValue({ id: ACT, kind: 'delete', product_id: 'p1', channel: 'web', payload: {} });
    const r = await h.svc.completeDelete({ userId: 'u1', actionId: ACT, via: 'chat' });
    expect(r).toEqual({ ok: false, reason: 'failed', message: 'Не получилось — попробуйте ещё раз позже' });
    expect(h.actions.release).toHaveBeenCalledWith(ACT, expect.objectContaining({ error: expect.any(String) }));
    expect(h.actions.finish).not.toHaveBeenCalled();
  });

  it('продукт архивирован, но снятие заданий и постановка сна упали — карточка всё равно закрывается done', async () => {
    const until = new Date('2026-11-24T10:00:00Z');
    const h = harness({
      pg: (sql) => {
        if (sql.includes('SET archived_at = now()')) return { rows: [{ purge_after: until }] };
        if (sql.includes("status = 'queued' AND kind <> 'sleep'")) return Promise.reject(new Error('timeout'));
        return undefined;
      },
    });
    h.actions.claim.mockResolvedValue({ id: ACT, kind: 'delete', product_id: 'p1', channel: 'web', payload: {} });
    const warn = jest.spyOn((h.svc as any).logger, 'warn').mockImplementation(() => undefined);
    const r = await h.svc.completeDelete({ userId: 'u1', actionId: ACT, via: 'chat' });
    expect(r).toEqual({ ok: true, restoreUntil: until.toISOString() });
    expect(h.actions.finish).toHaveBeenCalledWith(ACT, 'done', { restoreUntil: until.toISOString(), prevStatus: null });
    expect(warn).toHaveBeenCalled();
  });
});

describe('возврат', () => {
  const deleted = (over: any = {}) => ({ id: 'p1', name: 'М', purge_after: new Date(Date.now() + 86_400_000), block_reason: null, busy: false, ...over });

  it('срок вышел — отказ', async () => {
    const h = harness({ pg: (sql) => (sql.includes('AS busy') ? { rows: [deleted({ purge_after: new Date(Date.now() - 1000) })] } : null) });
    expect(await h.svc.restore({ userId: 'u1', productId: 'p1', channel: 'web' })).toMatchObject({ ok: false, reason: 'expired' });
  });

  it('предел занят — отказ текстом предела', async () => {
    const h = harness({ pg: (sql) => (sql.includes('AS busy') ? { rows: [deleted()] } : null) });
    h.limits.assertCanCreate.mockRejectedValue(new UnprocessableEntityException('Предел — 2 продукта'));
    expect(await h.svc.restore({ userId: 'u1', productId: 'p1', channel: 'web' })).toMatchObject({ ok: false, reason: 'limit' });
  });

  it('оплаченный период идёт — снимаем архив и будим', async () => {
    const h = harness({
      pg: (sql) => {
        if (sql.includes('AS busy')) return { rows: [deleted()] };
        if (sql.includes('SET archived_at = NULL')) return { rows: [{ status: 'sleeping', paid: true }] };
        if (sql.includes("'wake', 'queued'")) return { rows: [{ product_id: 'p1' }] };
        return null;
      },
    });
    expect(await h.svc.restore({ userId: 'u1', productId: 'p1', channel: 'web' })).toEqual({ ok: true, status: 'sleeping', waking: true });
  });

  it('wake уже стоял в очереди (RentService успел раньше) — waking всё равно true', async () => {
    const h = harness({
      pg: (sql) => {
        if (sql.includes('AS busy')) return { rows: [deleted()] };
        if (sql.includes('SET archived_at = NULL')) return { rows: [{ status: 'sleeping', paid: true }] };
        // ON CONFLICT молчит — чужой wake уже есть; мы проверяем это отдельным SELECT.
        if (sql.includes("'wake', 'queued'")) return { rows: [] };
        if (sql.includes("kind = 'wake' AND status IN")) return { rows: [{ '?column?': 1 }] };
        return null;
      },
    });
    expect(await h.svc.restore({ userId: 'u1', productId: 'p1', channel: 'web' })).toEqual({ ok: true, status: 'sleeping', waking: true });
  });

  it('погашенный администратором возвращается погашенным и не будится', async () => {
    const h = harness({
      pg: (sql) => {
        if (sql.includes('AS busy')) return { rows: [deleted({ block_reason: 'жалоба' })] };
        if (sql.includes('SET archived_at = NULL')) return { rows: [{ status: 'blocked', paid: true }] };
        return null;
      },
    });
    expect(await h.svc.restore({ userId: 'u1', productId: 'p1', channel: 'web' })).toEqual({ ok: true, status: 'blocked', waking: false });
    expect(h.calls.some((c) => c.sql.includes("'wake', 'queued'"))).toBe(false);
  });

  it('продукт был сломан (failed) до удаления — возвращается failed, не спит и не будится', async () => {
    const h = harness({
      pg: (sql) => {
        if (sql.includes('AS busy')) return { rows: [deleted()] };
        if (sql.includes("kind = 'delete' AND status = 'done'")) return { rows: [{ prev_status: 'failed' }] };
        if (sql.includes('SET archived_at = NULL')) return { rows: [{ status: 'failed', paid: true }] };
        return null;
      },
    });
    const r = await h.svc.restore({ userId: 'u1', productId: 'p1', channel: 'web' });
    expect(r).toEqual({ ok: true, status: 'failed', waking: false });
    const upd = h.calls.find((c) => c.sql.includes('SET archived_at = NULL'))!;
    expect(upd.params[3]).toBe('failed');
    expect(h.calls.some((c) => c.sql.includes("'wake', 'queued'"))).toBe(false);
  });

  it('токен бота за время архива достался другому живому продукту — bot_in_use, не 500', async () => {
    const h = harness({
      pg: (sql) => {
        if (sql.includes('AS busy')) return { rows: [deleted()] };
        if (sql.includes('SET archived_at = NULL')) {
          const e: any = new Error('duplicate key value violates unique constraint "products_tg_bot_live"');
          e.code = '23505';
          e.constraint = 'products_tg_bot_live';
          throw e;
        }
        return null;
      },
    });
    const r = await h.svc.restore({ userId: 'u1', productId: 'p1', channel: 'web' });
    expect(r).toEqual({
      ok: false, reason: 'bot_in_use',
      message: 'Этот бот уже работает в другом продукте — удалённого не вернуть, пока его токен занят',
    });
    expect(h.actions.record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'restore', status: 'failed', result: expect.objectContaining({ reason: 'bot_in_use' }) }));
  });
});

describe('откат и первая правка', () => {
  it('без turnId — последняя применённая; канал доезжает', async () => {
    const h = harness({ pg: (sql) => (sql.includes("status = 'done' AND sha_before IS NOT NULL") ? { rows: [{ id: 't-last' }] } : null) });
    expect(await h.svc.revert({ userId: 'u1', productId: 'p1', channel: 'telegram' })).toEqual({ ok: true, turnId: 't-rev' });
    expect(h.turns.revert).toHaveBeenCalledWith({ productId: 'p1', turnId: 't-last', userId: 'u1', channel: 'telegram' });
  });

  it('turnId не похож на uuid — bad_turn без обращения к базе (M6), отказ записан в журнал', async () => {
    const h = harness();
    const r = await h.svc.revert({ userId: 'u1', productId: 'p1', turnId: 'не-uuid-а-что-то-от-модели', channel: 'web' });
    expect(r).toEqual({ ok: false, reason: 'bad_turn', message: 'Такой правки у продукта нет' });
    expect(h.turns.revert).not.toHaveBeenCalled();
    expect(h.calls.some((c) => c.sql.includes('product_turns'))).toBe(false);
    expect(h.actions.record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'revert', status: 'failed', result: expect.objectContaining({ reason: 'bad_turn' }) }));
  });

  it('нет применённых правок — отказ записан в журнал (M7)', async () => {
    const h = harness({ pg: (sql) => (sql.includes("status = 'done' AND sha_before IS NOT NULL") ? { rows: [] } : null) });
    const r = await h.svc.revert({ userId: 'u1', productId: 'p1', channel: 'web' });
    expect(r).toMatchObject({ ok: false, reason: 'no_turns' });
    expect(h.actions.record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'revert', status: 'failed', result: expect.objectContaining({ reason: 'no_turns' }) }));
  });

  it('очередь правок отказала (сон/блок/занят) — отказ записан в журнал, а бросок долетает как есть (M7)', async () => {
    const h = harness({ pg: (sql) => (sql.includes("status = 'done' AND sha_before IS NOT NULL") ? { rows: [{ id: 't-last' }] } : null) });
    const refusal = new ConflictException('Продукт спит — пополните баланс');
    h.turns.revert.mockRejectedValue(refusal);
    await expect(h.svc.revert({ userId: 'u1', productId: 'p1', channel: 'web' })).rejects.toBe(refusal);
    expect(h.actions.record).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'revert', status: 'failed', result: expect.objectContaining({ error: expect.stringContaining('пополните баланс') }),
    }));
  });

  it('успешный откат — журнал done с queued:true, исход живёт в product_turns (M7)', async () => {
    const h = harness({ pg: (sql) => (sql.includes("status = 'done' AND sha_before IS NOT NULL") ? { rows: [{ id: 't-last' }] } : null) });
    const r = await h.svc.revert({ userId: 'u1', productId: 'p1', channel: 'web' });
    expect(r).toEqual({ ok: true, turnId: 't-rev' });
    expect(h.actions.record).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'revert', status: 'done', result: { turnId: 't-rev', queued: true },
    }));
  });

  it('первая правка ставится поднявшимся продуктам, сбой одной не роняет остальные', async () => {
    const h = harness({ pg: (sql) => (sql.includes('WITH picked AS') ? { rows: [
      { id: 'p1', user_id: 'u1', first_prompt: 'А', first_prompt_channel: 'telegram' },
      { id: 'p2', user_id: 'u2', first_prompt: 'Б', first_prompt_channel: null },
    ] } : null) });
    h.turns.enqueue.mockRejectedValueOnce(new Error('Недостаточно токенов'));
    expect(await h.svc.firstPromptTick()).toBe(2);
    expect(h.turns.enqueue.mock.calls.map((c: any) => [c[0].productId, c[0].channel, c[0].prompt])).toEqual([['p1', 'telegram', 'А'], ['p2', 'web', 'Б']]);
  });

  it('мьютекс хода занят — первая правка возвращается на следующий тик, а не теряется', async () => {
    const h = harness({ pg: (sql) => (sql.includes('WITH picked AS') ? { rows: [
      { id: 'p1', user_id: 'u1', first_prompt: 'А', first_prompt_channel: 'telegram' },
    ] } : null) });
    const busy = new ConflictException('Агент уже работает над предыдущим запросом');
    h.turns.enqueue.mockRejectedValueOnce(busy);
    expect(await h.svc.firstPromptTick()).toBe(1);
    const restore = h.calls.find((c) => c.sql.includes('SET first_prompt') && c.sql.includes('first_prompt IS NULL'))!;
    expect(restore.params).toEqual(['p1', 'А', 'telegram']);
  });
});

describe('бэкафилл tg_bot_id (I2, часть 2)', () => {
  const BOX = Buffer.from('коробка');

  it('живой токен — tg_bot_id проставлен, токен не уходит ни в один вызов логгера', async () => {
    const h = harness({
      pg: (sql) => (sql.includes('SELECT id, secrets_encrypted FROM products')
        ? { rows: [{ id: 'bot-1', secrets_encrypted: BOX }] }
        : null),
      secrets: { decrypt: jest.fn(() => ({ BOT_TOKEN: TOKEN })) },
    });
    const warn = jest.spyOn((h.svc as any).logger, 'warn').mockImplementation(() => undefined);
    const error = jest.spyOn((h.svc as any).logger, 'error').mockImplementation(() => undefined);

    expect(await h.svc.backfillBotIdsTick()).toBe(1);

    expect((h.svc as any).checkBot).toHaveBeenCalledWith(TOKEN);
    const upd = h.calls.find((c) => c.sql.includes('SET tg_bot_id'))!;
    expect(upd.sql).toContain('tg_bot_id IS NULL');
    expect(upd.params).toEqual(['bot-1', 1234567890]);
    // Канарейка M11: токен не попадает ни в один аргумент warn/error.
    for (const call of [...warn.mock.calls, ...error.mock.calls]) {
      expect(JSON.stringify(call)).not.toContain(TOKEN);
    }
  });

  it('Telegram отверг токен — только tg_bot_checked_at, tg_bot_id не трогается', async () => {
    const h = harness({
      pg: (sql) => (sql.includes('SELECT id, secrets_encrypted FROM products')
        ? { rows: [{ id: 'bot-2', secrets_encrypted: BOX }] }
        : null),
      secrets: { decrypt: jest.fn(() => ({ BOT_TOKEN: TOKEN })) },
    });
    (h.svc as any).checkBot = jest.fn(async () => ({ ok: false, reason: 'rejected' }));

    expect(await h.svc.backfillBotIdsTick()).toBe(1);

    expect(h.calls.some((c) => c.sql.includes('SET tg_bot_id'))).toBe(false);
    const upd = h.calls.find((c) => c.sql.includes('SET tg_bot_checked_at') && !c.sql.includes('tg_bot_id ='))!;
    expect(upd.params).toEqual(['bot-2']);
  });

  it('гонка на UPDATE: tg_bot_id занят другим живым продуктом — warn именами продуктов, без токена, checked_at всё равно ставится', async () => {
    const h = harness({
      pg: (sql, params) => {
        if (sql.includes('SELECT id, secrets_encrypted FROM products')) return { rows: [{ id: 'bot-3', secrets_encrypted: BOX }] };
        if (sql.includes('SET tg_bot_id')) {
          throw Object.assign(new Error('duplicate key value violates unique constraint'), {
            code: '23505', constraint: 'products_tg_bot_live',
          });
        }
        if (sql.includes('SELECT id FROM products WHERE tg_bot_id')) return { rows: [{ id: 'bot-other' }] };
        return null;
      },
      secrets: { decrypt: jest.fn(() => ({ BOT_TOKEN: TOKEN })) },
    });
    const warn = jest.spyOn((h.svc as any).logger, 'warn').mockImplementation(() => undefined);

    expect(await h.svc.backfillBotIdsTick()).toBe(1);

    const msg = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(msg).toContain('bot-3');
    expect(msg).toContain('bot-other');
    expect(msg).not.toContain(TOKEN);
    const checkedAt = h.calls.find((c) => c.sql.includes('SET tg_bot_checked_at') && !c.sql.includes('tg_bot_id ='))!;
    expect(checkedAt.params).toEqual(['bot-3']);
  });

  it('секреты не расшифровались — не падает, checked_at ставится, getMe не зовётся', async () => {
    const h = harness({
      pg: (sql) => (sql.includes('SELECT id, secrets_encrypted FROM products')
        ? { rows: [{ id: 'bot-4', secrets_encrypted: BOX }] }
        : null),
      secrets: { decrypt: jest.fn(() => { throw new Error('коробка повреждена'); }) },
    });
    const warn = jest.spyOn((h.svc as any).logger, 'warn').mockImplementation(() => undefined);

    expect(await h.svc.backfillBotIdsTick()).toBe(1);

    expect((h.svc as any).checkBot).not.toHaveBeenCalled();
    const upd = h.calls.find((c) => c.sql.includes('SET tg_bot_checked_at'))!;
    expect(upd.params).toEqual(['bot-4']);
    expect(warn).toHaveBeenCalled();
  });

  it('кандидатов нет — 0, запросов на обновление не уходит', async () => {
    const h = harness();
    expect(await h.svc.backfillBotIdsTick()).toBe(0);
    expect(h.calls.some((c) => c.sql.includes('SET tg_bot_id') || c.sql.includes('SET tg_bot_checked_at'))).toBe(false);
  });
});
