import { ForbiddenException } from '@nestjs/common';
import { MeetingController } from './meeting.controller';

/**
 * Тесты контроллера, а не сервиса.
 *
 * Заведены после того, как на стенде выяснилось: ручка входа никогда не
 * передавала провайдера `'meet'` — тернарник отправлял всё, что не
 * `'talerid'`, в `'linkeon'`, и встреча Meet уходила искать свою комнату с
 * кодом вида `abc-defg-hij`. Фича была недостижима через API, а тесты этого
 * не видели: все они зовут `MeetingService` напрямую, минуя контроллер.
 *
 * Тот же класс пробела ревью отмечало для вебхуков. Здесь он закрыт.
 */
describe('MeetingController', () => {
  let meetings: { join: jest.Mock; leave: jest.Mock };
  let calls: { load: jest.Mock };
  let ctl: MeetingController;

  const user = { userId: 'u1' };

  beforeEach(() => {
    jest.clearAllMocks();
    meetings = {
      join: jest.fn().mockResolvedValue({ callId: 'c1', title: 'Встреча' }),
      leave: jest.fn().mockResolvedValue(undefined),
    };
    calls = { load: jest.fn().mockResolvedValue({ id: 'c1', user_id: 'u1' }) };
    ctl = new MeetingController(meetings as any, calls as any);
  });

  describe('join: провайдер доезжает до сервиса', () => {
    it('meet передаётся как meet', async () => {
      // Главный тест этого файла: именно здесь фича и обрывалась.
      await ctl.join(user as any, { agentId: 12, code: 'abc-defg-hij', provider: 'meet' } as any);
      expect(meetings.join).toHaveBeenCalledWith('u1', 12, 'abc-defg-hij', 'meet', undefined);
    });

    it('talerid передаётся как talerid', async () => {
      await ctl.join(user as any, { agentId: 12, code: '36fc367a', provider: 'talerid' } as any);
      expect(meetings.join).toHaveBeenCalledWith('u1', 12, '36fc367a', 'talerid', undefined);
    });

    it('без провайдера — своя комната', async () => {
      await ctl.join(user as any, { agentId: 12, code: 'ABC234' } as any);
      expect(meetings.join).toHaveBeenCalledWith('u1', 12, 'ABC234', 'linkeon', undefined);
    });

    it('незнакомый провайдер не проходит за свою комнату молча', async () => {
      // Проверяем список, а не «всё неизвестное — linkeon»: иначе следующий
      // провайдер уедет в свои комнаты так же незаметно, как это случилось
      // с Meet. Пока поведение — фолбэк, но зафиксировано осознанно.
      //
      // Пример намеренно взят из будущего: `teams` мост умеет, у нас его нет.
      // Раньше здесь стоял `zoom` — и тест начал падать в тот день, когда
      // zoom добавили в список, то есть сработал как задумано.
      await ctl.join(user as any, { agentId: 12, code: 'x', provider: 'teams' } as any);
      expect(meetings.join).toHaveBeenCalledWith('u1', 12, 'x', 'linkeon', undefined);
    });

    it('адрес входа Zoom доезжает до сервиса', async () => {
      // Из кода его не собрать: в ссылке хост аккаунта и хеш пароля. Не
      // доехал — сервис откажет с zoom_url_required, и фича будет
      // недостижима через API ровно так же, как когда-то Meet.
      const url = 'https://us04web.zoom.us/j/71077562785?pwd=SECRET.1';
      await ctl.join(user as any, { agentId: 12, code: '71077562785', provider: 'zoom', url } as any);
      expect(meetings.join).toHaveBeenCalledWith('u1', 12, '71077562785', 'zoom', url);
    });

    it('пустой адрес не превращается в пустую строку', async () => {
      // Сервис отличает «адреса нет» от «адрес пустой» только по undefined.
      await ctl.join(user as any, { agentId: 12, code: 'abc-defg-hij', provider: 'meet', url: '' } as any);
      expect(meetings.join).toHaveBeenCalledWith('u1', 12, 'abc-defg-hij', 'meet', undefined);
    });

    it('код и ассистент приводятся к типам', async () => {
      await ctl.join(user as any, { agentId: '12', code: 123, provider: 'meet' } as any);
      expect(meetings.join).toHaveBeenCalledWith('u1', 12, '123', 'meet', undefined);
    });
  });

  describe('leave', () => {
    it('чужую встречу покинуть нельзя', async () => {
      calls.load.mockResolvedValue({ id: 'c1', user_id: 'кто-то другой' });
      await expect(ctl.leave(user as any, 'c1')).rejects.toThrow(ForbiddenException);
      expect(meetings.leave).not.toHaveBeenCalled();
    });

    it('свою — можно', async () => {
      await ctl.leave(user as any, 'c1');
      expect(meetings.leave).toHaveBeenCalledWith('c1');
    });
  });
});
