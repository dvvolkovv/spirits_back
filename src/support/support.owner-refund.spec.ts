jest.mock('@napi-rs/canvas', () => ({
  createCanvas: jest.fn(),
  loadImage: jest.fn(),
  GlobalFonts: { register: jest.fn() },
}));
import { SupportService } from './support.service';
import { LIMITS } from './support.dto';

/// Возврат токенов рукой владельца и уборка своих сообщений из переписки.
///
/// Повод — тикет 14.11.2026: ассистент четырежды сказал «исправил», проблема
/// осталась, человек потратил 40 581 токен. Это больше любого потолка
/// ИИ-поддержки (10к за вызов, 20к на тикет), поэтому вернуть должен был
/// владелец — а возвращать было нечем. Решение владельца дословно: «проблема
/// в нашем продукте, мы должны сами её исправить, вернуть деньги за плохую
/// работу, не надо заставлять пользователя что-либо делать».
///
/// Поэтому проверяется не «метод отработал», а: деньги легли на баланс через
/// процедуру пополнения, сумма выше потолков модели проходит, по
/// несуществующему пользователю возврата НЕ происходит, и текст удалённого
/// сообщения не остаётся в журнале.

const TICKET = 't-refund';
const USER = '79035281880';
const OWNER = '79656445804';

