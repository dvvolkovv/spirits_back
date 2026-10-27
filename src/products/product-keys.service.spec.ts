import { ProductKeysService } from './product-keys.service';
import { SecretsService } from './secrets.service';

const KEY = '00112233445566778899aabbccddeeff0f1e2d3c4b5a69788796a5b4c3d2e1f0';
const secrets = new SecretsService({ get: (k: string) => (k === 'PRODUCT_SECRETS_KEY' ? KEY : undefined) } as any);
const PID = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001';
const AID = 'aaaaaaaa-bbbb-4ccc-8ddd-0000000000a1';
const CANARY = 'КАНАРЕЙКА-значение-ключа-7f3e';

function harness(o: {
  status?: string; kind?: 'site' | 'bot'; block?: string | null; old?: Record<string, string>; turns?: number; jobs?: number;
  taken?: boolean; queued?: number; tgBotId?: number | null;
  /** Продукта нет уже к отправке. */
  gone?: boolean;
  /** Каким продукт читается ПОСЛЕ записи задания (перечитывание при queued 0). */
  after?: { status?: string; block?: string | null; gone?: boolean };
  insertError?: any;
  busyError?: any;
} = {}) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  let inserted = false;
  const product = {
    id: PID, name: 'Бот', slug: 'bot-x', kind: o.kind ?? 'bot', status: o.status ?? 'running',
    block_reason: o.block ?? null, tg_bot_id: o.tgBotId ?? 111,
    secrets_encrypted: secrets.encrypt(o.old ?? { BOT_TOKEN: '111111:TEST-old', OLD_KEY: 'o' }, PID),
  };
  const pg = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      // Запись задания — ПЕРВОЙ: в её SQL есть и `FROM product_turns t`
      // (условие «нет живой правки»), и ветка проверки занятости ниже
      // перехватила бы её.
      if (sql.includes('INSERT INTO product_provision_jobs')) {
        inserted = true;
        if (o.insertError) throw o.insertError;
        return { rows: [{ queued: o.queued ?? 1 }] };
      }
      if (sql.includes('FROM products') && sql.includes('user_id = $2')) {
        if (inserted && o.after) {
          return o.after.gone ? { rows: [] } : { rows: [{ ...product, status: o.after.status ?? product.status, block_reason: o.after.block ?? product.block_reason }] };
        }
        return { rows: o.gone ? [] : [product] };
      }
      if (sql.includes('FROM product_turns')) {
        if (o.busyError) throw o.busyError;
        return { rows: [{ turns: o.turns ?? 0, jobs: o.jobs ?? 0 }] };
      }
      if (sql.includes('tg_bot_id = $1')) return { rows: o.taken ? [{ x: 1 }] : [] };
      return { rows: [] };
    }),
  };
  const actions = {
    open: jest.fn(async () => ({ id: AID, expiresAt: '2026-10-26T10:30:00.000Z' })),
    claim: jest.fn(async () => ({ id: AID, user_id: 'u1', product_id: PID, kind: 'keys', status: 'working', channel: 'web', payload: {}, result: null })),
    release: jest.fn(async () => undefined),
    finish: jest.fn(async () => undefined),
  };
  const svc = new ProductKeysService(pg as any, actions as any, secrets);
  (svc as any).checkBot = jest.fn(async () => ({ ok: true, id: 222, username: 'new_bot' }));
  return { svc, pg, calls, actions, product };
}

function captureLogs(svc: ProductKeysService): string[] {
  const logs: string[] = [];
  (svc as any).logger = { warn: (m: string) => logs.push(m), error: (m: string) => logs.push(m), log: (m: string) => logs.push(m) };
  return logs;
}

