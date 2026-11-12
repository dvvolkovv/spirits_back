import { ChatService } from '../chat/chat.service';
import { RoutinePushController } from './routine-push.controller';
import { RoutinePushService } from './routine-push.service';

describe('рутинный пуш: outcome и linkeonTools', () => {
  it('fireNow зовёт generateAgentReplyOutcome с { linkeonTools: true }', async () => {
    const pg = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes("SELECT 1 FROM user_id WHERE internal_id=$1 AND state='active'")) {
          return { rows: [{ '?column?': 1 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
    };
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

    expect(chat.generateAgentReplyOutcome).toHaveBeenCalledWith(
      'u1', '14', 'энергия дня', undefined, { linkeonTools: true },
    );
  });

  it('ChatService outcome сохраняет failed/failReason, legacy text API скрывает обрывок', async () => {
    const chat = Object.create(ChatService.prototype) as any;
    chat.agentReply = jest.fn(async () => ({
      text: 'обрывок', failed: true, failReason: 'preempted',
    }));

    await expect(chat.generateAgentReplyOutcome('u1', '14', 'prompt')).resolves.toEqual({
      text: 'обрывок', failed: true, failReason: 'preempted',
    });
    await expect(chat.generateAgentReply('u1', '14', 'prompt')).resolves.toBe('');
  });

  it.each([
    [{ delivered: 0, busy: true }, { ok: true, delivered: 0, busy: true }],
    [{ delivered: 0, failed: true, failReason: 'max_turns' }, { ok: true, delivered: 0, failed: true }],
  ])('controller test action возвращает исход %j', async (result, expected) => {
    const routines = { fireNow: jest.fn(async () => result) };
    const controller = new RoutinePushController(routines as any, {} as any);
    const json = jest.fn((value) => value);
    const res = { json, status: jest.fn(() => ({ json })) };

    await controller.mutate({ userId: 'u1' }, { action: 'test', id: 'r1' }, res as any);

    expect(json).toHaveBeenCalledWith(expected);
  });
});
