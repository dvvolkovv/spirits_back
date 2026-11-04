jest.mock('@napi-rs/canvas', () => ({
  createCanvas: jest.fn(),
  loadImage: jest.fn(),
  GlobalFonts: { register: jest.fn() },
}));

import { SupportService } from './support.service';

const TICKET = '11111111-1111-4111-8111-111111111111';

function makeService() {
  const messages: any[] = [];
  const events: any[] = [];
  const queries: Array<{ sql: string; params?: any[] }> = [];
  const query = jest.fn(async (sql: string, params?: any[]) => {
    queries.push({ sql, params });
    if (/SELECT status FROM support_tickets/.test(sql)) {
      return { rows: [{ status: 'escalated' }] };
    }
    if (/INSERT INTO support_messages/.test(sql)) {
      const row = {
        ticket_id: params?.[0],
        sender_type: params?.[1],
        sender_id: params?.[2],
        content: params?.[3],
        metadata: params?.[4] ? JSON.parse(params[4]) : null,
        visible_to_user: params?.[5],
      };
      messages.push(row);
      return { rows: [row] };
    }
    if (/INSERT INTO support_events/.test(sql)) {
      events.push({
        ticket_id: params?.[0],
        actor_id: params?.[1],
        action: sql.includes("'status_change'") ? 'status_change' : 'reply',
        payload: params?.[2] ? JSON.parse(params[2]) : null,
      });
    }
    return { rows: [] };
  });
  const client = { query, release: jest.fn() };
  const pg = { query, getClient: jest.fn(async () => client) };
  const service = new SupportService(pg as any);
  const email = jest.spyOn(service, 'notifyOwnerReplyByEmail').mockResolvedValue({ sent: true });
  return { service, messages, events, queries, email, client };
}

describe('авторство ответов и действий из Telegram', () => {
  afterEach(() => jest.restoreAllMocks());

  it('сохраняет аккаунт админа, Telegram-метаданные и прежнее поведение видимого ответа', async () => {
    const { service, messages, events, queries, email, client } = makeService();

    await service.postOwnerReplyFromTelegram(TICKET, '111', 'Дмитрий', 'текст', true, 'u-admin');
    await service.setStatusFromTelegram(TICKET, '111', 'resolved', 'u-admin');

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      sender_id: 'u-admin',
      visible_to_user: true,
      metadata: { via: 'telegram', telegramUserId: '111', author: 'Дмитрий' },
    });
    expect(events).toEqual([
      expect.objectContaining({
        actor_id: 'u-admin',
        action: 'reply',
        payload: expect.objectContaining({ via: 'telegram', telegramUserId: '111', author: 'Дмитрий' }),
      }),
      expect.objectContaining({
        actor_id: 'u-admin',
        action: 'status_change',
        payload: expect.objectContaining({ via: 'telegram', telegramUserId: '111', status: 'resolved' }),
      }),
    ]);

    // Видимый ответ по-прежнему заполняет SLA, переводит тикет оператору и шлёт email.
    const replyUpdate = queries.find(({ sql }) => /first_owner_reply_at/.test(sql));
    expect(replyUpdate?.sql).toContain("status = CASE WHEN status IN ('escalated','ai_handling') THEN 'owner_handling'");
    expect(email).toHaveBeenCalledWith(TICKET, 'текст');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('без аккаунта админа сохраняет legacy-автора tg:<telegramUserId>', async () => {
    const { service, messages, events } = makeService();

    await service.postOwnerReplyFromTelegram(TICKET, '111', 'Дмитрий', 'текст');
    await service.setStatusFromTelegram(TICKET, '111', 'resolved');

    expect(messages[0].sender_id).toBe('tg:111');
    expect(messages[0].metadata).toMatchObject({ via: 'telegram', telegramUserId: '111', author: 'Дмитрий' });
    expect(events.map((event) => event.actor_id)).toEqual(['tg:111', 'tg:111']);
  });

  it('внутренний ответ не меняет SLA и не инициирует email', async () => {
    const { service, queries, email } = makeService();

    await service.postOwnerReplyFromTelegram(TICKET, '111', 'Дмитрий', 'заметка', false, 'u-admin');

    expect(queries.some(({ sql }) => /first_owner_reply_at/.test(sql))).toBe(false);
    expect(email).not.toHaveBeenCalled();
  });
});