describe('карточка ключей: открыть', () => {
  it('в карточку — имена текущих ключей по алфавиту, без значений', async () => {
    const h = harness({ old: { OLD_KEY: CANARY, BOT_TOKEN: '111111:TEST-old' } });
    const r = await h.svc.open({ userId: 'u1', productId: PID, channel: 'web', turn: null });
    expect(r).toMatchObject({ ok: true, actionId: AID, keyNames: ['BOT_TOKEN', 'OLD_KEY'] });
    expect(h.actions.open).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'keys', productId: PID,
      payload: { name: 'Бот', slug: 'bot-x', productKind: 'bot', keyNames: ['BOT_TOKEN', 'OLD_KEY'] },
    }));
    expect(JSON.stringify(h.actions.open.mock.calls)).not.toContain(CANARY);
  });

  it.each([
    ['sleeping', null, 'sleeping'],
    ['blocked', 'нарушение', 'blocked'],
    ['running', 'нарушение', 'blocked'],
    ['provisioning', null, 'provisioning'],
    ['failed', null, 'failed_product'],
  ])('статус %s (блок %s) — отказ %s, карточка не открывается', async (status, block, reason) => {
    const h = harness({ status, block });
    const r = await h.svc.open({ userId: 'u1', productId: PID, channel: 'web', turn: null });
    expect(r).toMatchObject({ ok: false, reason });
    expect(h.actions.open).not.toHaveBeenCalled();
  });

  it('коробка продукта не читается — отказ; текст SyntaxError (цитата расшифрованного) в лог не идёт', async () => {
    const h = harness();
    const logs = captureLogs(h.svc);
    const spy = jest.spyOn(secrets, 'decrypt').mockImplementationOnce(() => {
      throw new SyntaxError(`Unexpected token in JSON at position 3: "${CANARY}"`);
    });
    try {
      expect(await h.svc.open({ userId: 'u1', productId: PID, channel: 'web', turn: null })).toMatchObject({ ok: false, reason: 'failed' });
    } finally {
      spy.mockRestore();
    }
    expect(h.actions.open).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain(PID);
    expect(logs.join('\n')).not.toContain(CANARY);
  });
});

