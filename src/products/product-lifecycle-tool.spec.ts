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
    createSite: jest.fn(async () => ({ ok: true, productId: 'p-new', slug: 'magazin', domain: 'magazin.c.linkeon.io', freeMonth: true, firstPromptSet: true })),
    openCreateBot: jest.fn(async () => ({ ok: true, actionId: 'a1', expiresAt: '2026-10-25T10:30:00.000Z' })),
    // paidUntil по умолчанию в будущем: у большинства тестов делетится продукт
    // с ещё идущим периодом, и фраза «оставшийся срок не возвращается» в силе.
    openDelete: jest.fn(async () => ({ ok: true, actionId: 'a2', expiresAt: '2026-10-25T10:30:00.000Z', paidUntil: '2026-11-24T10:00:00.000Z' })),
    // По умолчанию — оплаченный период ещё идёт (I1, ревью): самый частый
    // исход возврата на практике — продукт с остатком (бесплатный месяц или
    // уже оплаченный), а не истёкший-но-по-деньгам-хватает. Тесты на другие
    // ветки (unpaid+affordable, unpaid+not affordable) переопределяют мок явно.
    restore: jest.fn(async () => ({ ok: true, status: 'sleeping', waking: true, paid: true, paidUntil: '2026-11-24T10:00:00.000Z', balance: 70_000 })),
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

  // Решение владельца 26.10.2026: say обязан назвать, попал ли ИМЕННО ЭТОТ
  // продукт в бесплатный месяц — ассистент узнаёт это только из ответа
  // инструмента, не от себя.
  it('create site — бесплатный первый месяц назван прямо', async () => {
    const h = harness();
    h.lifecycle.createSite.mockResolvedValue({ ok: true, productId: 'p-new', slug: 'magazin', domain: 'magazin.c.linkeon.io', freeMonth: true } as any);
    const r: any = await h.svc.execute('u1', { action: 'create', kind: 'site', name: 'Магазин' }, 'web', 'turn-1');
    expect(r.created.freeMonth).toBe(true);
    expect(r.say).toMatch(/первый месяц аренды бесплатный/i);
    expect(r.say).not.toMatch(/спишется при запуске/);
  });

  it('create site — не первый бесплатный месяц: аренда и сон за нехватку токенов названы сразу', async () => {
    const h = harness();
    h.lifecycle.createSite.mockResolvedValue({ ok: true, productId: 'p-new', slug: 'magazin', domain: 'magazin.c.linkeon.io', freeMonth: false } as any);
    const r: any = await h.svc.execute('u1', { action: 'create', kind: 'site', name: 'Магазин' }, 'web', 'turn-1');
    expect(r.created.freeMonth).toBe(false);
    // Задача «Отступления очереди 1», п.1: аренда списывается при самом
    // старте, а не ждёт суточного тика — текст не обязан обещать задержку,
    // которой больше нет.
    expect(r.say).toMatch(/50 000 токенов спишется при запуске/);
    expect(r.say).not.toMatch(/в течение суток/);
    expect(r.say).toMatch(/не хватит баланса — продукт уснёт до пополнения/);
    expect(r.say).not.toMatch(/первый месяц аренды бесплатный/i);
  });

  // Продукт СУЩЕСТВУЕТ (createSite уже отработал), а конкретно чтение домена
  // сорвалось — «https://null» выглядело бы настоящим (сломанным) адресом,
  // а не как отказ одного необязательного шага.
  it('create site — домен не прочитался: без "https://null", адрес появится в списке позже', async () => {
    const h = harness();
    h.lifecycle.createSite.mockResolvedValue({ ok: true, productId: 'p-new', slug: 'magazin', domain: null, freeMonth: true, firstPromptSet: true } as any);
    const r: any = await h.svc.execute('u1', { action: 'create', kind: 'site', name: 'Магазин' }, 'web', 'turn-1');
    expect(r.say).not.toMatch(/null/);
    expect(r.say).toMatch(/адрес появится в списке продуктов через минуту-две/);
  });

  // Прислал prompt, но setFirstPrompt реально не сработал — не обещаем
  // постановку, которой не было.
  it('create site — первая правка не поставилась: обещание «поставлена» не даём', async () => {
    const h = harness();
    h.lifecycle.createSite.mockResolvedValue({ ok: true, productId: 'p-new', slug: 'magazin', domain: 'magazin.c.linkeon.io', freeMonth: true, firstPromptSet: false } as any);
    const r: any = await h.svc.execute('u1', { action: 'create', kind: 'site', name: 'Магазин', prompt: 'лендинг' }, 'web', 'turn-1');
    expect(r.say).not.toMatch(/Первая правка по описанию поставлена/);
    expect(r.say).toMatch(/Дальше — правки действием edit/);
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
    // Период (бесплатный месяц или уже оплаченный) ещё идёт — paidUntil
    // заглушки harness() в будущем (задача «Отступления очереди 1», п.3).
    expect(r.say).toMatch(/оставшийся срок до \d+ \S+ не возвращается/);
  });

  // Платный с первого дня продукт до собственного первого старта (п.1):
  // paid_until уже в прошлом, остатка нет — фраза про невозвратный срок
  // была бы пустой угрозой про несуществующий остаток.
  it('delete — у продукта уже пора платить (paid_until в прошлом) — фраза про срок не говорится', async () => {
    const h = harness();
    h.lifecycle.openDelete.mockResolvedValue({ ok: true, actionId: 'a2', expiresAt: '2026-10-25T10:30:00.000Z', paidUntil: '2020-01-01T00:00:00.000Z' } as any);
    const r: any = await h.svc.execute('u1', { action: 'delete', product: 'магазин' }, 'telegram', 't');
    expect(r.say).not.toMatch(/не возвращается/);
    expect(r.say).toMatch(/Не говори «удалил»/);
  });

  // I1 (ревью): «общий» случай — оплаченный период ещё идёт (бесплатный
  // месяц или уже оплаченный): аренда УЖЕ оплачена, chargeOnStart её не
  // спишет (его предусловие `paid_until <= now()` не совпадёт), и старый
  // текст «аренда спишется при запуске» был бы неправдой. Этот тест раньше
  // пиннил именно её — заглушка harness() по умолчанию возвращала
  // waking:true без paid, и текст всегда говорил «спишется», даже когда
  // (как в большинстве возвратов) период ещё не кончился.
  it('restore — по удалённым, оплаченный период ещё идёт: аренда не спишется, срок продолжается', async () => {
    const h = harness();
    const r = await h.svc.execute('u1', { action: 'restore', product: 'старый' });
    expect(r).toMatchObject({ ok: true, restored: { status: 'sleeping', waking: true } });
    expect(h.lifecycle.restore).toHaveBeenCalledWith({ userId: 'u1', productId: 'p9', channel: 'web' });
    expect(r.say).toBe('Вернул. Просыпается — через минуту-две заработает; оплаченный срок до 24 ноября продолжается.');
    expect(r.say).not.toMatch(/спишется/);
  });

  // I1: период истёк (paid:false), но на аренду хватает — chargeOnStart
  // спишет её при самом старте, текст обязан это сказать прямо.
  it('restore — период истёк, но баланс хватает: будим, аренда спишется при запуске', async () => {
    const h = harness();
    h.lifecycle.restore.mockResolvedValue({ ok: true, status: 'sleeping', waking: true, paid: false, paidUntil: '2020-01-01T00:00:00.000Z', balance: 70_000 } as any);
    const r: any = await h.svc.execute('u1', { action: 'restore', product: 'старый' });
    expect(r.say).toBe('Вернул. Просыпается — через минуту-две заработает; аренда 50 000 токенов спишется при запуске.');
  });

  // Баланса не хватает даже на одну аренду — restore() сам не ставит
  // пробуждение (ProductLifecycleService), и текст называет оба числа:
  // сколько нужно и сколько есть, без слова «нет токенов».
  it('restore — баланса не хватает: назвать оба числа, не обещать пополнение автоматом', async () => {
    const h = harness();
    h.lifecycle.restore.mockResolvedValue({ ok: true, status: 'sleeping', waking: false, paid: false, paidUntil: '2020-01-01T00:00:00.000Z', balance: 12_345 } as any);
    const r: any = await h.svc.execute('u1', { action: 'restore', product: 'старый' });
    expect(r.say).toBe('Вернул, но он спит: на аренду нужно 50 000 токенов, на балансе 12 345 — после пополнения проснётся сам.');
  });

  // M7 (ревью): «не хватает» различается по AFFORDABLE, а не по waking —
  // этот сценарий защитный (restore() всегда ставит wake, когда денег
  // хватает, см. комментарий там) и на практике почти не достижим, но текст
  // обязан быть честным и в нём: деньги есть, значит «не хватило токенов»
  // здесь — неправда, даже если пробуждение почему-то не встало.
  it('M7: денег хватает, но waking почему-то не встал — не «не хватило токенов», а «проснётся сам»', async () => {
    const h = harness();
    h.lifecycle.restore.mockResolvedValue({ ok: true, status: 'sleeping', waking: false, paid: false, paidUntil: '2020-01-01T00:00:00.000Z', balance: 70_000 } as any);
    const r: any = await h.svc.execute('u1', { action: 'restore', product: 'старый' });
    expect(r.say).toBe('Вернул; проснётся в течение нескольких минут, аренда 50 000 токенов спишется при запуске.');
    expect(r.say).not.toMatch(/не хватило/);
  });

  // Ревью 15b: resolveDeleted нашёл продукт (срок ещё не вышел на момент
  // чтения), но restore() под замком увидел, что дедлайн уже прошёл —
  // сырой reason="expired" сервиса не должен дойти до модели, которой
  // описание действия обещает только purged/expiring.
  it('restore — гонка с дедлайном: expired сервиса превращается в expiring, как у resolveGone', async () => {
    const h = harness();
    h.lifecycle.restore.mockResolvedValue({ ok: false, reason: 'expired', message: 'Срок возврата вышел' } as any);
    const r: any = await h.svc.execute('u1', { action: 'restore', product: 'старый' });
    expect(r).toMatchObject({ ok: false, reason: 'expiring' });
    expect(r.say).toMatch(/«Старый бот».*стирается/);
    expect(r.say).not.toMatch(/Срок возврата вышел/);
  });

  it('delete — продукт остановлен администратором: карточка не открывается, отказ доходит до ассистента', async () => {
    const h = harness();
    h.lifecycle.openDelete.mockResolvedValue({ ok: false, reason: 'blocked', message: 'Продукт остановлен администратором — удалить его можно через поддержку' } as any);
    const r = await h.svc.execute('u1', { action: 'delete', product: 'магазин' }, 'web', 't');
    expect(r).toMatchObject({ ok: false, reason: 'blocked', product: PRODUCT });
    expect(r.say).toMatch(/поддержку/);
  });

  it('restore — продукт был сломан (failed) до удаления: не обещать пополнение, не называть «спит»', async () => {
    const h = harness();
    h.lifecycle.restore.mockResolvedValue({ ok: true, status: 'failed', waking: false } as any);
    const r = await h.svc.execute('u1', { action: 'restore', product: 'старый' });
    expect(r).toMatchObject({ ok: true, restored: { status: 'failed', waking: false } });
    expect(r.say).not.toMatch(/пополнить баланс/);
    expect(r.say).toMatch(/не работал|сломан|поломк/);
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

  // Ход без метки (загрузка файла, старый токен): сервер не прикрепит
  // карточку к ответу — обещать «под ответом» модели нельзя.
  it('без метки хода — карточка в кабинете, а не «под ответом»', async () => {
    const h = harness();
    const bot = await h.svc.execute('u1', { action: 'create', kind: 'bot', name: 'Бот' }, 'web', null);
    expect(bot.say).toMatch(/Студия → Продукты/);
    expect(bot.say).not.toMatch(/Под твоим ответом/);
    const del = await h.svc.execute('u1', { action: 'delete', product: 'магазин' }, 'web', null);
    expect(del.say).toMatch(/Студия → Продукты/);
    expect(del.say).not.toMatch(/Под твоим ответом/);
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

  it('status — бот создан, достался бесплатный месяц', async () => {
    const h = harness();
    h.actions.get.mockResolvedValue({ id: 'a6', user_id: 'u1', product_id: 'p-new', kind: 'create_bot', status: 'done', channel: 'web', confirmed_via: 'chat', payload: {}, result: { productId: 'p-new', botUsername: 'shop_bot', freeMonth: true }, created_at: new Date(), expires_at: new Date(Date.now() + 60_000), resolved_at: new Date(), tg_chat_id: null, tg_message_id: null, product_name: 'Бот', purge_after: null } as any);
    const r: any = await h.svc.execute('u1', { action: 'status', actionId: 'a6' });
    expect(r.say).toMatch(/первый месяц аренды бесплатный/i);
  });

  it('status — бот создан, аренда сразу платная', async () => {
    const h = harness();
    h.actions.get.mockResolvedValue({ id: 'a7', user_id: 'u1', product_id: 'p-new', kind: 'create_bot', status: 'done', channel: 'web', confirmed_via: 'chat', payload: {}, result: { productId: 'p-new', botUsername: 'shop_bot', freeMonth: false }, created_at: new Date(), expires_at: new Date(Date.now() + 60_000), resolved_at: new Date(), tg_chat_id: null, tg_message_id: null, product_name: 'Бот', purge_after: null } as any);
    const r: any = await h.svc.execute('u1', { action: 'status', actionId: 'a7' });
    expect(r.say).toMatch(/50 000 токенов спишется при запуске/);
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

/**
 * Задача бэклога 642c5198: что ассистент узнаёт о ключах в описании. Маску
 * инструмент считает сам из входного текста — поэтому знает о ней и при
 * отказе заведения. Значение собирается во время прогона (публичный репозиторий).
 */
describe('create: ключи в описании', () => {
  const value = ['Ab', '3k', 'Q9', 'zX', '7mN', 'p2R', 'w8T', 'c5'].join('');
  const prompt = `лендинг с погодой, WEATHER_API_KEY=${value}`;

  it('сайт — secretsMasked и фраза: значения скрыты; если ключ — выпустить новый и карточка keys', async () => {
    const h = harness();
    const r: any = await h.svc.execute('u1', { action: 'create', kind: 'site', name: 'Магазин', prompt }, 'web', 'turn-1');
    expect(r.secretsMasked).toEqual({ count: 1, names: ['WEATHER_API_KEY'] });
    expect(r.say).toContain('(WEATHER_API_KEY)');
    expect(r.say).toContain('«[ключ скрыт]»');
    expect(r.say).toMatch(/Если это ключ — посоветуй выпустить новый/);
    expect(r.say).toMatch(/действие keys/);
    // Основной смысл ответа не потерялся.
    expect(r.say).toMatch(/Сайт создан/);
  });

  it('бот — то же в ответе с карточкой', async () => {
    const h = harness();
    const r: any = await h.svc.execute('u1', { action: 'create', kind: 'bot', name: 'Бот', prompt }, 'web', 'turn-1');
    expect(r.secretsMasked).toEqual({ count: 1, names: ['WEATHER_API_KEY'] });
    expect(r.say).toMatch(/защищённая карточка/);
    expect(r.say).toContain('«[ключ скрыт]»');
  });

  it('отказ заведения — о ключе всё равно сказано, без обещания, что значение заменено', async () => {
    const h = harness();
    h.lifecycle.openCreateBot.mockResolvedValue({ ok: false, reason: 'limit', message: 'Предел — 2 продукта на один аккаунт' } as any);
    const r: any = await h.svc.execute('u1', { action: 'create', kind: 'bot', name: 'Бот', prompt }, 'web', 'turn-1');
    expect(r).toMatchObject({ ok: false, reason: 'limit', secretsMasked: { count: 1, names: ['WEATHER_API_KEY'] } });
    expect(r.say).toMatch(/^Предел — 2 продукта на один аккаунт /);
    expect(r.say).toMatch(/правка не поставлена/);
    expect(r.say).not.toContain('заменила');
  });

  it('без ключей — ни поля, ни фразы', async () => {
    const h = harness();
    const r: any = await h.svc.execute('u1', { action: 'create', kind: 'site', name: 'Магазин', prompt: 'лендинг' }, 'web', 'turn-1');
    expect('secretsMasked' in r).toBe(false);
    expect(r.say).not.toContain('[ключ скрыт]');
  });
});
