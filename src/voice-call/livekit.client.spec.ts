jest.mock('livekit-server-sdk', () => ({
  AccessToken: jest.fn(),
  AgentDispatchClient: jest.fn(),
  DataPacket_Kind: { RELIABLE: 0 },
  RoomServiceClient: jest.fn(),
}));
jest.mock('@livekit/protocol', () => ({
  ParticipantInfo_Kind: { STANDARD: 0, INGRESS: 1, EGRESS: 2, SIP: 3, AGENT: 4 },
}));

import { RoomServiceClient } from 'livekit-server-sdk';
import { LiveKitClient } from './livekit.client';

/**
 * Strict-методы для deletion-пути (Task 10).
 *
 * Контракт отличается от interactive-версий принципиально: они возвращают
 * ПОДТВЕРЖДЁННЫЙ boolean и не глотают ошибки в «успех». `false` — исход
 * неизвестен, вызывающий обязан сохранить retry. `true` допускается только
 * когда LiveKit подтвердил результат, включая «комнаты уже нет» (404 —
 * подтверждённое отсутствие).
 */

function apiError(status: number, message = 'err'): Error {
  const e = new Error(message) as Error & { status?: number };
  e.status = status;
  return e;
}

function makeClient(fake: Record<string, jest.Mock>) {
  (RoomServiceClient as unknown as jest.Mock).mockImplementation(() => fake);
  return new LiveKitClient();
}

describe('LiveKitClient.closeRoomStrict', () => {
  it('подтверждённое удаление — true', async () => {
    const deleteRoom = jest.fn(async () => ({}));
    const client = makeClient({ deleteRoom });
    await expect(client.closeRoomStrict('room-1')).resolves.toBe(true);
    expect(deleteRoom).toHaveBeenCalledWith('room-1');
  });

  it('комнаты уже нет (404) — подтверждённый исход, true', async () => {
    const client = makeClient({ deleteRoom: jest.fn(async () => { throw apiError(404, 'RoomNotFound'); }) });
    await expect(client.closeRoomStrict('room-1')).resolves.toBe(true);
  });

  it('серверная ошибка — false, а не молчаливый успех и не исключение', async () => {
    const client = makeClient({ deleteRoom: jest.fn(async () => { throw apiError(500, 'boom'); }) });
    await expect(client.closeRoomStrict('room-1')).resolves.toBe(false);
  });

  it('сетевой сбой — false', async () => {
    const client = makeClient({ deleteRoom: jest.fn(async () => { throw new Error('ECONNREFUSED'); }) });
    await expect(client.closeRoomStrict('room-1')).resolves.toBe(false);
  });
});

describe('LiveKitClient.removeAgentsStrict', () => {
  const agent = { identity: 'agent-1', kind: 4 };
  const human = { identity: 'user-1', kind: 0 };

  it('агенты выгнаны, люди не тронуты — true', async () => {
    const listParticipants = jest.fn(async () => [human, agent]);
    const removeParticipant = jest.fn(async () => ({}));
    const client = makeClient({ listParticipants, removeParticipant });

    await expect(client.removeAgentsStrict('room-2')).resolves.toBe(true);
    expect(removeParticipant).toHaveBeenCalledTimes(1);
    expect(removeParticipant).toHaveBeenCalledWith('room-2', 'agent-1');
  });

  it('комнаты уже нет (404) — подтверждённый исход, true', async () => {
    const client = makeClient({
      listParticipants: jest.fn(async () => { throw apiError(404, 'RoomNotFound'); }),
      removeParticipant: jest.fn(),
    });
    await expect(client.removeAgentsStrict('room-2')).resolves.toBe(true);
  });

  it('сбой listParticipants (500) — false', async () => {
    const client = makeClient({
      listParticipants: jest.fn(async () => { throw apiError(500); }),
      removeParticipant: jest.fn(),
    });
    await expect(client.removeAgentsStrict('room-2')).resolves.toBe(false);
  });

  it('агент уже вышел (404 на removeParticipant) — true, это подтверждение', async () => {
    const client = makeClient({
      listParticipants: jest.fn(async () => [agent]),
      removeParticipant: jest.fn(async () => { throw apiError(404, 'ParticipantNotFound'); }),
    });
    await expect(client.removeAgentsStrict('room-2')).resolves.toBe(true);
  });

  it('неизвестный сбой removeParticipant — false', async () => {
    const client = makeClient({
      listParticipants: jest.fn(async () => [agent]),
      removeParticipant: jest.fn(async () => { throw apiError(503); }),
    });
    await expect(client.removeAgentsStrict('room-2')).resolves.toBe(false);
  });
});

describe('interactive-методы сохраняют прежнее поведение', () => {
  it('closeRoom глотает ошибку и возвращает void', async () => {
    const client = makeClient({ deleteRoom: jest.fn(async () => { throw apiError(500); }) });
    await expect(client.closeRoom('room-3')).resolves.toBeUndefined();
  });

  it('removeAgents глотает ошибку и возвращает void', async () => {
    const client = makeClient({ listParticipants: jest.fn(async () => { throw apiError(500); }) });
    await expect(client.removeAgents('room-3')).resolves.toBeUndefined();
  });
});