describe('карточка ключей: отправить', () => {
  const send = (h: ReturnType<typeof harness>, set: unknown, remove: unknown = []) =>
    h.svc.complete({ userId: 'u1', actionId: AID, set, remove, via: 'chat' });

  it('замена, удаление и добавление — один оператор с заданием и коробкой; в payload только имена', async () => {
    const h = harness();
    const r = await send(h, { NEW_KEY: CANARY }, ['OLD_KEY']);
    expect(r).toEqual({ ok: true, queued: true });
    const ins = h.calls.find((c) => c.sql.includes('INSERT INTO product_provision_jobs'))!;
    expect(ins.sql).toMatch(/'rekey'/);
    expect(ins.sql).toMatch(/secrets_box = \$2/);
    const [actionId, box, patch] = ins.params;
    expect(actionId).toBe(AID);
    expect(secrets.decrypt(box, PID)).toEqual({ BOT_TOKEN: '111111:TEST-old', NEW_KEY: CANARY });
    expect(JSON.parse(patch)).toEqual({ newKeyNames: ['BOT_TOKEN', 'NEW_KEY'], removedNames: ['OLD_KEY'], changedNames: ['NEW_KEY'] });
    expect(h.actions.release).not.toHaveBeenCalled();
    expect(h.actions.finish).not.toHaveBeenCalled();
  });

  it('значение ключа не уходит никуда, кроме коробки: ни в SQL-параметры текстом, ни в ответ, ни в лог', async () => {
    const h = harness();
    const logs = captureLogs(h.svc);
    const r = await send(h, { NEW_KEY: CANARY, BAD_ONE: '' });
    const textParams = h.calls.flatMap((c) => c.params).filter((p) => !Buffer.isBuffer(p));
    expect(JSON.stringify(textParams)).not.toContain(CANARY);
    expect(JSON.stringify(r)).not.toContain(CANARY);
    expect(JSON.stringify(h.actions.release.mock.calls)).not.toContain(CANARY);
    expect(logs.join('\n')).not.toContain(CANARY);
  });

  it('и при успехе значение — только в коробке: payload, ответ и лог без него', async () => {
    const h = harness();
    const logs = captureLogs(h.svc);
    const r = await send(h, { NEW_KEY: CANARY });
    expect(r).toEqual({ ok: true, queued: true });
    const textParams = h.calls.flatMap((c) => c.params).filter((p) => !Buffer.isBuffer(p));
    expect(JSON.stringify(textParams)).not.toContain(CANARY);
    expect(logs.join('\n')).not.toContain(CANARY);
  });

  it.each([
    [{}, [], 'nothing'],
    [{ A: 'x' }, ['A'], 'bad_input'],
    [{ PORT: '1' }, [], 'bad_input'],
    [{ OWNER_TG_ID: '1' }, [], 'bad_input'],
    [{ 'A B': '1' }, [], 'bad_input'],
    [{ A: '' }, [], 'bad_input'],
    // Пустое имя: отказ формы имени приходит с field: '' — проверка
    // истинности поля отнесла бы его к too_many.
    [{ '': 'x' }, [], 'bad_input'],
    [{}, ['BOT_TOKEN'], 'bot_token'],
    [{}, ['NO_SUCH'], 'bad_input'],
    ['не объект', [], 'bad_shape'],
    [{}, 'не список', 'bad_shape'],
    [Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`K${i}`, 'v'])), [], 'too_many'],
  ])('set %j, remove %j — поправимо (%s): карточка снова ждёт, задания нет', async (set, remove, reason) => {
    const h = harness();
    const r = await send(h, set, remove);
    expect(r).toMatchObject({ ok: false, reason });
    // reason — в result карточки: по нему фронт переводит текст.
    expect(h.actions.release).toHaveBeenCalledWith(AID, expect.objectContaining({ error: expect.any(String), reason }));
    expect(h.calls.some((c) => c.sql.includes('INSERT INTO product_provision_jobs'))).toBe(false);
  });

  it('ключ с именем __proto__ из тела запроса не теряется молча — как у заведения, он в наборе', async () => {
    const h = harness();
    expect(await send(h, JSON.parse('{"__proto__":"p"}'))).toEqual({ ok: true, queued: true });
    const ins = h.calls.find((c) => c.sql.includes('INSERT INTO product_provision_jobs'))!;
    expect(Object.keys(secrets.decrypt(ins.params[1], PID))).toEqual(['BOT_TOKEN', 'OLD_KEY', '__proto__']);
    expect(JSON.parse(ins.params[2]).changedNames).toEqual(['__proto__']);
  });

  it('пустое имя ключа — field: "" доезжает до карточки', async () => {
    const h = harness();
    await send(h, { '': 'x' });
    expect(h.actions.release).toHaveBeenCalledWith(AID, expect.objectContaining({ reason: 'bad_input', field: '' }));
  });

  it('старый ключ с именем, занятым позже (OWNER_TG_ID, DOTENV_*), смене другого ключа не мешает: ни в набор, ни в снимаемые', async () => {
    const h = harness({ old: { BOT_TOKEN: '111111:TEST-old', OWNER_TG_ID: '42', DOTENV_KEY: 'd', OLD_KEY: 'o' } });
    const opened = await h.svc.open({ userId: 'u1', productId: PID, channel: 'web', turn: null });
    // В карточке таких имён нет: ни оставить, ни снять их агент не даст.
    expect(opened).toMatchObject({ ok: true, keyNames: ['BOT_TOKEN', 'OLD_KEY'] });
    expect(await send(h, { OLD_KEY: 'новое' })).toEqual({ ok: true, queued: true });
    const ins = h.calls.find((c) => c.sql.includes('INSERT INTO product_provision_jobs'))!;
    expect(secrets.decrypt(ins.params[1], PID)).toEqual({ BOT_TOKEN: '111111:TEST-old', OLD_KEY: 'новое' });
    expect(JSON.parse(ins.params[2])).toEqual({ newKeyNames: ['BOT_TOKEN', 'OLD_KEY'], removedNames: [], changedNames: ['OLD_KEY'] });
  });

  it('снять старый ключ с занятым именем карточкой нельзя — поправимо, поле этого ключа', async () => {
    const h = harness({ old: { BOT_TOKEN: '111111:TEST-old', OWNER_TG_ID: '42' } });
    expect(await send(h, {}, ['OWNER_TG_ID'])).toMatchObject({ ok: false, reason: 'bad_input' });
    expect(h.actions.release).toHaveBeenCalledWith(AID, expect.objectContaining({ reason: 'bad_input', field: 'OWNER_TG_ID' }));
    expect(h.calls.some((c) => c.sql.includes('INSERT INTO product_provision_jobs'))).toBe(false);
  });

  it('идёт правка или машина занята — поправимо, своим текстом', async () => {
    const a = harness({ turns: 1 });
    expect(await send(a, { NEW_KEY: 'n' })).toMatchObject({ ok: false, reason: 'busy_turn' });
    const b = harness({ jobs: 1 });
    expect(await send(b, { NEW_KEY: 'n' })).toMatchObject({ ok: false, reason: 'busy' });
  });

  it('новый BOT_TOKEN: getMe; Telegram не принял — поправимо, поле BOT_TOKEN, задания нет', async () => {
    const h = harness();
    (h.svc as any).checkBot = jest.fn(async () => ({ ok: false, reason: 'rejected' }));
    const r = await send(h, { BOT_TOKEN: '222222:TEST-new' });
    expect(r).toMatchObject({ ok: false, reason: 'bad_token' });
    expect(h.actions.release).toHaveBeenCalledWith(AID, expect.objectContaining({ field: 'BOT_TOKEN', reason: 'bad_token' }));
    expect(h.calls.some((c) => c.sql.includes('INSERT INTO product_provision_jobs'))).toBe(false);
  });

  it('новый токен ТОГО ЖЕ бота (перевыпуск в @BotFather) — без tgBotId и без проверки занятости', async () => {
    const h = harness();
    (h.svc as any).checkBot = jest.fn(async () => ({ ok: true, id: 111, username: 'same_bot' }));
    expect(await send(h, { BOT_TOKEN: '111111:TEST-reissued' })).toEqual({ ok: true, queued: true });
    expect(h.calls.some((c) => c.sql.includes('tg_bot_id = $1'))).toBe(false);
    const ins = h.calls.find((c) => c.sql.includes('INSERT INTO product_provision_jobs'))!;
    expect(JSON.parse(ins.params[2])).not.toHaveProperty('tgBotId');
  });

  it('сайт может убрать BOT_TOKEN — Telegram не спрашивается', async () => {
    const h = harness({ kind: 'site', old: { BOT_TOKEN: '111111:TEST-old', A: 'a' } });
    expect(await send(h, {}, ['BOT_TOKEN'])).toEqual({ ok: true, queued: true });
    expect((h.svc as any).checkBot).not.toHaveBeenCalled();
    const ins = h.calls.find((c) => c.sql.includes('INSERT INTO product_provision_jobs'))!;
    expect(secrets.decrypt(ins.params[1], PID)).toEqual({ A: 'a' });
    expect(JSON.parse(ins.params[2])).toMatchObject({ newKeyNames: ['A'], removedNames: ['BOT_TOKEN'] });
  });

  it('у сайта BOT_TOKEN — обычный ключ: значение не обрезается и Telegram не спрашивается', async () => {
    const h = harness({ kind: 'site', old: { A: 'a' } });
    expect(await send(h, { BOT_TOKEN: '  как есть  ' })).toEqual({ ok: true, queued: true });
    expect((h.svc as any).checkBot).not.toHaveBeenCalled();
    const ins = h.calls.find((c) => c.sql.includes('INSERT INTO product_provision_jobs'))!;
    expect(secrets.decrypt(ins.params[1], PID)).toEqual({ A: 'a', BOT_TOKEN: '  как есть  ' });
  });

  it('пустой итоговый набор — коробка всё равно пишется (от {}), newKeyNames []: NULL в продукте ставит отчёт', async () => {
    const h = harness({ kind: 'site', old: { A: 'a' } });
    expect(await send(h, {}, ['A'])).toEqual({ ok: true, queued: true });
    const ins = h.calls.find((c) => c.sql.includes('INSERT INTO product_provision_jobs'))!;
    expect(Buffer.isBuffer(ins.params[1])).toBe(true);
    expect(secrets.decrypt(ins.params[1], PID)).toEqual({});
    expect(JSON.parse(ins.params[2])).toEqual({ newKeyNames: [], removedNames: ['A'], changedNames: [] });
  });

  it('отправка без перемены значений не отбивается — пересоздание доставляет OWNER_TG_ID и чистит занятые имена', async () => {
    const h = harness({ old: { BOT_TOKEN: '111111:TEST-old', OWNER_TG_ID: '42', OLD_KEY: 'o' } });
    expect(await send(h, { OLD_KEY: 'o' })).toEqual({ ok: true, queued: true });
    const ins = h.calls.find((c) => c.sql.includes('INSERT INTO product_provision_jobs'))!;
    expect(JSON.parse(ins.params[2])).toEqual({ newKeyNames: ['BOT_TOKEN', 'OLD_KEY'], removedNames: [], changedNames: [] });
  });

  it('негодное имя не возвращается целиком ни в error, ни в field — ни в set, ни в remove', async () => {
    const pasted = 'sk-live-abcdefghijklmnopqrstuvwxyz';
    const a = harness();
    expect(await send(a, { [pasted]: 'x' })).toMatchObject({ ok: false, reason: 'bad_input' });
    expect(a.actions.release).toHaveBeenCalledWith(AID, expect.objectContaining({ field: 'sk-live-…' }));
    const b = harness();
    expect(await send(b, {}, [pasted])).toMatchObject({ ok: false, reason: 'bad_input' });
    expect(b.actions.release).toHaveBeenCalledWith(AID, expect.objectContaining({ field: 'sk-live-…' }));
    const c = harness();
    expect(await send(c, { [pasted]: 42 })).toMatchObject({ ok: false, reason: 'bad_input' });
    expect(c.actions.release).toHaveBeenCalledWith(AID, expect.objectContaining({ field: 'sk-live-…' }));
    const d = harness();
    expect(await send(d, { [pasted]: 'x' }, [pasted])).toMatchObject({ ok: false, reason: 'bad_input' });
    for (const h of [a, b, c, d]) {
      expect(JSON.stringify(h.actions.release.mock.calls)).not.toContain('abcdefgh');
    }
  });

  it('нулевой байт в значении — поправимо (bad_input), задания нет', async () => {
    const h = harness();
    expect(await send(h, { NEW_KEY: 'a' + String.fromCharCode(0) + 'b' })).toMatchObject({ ok: false, reason: 'bad_input' });
    expect(h.actions.release).toHaveBeenCalledWith(AID, expect.objectContaining({ field: 'NEW_KEY' }));
    expect(h.calls.some((c) => c.sql.includes('INSERT INTO product_provision_jobs'))).toBe(false);
  });

  it('Telegram не ответил — своя причина token_unchecked: «попробуйте через минуту», а не «не принял»', async () => {
    const h = harness();
    (h.svc as any).checkBot = jest.fn(async () => ({ ok: false, reason: 'unreachable' }));
    expect(await send(h, { BOT_TOKEN: '222222:TEST-new' })).toMatchObject({ ok: false, reason: 'token_unchecked' });
  });

  it('запись задания не встаёт поверх живой правки — условие в самом INSERT', async () => {
    const h = harness();
    await send(h, { NEW_KEY: 'n' });
    const ins = h.calls.find((c) => c.sql.includes('INSERT INTO product_provision_jobs'))!;
    expect(ins.sql).toMatch(/NOT EXISTS \(SELECT 1 FROM product_turns t/);
  });

  it('новый BOT_TOKEN другого бота, который уже в живом продукте, — поправимо, задания нет', async () => {
    const h = harness({ taken: true });
    expect(await send(h, { BOT_TOKEN: '222222:TEST-new' })).toMatchObject({ ok: false, reason: 'bot_in_use' });
    expect(h.actions.release).toHaveBeenCalledWith(AID, expect.objectContaining({ field: 'BOT_TOKEN', reason: 'bot_in_use' }));
    expect(h.calls.some((c) => c.sql.includes('INSERT INTO product_provision_jobs'))).toBe(false);
  });

  it('новый BOT_TOKEN свободного бота — tgBotId в payload, токен без пробелов по краям', async () => {
    const h = harness();
    await send(h, { BOT_TOKEN: '  222222:TEST-new  ' });
    expect((h.svc as any).checkBot).toHaveBeenCalledWith('222222:TEST-new');
    const ins = h.calls.find((c) => c.sql.includes('INSERT INTO product_provision_jobs'))!;
    expect(JSON.parse(ins.params[2]).tgBotId).toBe(222);
  });

  it('тот же BOT_TOKEN — Telegram не спрашивается', async () => {
    const h = harness();
    await send(h, { BOT_TOKEN: '111111:TEST-old', NEW_KEY: 'n' });
    expect((h.svc as any).checkBot).not.toHaveBeenCalled();
  });

  it.each([['sleeping', null], ['running', 'блок']])('продукт в %s (блок %s) к моменту отправки — карточка failed', async (status, block) => {
    const h = harness({ status, block });
    const r = await send(h, { NEW_KEY: 'n' });
    expect(r.ok).toBe(false);
    expect(h.actions.finish).toHaveBeenCalledWith(AID, 'failed', expect.objectContaining({ error: expect.any(String) }));
  });

  it('задание не встало, а продукт жив — значит, встала правка: поправимо (busy_turn), коробки нет', async () => {
    const h = harness({ queued: 0 });
    expect(await send(h, { NEW_KEY: 'n' })).toMatchObject({ ok: false, reason: 'busy_turn' });
    expect(h.actions.release).toHaveBeenCalledWith(AID, expect.objectContaining({ reason: 'busy_turn' }));
    expect(h.actions.finish).not.toHaveBeenCalled();
    // Перечитан тот же продукт тем же владельцем.
    const reads = h.calls.filter((c) => c.sql.includes('FROM products') && c.sql.includes('user_id = $2'));
    expect(reads).toHaveLength(2);
    expect(reads[1].params).toEqual([PID, 'u1']);
  });

  it.each([
    [{ status: 'sleeping' }, 'sleeping'],
    [{ block: 'нарушение' }, 'blocked'],
    [{ gone: true }, 'gone'],
  ])('задание не встало, продукт перечитан как %j — failed своей причиной (%s)', async (after, reason) => {
    const h = harness({ queued: 0, after });
    expect(await send(h, { NEW_KEY: 'n' })).toMatchObject({ ok: false, reason });
    expect(h.actions.finish).toHaveBeenCalledWith(AID, 'failed', expect.objectContaining({ reason }));
    expect(h.actions.release).not.toHaveBeenCalled();
  });

  it('задание другого вида встало между проверкой и записью (23505 one_active) — busy, карточка снова ждёт', async () => {
    const h = harness({ insertError: Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'product_provision_jobs_one_active' }) });
    expect(await send(h, { NEW_KEY: 'n' })).toMatchObject({ ok: false, reason: 'busy' });
    expect(h.actions.release).toHaveBeenCalledWith(AID, expect.objectContaining({ reason: 'busy' }));
    expect(h.actions.finish).not.toHaveBeenCalled();
  });

  it('продукта уже нет к отправке — failed (gone), задания нет', async () => {
    const h = harness({ gone: true });
    expect(await send(h, { NEW_KEY: 'n' })).toMatchObject({ ok: false, reason: 'gone' });
    expect(h.actions.finish).toHaveBeenCalledWith(AID, 'failed', expect.objectContaining({ reason: 'gone' }));
    expect(h.calls.some((c) => c.sql.includes('INSERT INTO product_provision_jobs'))).toBe(false);
  });

  it('чужая, закрытая или просроченная карточка — not_pending, база не трогается', async () => {
    const h = harness();
    h.actions.claim.mockResolvedValueOnce(null as any);
    expect(await send(h, { NEW_KEY: 'n' })).toMatchObject({ ok: false, reason: 'not_pending' });
    expect(h.calls).toHaveLength(0);
  });

  it('карточка другого вида — возвращается в ожидание как была, not_pending, база не трогается', async () => {
    const h = harness();
    h.actions.claim.mockResolvedValueOnce({ id: AID, user_id: 'u1', product_id: PID, kind: 'delete', status: 'working', channel: 'web', payload: {}, result: { error: 'прежнее' } } as any);
    expect(await send(h, { NEW_KEY: 'n' })).toMatchObject({ ok: false, reason: 'not_pending' });
    expect(h.actions.release).toHaveBeenCalledWith(AID, { error: 'прежнее' });
    expect(h.calls).toHaveLength(0);
  });

  it('коробка продукта не читается при отправке — failed («напишите в поддержку»), а не повтор; SyntaxError в лог не идёт', async () => {
    const h = harness();
    const logs = captureLogs(h.svc);
    const spy = jest.spyOn(secrets, 'decrypt').mockImplementationOnce(() => {
      throw new SyntaxError(`Unexpected token in JSON at position 3: "${CANARY}"`);
    });
    try {
      expect(await send(h, { NEW_KEY: 'n' })).toMatchObject({ ok: false, reason: 'failed' });
    } finally {
      spy.mockRestore();
    }
    expect(h.actions.finish).toHaveBeenCalledWith(AID, 'failed', expect.objectContaining({ reason: 'failed', error: expect.stringMatching(/поддержку/) }));
    expect(h.actions.release).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain(PID);
    expect(logs.join('\n')).not.toContain(CANARY);
  });

  it('ошибка между claim и исходом — карточка снова ждёт с reason failed; текст SyntaxError в лог не идёт', async () => {
    const h = harness({ busyError: new SyntaxError(`Unexpected token in JSON at position 3: "${CANARY}"`) });
    const logs = captureLogs(h.svc);
    expect(await send(h, { NEW_KEY: 'n' })).toMatchObject({ ok: false, reason: 'failed' });
    expect(h.actions.release).toHaveBeenCalledWith(AID, expect.objectContaining({ error: expect.any(String), reason: 'failed' }));
    expect(logs.join('\n')).not.toContain(CANARY);
  });
});
