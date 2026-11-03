import { RoutinePushService } from './routine-push.service';

/**
 * Ревью 26.10.2026: linkeonTools — явное включение, по умолчанию false
 * (src/chat/chat.service.ts, AgentReplyOpts). Рутина — один из путей, где
 * ассистент реально может позвать инструмент (картинка, рутина, календарь),
 * поэтому deliver() передаёт его явно.
 *
 * Ревью 03.11: deliver() зовёт generateAgentReplyOutcome (не
 * generateAgentReply) — нужен failReason для политики повтора дня (см.
 * routine-push.busy.spec.ts). linkeonTools передаётся туда же, тем же опциями.
 */
describe('рутинный пуш: linkeonTools: true', () => {
  it('fireNow зовёт generateAgentReplyOutcome с { linkeonTools: true }', async () => {
    const pg = { query: jest.fn(async () => ({ rows: [] })) };
    const push = { sendPush: jest.fn(async () => 1) };
    const chat = { generateAgentReplyOutcome: jest.fn(async () => ({ text: 'Доброе утро!', failed: false })) };
    const store = {
      getById: jest.fn(async () => ({
        id: 'r1', userId: 'u1', title: 'Энергия дня', assistantId: '14',
        prompt: 'энергия дня', sendHour: 8, tz: 'Europe/Moscow', days: null,
        enabled: true, lastSentDate: null,
      })),
    };
    const svc = new RoutinePushService(pg as any, push as any, chat as any, store as any);
    await svc.fireNow('u1', 'r1');
    expect(chat.generateAgentReplyOutcome).toHaveBeenCalledWith('u1', '14', 'энергия дня', undefined, { linkeonTools: true });
  });
});