function makeWorld(opts: { userExists?: boolean; messages?: any[] } = {}) {
  const userExists = opts.userExists ?? true;
  const credits: Array<{ user: string; amount: number; type: string; payload: any }> = [];
  const events: Array<{ actor: string; action: string; payload: any }> = [];
  const messages: any[] = [];
  const stored = [...(opts.messages ?? [])];
  const tx: string[] = [];

  const run = (sql: string, params: any[] = []) => {
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) {
      tx.push(sql.trim().toUpperCase());
      return { rows: [], rowCount: 0 };
    }
    if (/FROM support_tickets WHERE id/.test(sql)) {
      return { rows: [{ user_id: USER }], rowCount: 1 };
    }
    if (/FROM ai_profiles_consolidated WHERE user_id = \$1 FOR UPDATE/.test(sql)) {
      return userExists ? { rows: [{ '?column?': 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (/add_user_tokens/.test(sql)) {
      const type = /add_user_tokens\(\$1, \$2, '(\w+)'/.exec(sql)?.[1] ?? '?';
      credits.push({ user: params[0], amount: params[1], type, payload: JSON.parse(params[3]) });
      const total = credits.reduce((s, c) => s + Number(c.amount), 0);
      return { rows: [{ res: { new_balance: total } }], rowCount: 1 };
    }
    if (/INSERT INTO support_events/.test(sql)) {
      const actor = /VALUES \(\$1, '(\w+)'/.exec(sql)?.[1] ?? '?';
      const action = /'(\w+)', \$3::jsonb\)/.exec(sql)?.[1] ?? params[2];
      events.push({ actor, action, payload: JSON.parse(params[2]) });
      return { rows: [], rowCount: 1 };
    }
    if (/INSERT INTO support_messages/.test(sql)) {
      const row = { id: `m${messages.length}`, sender_type: params[1], content: params[3] };
      messages.push(row);
      return { rows: [row], rowCount: 1 };
    }
    if (/DELETE FROM support_messages/.test(sql)) {
      const i = stored.findIndex((m) => m.id === params[0]);
      if (i >= 0) stored.splice(i, 1);
      return { rows: [], rowCount: i >= 0 ? 1 : 0 };
    }
    if (/FROM support_messages WHERE id/.test(sql)) {
      const row = stored.find((m) => m.id === params[0] && params[1] === TICKET);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    return { rows: [], rowCount: 0 };
  };

  const pg = {
    query: jest.fn(async (sql: string, params: any[] = []) => run(sql, params)),
    getClient: jest.fn(async () => ({
      query: jest.fn(async (sql: string, params: any[] = []) => run(sql, params)),
      release: jest.fn(),
    })),
  };
  const svc = new SupportService(pg as any, {} as any, {} as any, {} as any, {} as any, {} as any);
  return { svc, credits, events, messages, stored, tx };
}

describe('возврат рукой владельца', () => {
  it('кладёт токены на баланс через процедуру пополнения', async () => {
    const w = makeWorld();

    const out = await w.svc.ownerRefund(TICKET, OWNER, 41_000, 'серия правок не дала результата');

    expect(w.credits).toEqual([expect.objectContaining({ user: USER, amount: 41_000, type: 'refund' })]);
    // иначе возврата не видно в истории пополнений человека
    expect(out).toEqual(expect.objectContaining({ ok: true, amount: 41_000, new_balance: 41_000 }));
    expect(w.tx).toEqual(['BEGIN', 'COMMIT']);
  });

  it('пропускает сумму выше потолков ИИ-поддержки — в этом и смысл ручки', async () => {
    const w = makeWorld();
    const beyondAi = LIMITS.REFUND_MAX_PER_TICKET + 1;

    await w.svc.ownerRefund(TICKET, OWNER, beyondAi, 'возврат за плохую работу');

    expect(w.credits[0].amount).toBe(beyondAi);
  });

  it('пишет в журнал тикета, что возврат сделал владелец', async () => {
    const w = makeWorld();

    await w.svc.ownerRefund(TICKET, OWNER, 1_000, 'тест');

    expect(w.events).toEqual([expect.objectContaining({
      actor: 'owner', action: 'refund', payload: expect.objectContaining({ amount: 1_000 }),
    })]);
  });

  it('человек видит начисление в переписке', async () => {
    const w = makeWorld();

    await w.svc.ownerRefund(TICKET, OWNER, 41_000, 'тест');

    expect(w.messages).toHaveLength(1);
    // пробел в «41 000» неразрывный — он приходит из toLocaleString
    expect(w.messages[0].content).toMatch(/Начислено 41.000 токенов/);
  });

  it('по несуществующему пользователю ничего не начисляет', async () => {
    // add_user_tokens на отсутствующей строке отрабатывает без ошибки и
    // трогает ноль строк: без этой проверки ответ был бы «успех» при
    // прежнем балансе.
    const w = makeWorld({ userExists: false });

    await expect(w.svc.ownerRefund(TICKET, OWNER, 1_000, 'тест')).rejects.toThrow();

    expect(w.credits).toEqual([]);
    expect(w.tx).toEqual(['BEGIN', 'ROLLBACK']);
  });

  it.each([[0], [-5], [LIMITS.OWNER_REFUND_MAX + 1]])('не берёт сумму %p', async (amount) => {
    const w = makeWorld();
    await expect(w.svc.ownerRefund(TICKET, OWNER, amount, 'тест')).rejects.toThrow();
    expect(w.credits).toEqual([]);
  });

  it('требует причину — возврат без причины не разобрать потом', async () => {
    const w = makeWorld();
    await expect(w.svc.ownerRefund(TICKET, OWNER, 1_000, '   ')).rejects.toThrow();
    expect(w.credits).toEqual([]);
  });
});

describe('удаление сообщения из переписки', () => {
  const owner = { id: 'm-owner', sender_type: 'owner', content: 'промокод VOZVRAT-XXXX' };
  const user = { id: 'm-user', sender_type: 'user', content: 'серия правок не дала результата' };

  it('убирает сообщение поддержки', async () => {
    const w = makeWorld({ messages: [owner, user] });

    await w.svc.deleteMessage(TICKET, OWNER, 'm-owner');

    expect(w.stored.map((m) => m.id)).toEqual(['m-user']);
  });

  it('не трогает слова человека', async () => {
    const w = makeWorld({ messages: [owner, user] });

    await expect(w.svc.deleteMessage(TICKET, OWNER, 'm-user')).rejects.toThrow();

    expect(w.stored.map((m) => m.id)).toEqual(['m-owner', 'm-user']);
  });

  it('не переписывает удалённый текст в журнал', async () => {
    // Удаляют обычно как раз то, чего в переписке быть не должно, —
    // копия в журнале свела бы удаление на нет.
    const w = makeWorld({ messages: [owner] });

    await w.svc.deleteMessage(TICKET, OWNER, 'm-owner');

    expect(JSON.stringify(w.events)).not.toContain('VOZVRAT');
    expect(w.events[0]).toEqual(expect.objectContaining({ actor: 'owner', action: 'message_deleted' }));
  });
});
