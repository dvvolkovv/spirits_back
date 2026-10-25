import { ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { ProductLifecycleService, DELETE_GRACE_DAYS } from './product-lifecycle.service';

const ACT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const TOKEN = '1234567890:AAH9sdfjKJHkjh34kjh5kjh6KJHkjhKJHkj';

function harness(o: { pg?: (sql: string, params: any[]) => any; createErrors?: any[] } = {}) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const pg = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      const custom = o.pg?.(sql, params);
      if (custom) return custom;
      if (sql.includes('FROM ai_profiles_consolidated')) return { rows: [{ isadmin: false }] };
      if (sql.includes('SELECT domain FROM products')) return { rows: [{ domain: 'magazin.c.linkeon.io' }] };
      return { rows: [], rowCount: 0 };
    }),
  };
  const createErrors = [...(o.createErrors ?? [])];
  const provisioning = {
    create: jest.fn(async () => {
      const e = createErrors.shift();
      if (e) throw e;
      return { productId: 'p-new' };
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
  const svc = new ProductLifecycleService(pg as any, provisioning as any, limits as any, turns as any, actions as any);
  (svc as any).suffix = () => 'zzzzzz';
  (svc as any).checkBot = jest.fn(async () => ({ ok: true, id: 1234567890, username: 'shop_bot' }));
  return { svc, pg, calls, provisioning, limits, turns, actions };
}

describe('создание сайта', () => {
  it('занят чистый слаг — берётся с хвостом; первая правка запоминается; журнал', async () => {
    const h = harness({ createErrors: [new ConflictException('слаг уже занят')] });
    const r = await h.svc.createSite({ userId: 'u1', name: 'Магазин', prompt: 'Лендинг с ценами', channel: 'web' });
    expect(r).toEqual({ ok: true, productId: 'p-new', slug: 'magazin-zzzzzz', domain: 'magazin.c.linkeon.io' });
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
});

describe('создание бота', () => {
  const claimed = { id: ACT, kind: 'create_bot', product_id: null, channel: 'web', payload: { name: 'Бот магазина', prompt: 'Отчёт в 8:00' }, result: null };

  it('имя длиннее 80 знаков — карточка не открывается', async () => {
    const h = harness();
    const r = await h.svc.openCreateBot({ userId: 'u1', name: 'б'.repeat(81), channel: 'web', turn: null });
    expect(r).toMatchObject({ ok: false, reason: 'bad_name' });
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
    expect(r).toEqual({ ok: true, productId: 'p-new' });
    expect(h.provisioning.create).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'bot', name: 'Бот магазина', slug: 'bot-magazina-zzzzzz', secrets: { BOT_TOKEN: TOKEN, OZON_KEY: 'k' }, tgBotId: 1234567890,
    }));
    // id бота уходит в тот же INSERT, что заводит продукт (через create) —
    // отдельного UPDATE products SET tg_bot_id больше нет: партиционный
    // UNIQUE products_tg_bot_live ловит гонку только на INSERT.
    expect(h.calls.some((c) => c.sql.includes('SET tg_bot_id'))).toBe(false);
    expect(h.actions.finish).toHaveBeenCalledWith(ACT, 'done', { productId: 'p-new', botUsername: 'shop_bot' }, 'p-new');
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
});

describe('удаление', () => {
  it('заводится — не удаляем', async () => {
    const h = harness({ pg: (sql) => (sql.includes('FROM products WHERE id = $1 AND user_id = $2 AND archived_at IS NULL') ? { rows: [{ id: 'p1', name: 'М', slug: 'm', kind: 'site', status: 'provisioning' }] } : null) });
    expect(await h.svc.openDelete({ userId: 'u1', productId: 'p1', channel: 'web', turn: null })).toMatchObject({ ok: false, reason: 'provisioning' });
    expect(h.actions.open).not.toHaveBeenCalled();
  });

  it('по нажатию: архив на 30 дней, чужие задания сняты, сон поставлен, итог с датой', async () => {
    const until = new Date('2026-11-24T10:00:00Z');
    const h = harness({ pg: (sql) => (sql.includes("SET archived_at = now()") ? { rows: [{ purge_after: until }] } : null) });
    h.actions.claim.mockResolvedValue({ id: ACT, kind: 'delete', product_id: 'p1', channel: 'web', payload: {} });
    const r = await h.svc.completeDelete({ userId: 'u1', actionId: ACT, via: 'chat' });
    expect(r).toEqual({ ok: true, restoreUntil: until.toISOString() });
    const archive = h.calls.find((c) => c.sql.includes('SET archived_at = now()'))!;
    expect(archive.params).toEqual(['p1', 'u1', DELETE_GRACE_DAYS]);
    expect(h.calls.some((c) => c.sql.includes("error = 'снято удалением'"))).toBe(true);
    expect(h.calls.some((c) => c.sql.includes("'sleep', 'queued'") && c.params[0] === 'p1')).toBe(true);
    expect(h.actions.finish).toHaveBeenCalledWith(ACT, 'done', { restoreUntil: until.toISOString() });
  });

  it('карточка другого вида — освобождена, not_pending', async () => {
    const h = harness();
    h.actions.claim.mockResolvedValue({ id: ACT, kind: 'create_bot', product_id: null, channel: 'web', payload: {}, result: null });
    const r = await h.svc.completeDelete({ userId: 'u1', actionId: ACT, via: 'chat' });
    expect(r).toMatchObject({ ok: false, reason: 'not_pending' });
    expect(h.actions.release).toHaveBeenCalledWith(ACT, {});
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
});

describe('откат и первая правка', () => {
  it('без turnId — последняя применённая; канал доезжает', async () => {
    const h = harness({ pg: (sql) => (sql.includes("status = 'done' AND sha_before IS NOT NULL") ? { rows: [{ id: 't-last' }] } : null) });
    expect(await h.svc.revert({ userId: 'u1', productId: 'p1', channel: 'telegram' })).toEqual({ ok: true, turnId: 't-rev' });
    expect(h.turns.revert).toHaveBeenCalledWith({ productId: 'p1', turnId: 't-last', userId: 'u1', channel: 'telegram' });
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
