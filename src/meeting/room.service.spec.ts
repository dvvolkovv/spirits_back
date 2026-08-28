import { NotFoundException } from '@nestjs/common';
import { RoomService } from './room.service';
import { isValidRoomCode } from './room-code';

describe('RoomService', () => {
  let pg: { query: jest.Mock };
  let livekit: { userToken: jest.Mock; closeRoom: jest.Mock };
  let svc: RoomService;

  /** Строка живой комнаты, как её вернёт база. */
  const liveRoom = { code: 'ABC234', title: 'Планёрка', closed_at: null };

  beforeEach(() => {
    pg = { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };
    livekit = {
      userToken: jest.fn().mockResolvedValue('guest-token'),
      closeRoom: jest.fn().mockResolvedValue(undefined),
    };
    svc = new RoomService(pg as any, livekit as any);
  });

  describe('create', () => {
    it('заводит комнату с валидным кодом', async () => {
      const res = await svc.create('u1', 'Планёрка');
      expect(isValidRoomCode(res.code)).toBe(true);
      expect(res.title).toBe('Планёрка');
    });

    it('пишет владельца в базу', async () => {
      await svc.create('u1', 'Планёрка');
      const insert = pg.query.mock.calls.find(([s]: [string]) => s.includes('INSERT INTO meeting_rooms'));
      expect(insert).toBeDefined();
      expect(insert![1]).toContain('u1');
    });

    it('без названия комната всё равно называется', async () => {
      const res = await svc.create('u1');
      expect(res.title).toBe('Встреча');
    });
  });

  describe('info', () => {
    it('отдаёт живую комнату', async () => {
      pg.query.mockResolvedValue({ rows: [liveRoom], rowCount: 1 });
      await expect(svc.info('ABC234')).resolves.toEqual({ code: 'ABC234', title: 'Планёрка', active: true });
    });

    it('закрытая комната отдаётся с active=false, а не как отсутствующая', async () => {
      pg.query.mockResolvedValue({ rows: [{ ...liveRoom, closed_at: new Date() }], rowCount: 1 });
      await expect(svc.info('ABC234')).resolves.toMatchObject({ active: false });
    });

    it('не зависит от регистра — код диктуют и записывают как попало', async () => {
      pg.query.mockResolvedValue({ rows: [liveRoom], rowCount: 1 });
      await svc.info('abc234');
      expect(pg.query.mock.calls[0][1]).toContain('ABC234');
    });

    it('несуществующая комната — null, а не исключение', async () => {
      await expect(svc.info('ZZZZZZ')).resolves.toBeNull();
    });

    it('невалидный код не доходит до базы', async () => {
      // Ручка публичная: гонять в запрос всё, что прислали, незачем.
      await expect(svc.info('../../etc')).resolves.toBeNull();
      expect(pg.query).not.toHaveBeenCalled();
    });
  });

  describe('joinGuest', () => {
    beforeEach(() => pg.query.mockResolvedValue({ rows: [liveRoom], rowCount: 1 }));

    it('выдаёт токен на комнату этого кода', async () => {
      const res = await svc.joinGuest('ABC234', 'Сергей');
      expect(res.token).toBe('guest-token');
      expect(livekit.userToken).toHaveBeenCalledWith('room_ABC234', expect.any(String), 'Сергей');
    });

    it('отдаёт адрес LiveKit — гостю неоткуда его взять', async () => {
      const res = await svc.joinGuest('ABC234', 'Сергей');
      expect(res.wsUrl).toEqual(expect.stringMatching(/^wss?:\/\//));
    });

    it('в закрытую комнату не пускает', async () => {
      pg.query.mockResolvedValue({ rows: [{ ...liveRoom, closed_at: new Date() }], rowCount: 1 });
      await expect(svc.joinGuest('ABC234', 'Сергей')).rejects.toThrow(NotFoundException);
    });

    it('в несуществующую комнату не пускает', async () => {
      pg.query.mockResolvedValue({ rows: [], rowCount: 0 });
      await expect(svc.joinGuest('ZZZZZZ', 'Сергей')).rejects.toThrow(NotFoundException);
    });

    it('пустое имя заменяется, а не уезжает пустым в список участников', async () => {
      await svc.joinGuest('ABC234', '   ');
      expect(livekit.userToken).toHaveBeenCalledWith('room_ABC234', expect.any(String), 'Гость');
    });

    it('у двух тёзок разные identity, иначе LiveKit выкинет первого', async () => {
      // identity — ключ участника: два входа с одинаковой выкидывают друг друга.
      await svc.joinGuest('ABC234', 'Сергей');
      await svc.joinGuest('ABC234', 'Сергей');
      const ids = livekit.userToken.mock.calls.map((c: any[]) => c[1]);
      expect(ids[0]).not.toBe(ids[1]);
    });

    it('имя обрезается по длине — в списке участников не должно быть простыни', async () => {
      await svc.joinGuest('ABC234', 'а'.repeat(500));
      const name = livekit.userToken.mock.calls[0][2] as string;
      expect(name.length).toBeLessThanOrEqual(64);
    });
  });

  describe('close', () => {
    it('помечает закрытой и гасит комнату в LiveKit', async () => {
      await svc.close('ABC234');
      const upd = pg.query.mock.calls.find(([s]: [string]) => s.includes('UPDATE meeting_rooms'));
      expect(upd).toBeDefined();
      expect(livekit.closeRoom).toHaveBeenCalledWith('room_ABC234');
    });

    it('не зависит от регистра', async () => {
      await svc.close('abc234');
      expect(livekit.closeRoom).toHaveBeenCalledWith('room_ABC234');
    });
  });
});
