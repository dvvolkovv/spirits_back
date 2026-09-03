import { ConflictException, NotFoundException } from '@nestjs/common';
import { MeetingService } from './meeting.service';

describe('MeetingService', () => {
  let pg: { query: jest.Mock };
  let calls: {
    buildPreamble: jest.Mock;
    load: jest.Mock;
    fail: jest.Mock;
    markInterruptedKeepingRoom: jest.Mock;
  };
  let livekit: { dispatchAgent: jest.Mock; removeAgents: jest.Mock; ensureRoom: jest.Mock };
  let rooms: { info: jest.Mock };
  let talerIdRooms: { info: jest.Mock; join: jest.Mock };
  let svc: MeetingService;

  const agentRow = {
    id: 7,
    display_name: 'Андрей',
    system_prompt: 'Помогаю с запуском.',
    realtime_voice: 'ash',
  };

  /**
   * База отвечает: ассистент есть, активных входов нет, в профиле имя владельца.
   *
   * Имя отдаём именно из профиля: раньше оно приходило параметром из
   * контроллера, и тест был зелёным просто потому, что тест же его и передал.
   */
  let balance = 50_000;

  function withAgent(ownerName: string | null = 'Дмитрий') {
    pg.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM agents')) return { rows: [agentRow] };
      if (sql.includes('SELECT tokens FROM ai_profiles_consolidated')) return { rows: [{ tokens: balance }] };
      if (sql.includes('ai_profiles_consolidated')) return { rows: [{ name: ownerName }] };
      return { rows: [], rowCount: 0 };
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    balance = 50_000;
    pg = { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };
    calls = {
      buildPreamble: jest.fn().mockResolvedValue('Пользователь: привет'),
      load: jest.fn(),
      fail: jest.fn(),
      markInterruptedKeepingRoom: jest.fn(),
    };
    livekit = { dispatchAgent: jest.fn(), removeAgents: jest.fn(), ensureRoom: jest.fn() };
    rooms = { info: jest.fn().mockResolvedValue({ code: 'ABC234', title: 'Планёрка', active: true }) };
    talerIdRooms = {
      info: jest.fn().mockResolvedValue({
        code: '36fc367a', title: '', roomName: 'personal-x',
        isActive: true, requiresPassword: false, creatorName: 'Дмитрий Волков',
      }),
      join: jest.fn().mockResolvedValue({
        token: 'jwt.body.sig', roomName: 'personal-x', url: 'wss://api.talerid.io/livekit/',
      }),
    };
    svc = new MeetingService(pg as any, calls as any, livekit as any, rooms as any, talerIdRooms as any);
  });

  describe('join', () => {
    it('заводит запись и зовёт воркера в комнату ВСТРЕЧИ, а не в новую', async () => {
      withAgent();
      const res = await svc.join('u1', 7, 'ABC234');
      expect(res.callId).toEqual(expect.any(String));
      expect(livekit.dispatchAgent).toHaveBeenCalledWith('room_ABC234', expect.any(Object));
    });

    it('передаёт режим встречи и данные ассистента', async () => {
      withAgent();
      await svc.join('u1', 7, 'ABC234');
      expect(livekit.dispatchAgent).toHaveBeenCalledWith(
        'room_ABC234',
        expect.objectContaining({
          mode: 'meeting',
          agentName: 'Андрей',
          agentVoice: 'ash',
          ownerName: 'Дмитрий',
        }),
      );
    });

    it('имя владельца берёт из профиля', async () => {
      // В JWT имени нет: guard кладёт только { userId, sub, isAdmin }. Пока
      // контроллер передавал `u.name || 'пользователя'`, фолбэк срабатывал
      // всегда, и на встрече 28.08.2026 Роман представился «ассистент
      // пользователя» — при том что в профиле записано «Дмитрий».
      withAgent('Мария');
      await svc.join('u1', 7, 'ABC234');
      expect(livekit.dispatchAgent).toHaveBeenCalledWith(
        'room_ABC234',
        expect.objectContaining({ ownerName: 'Мария' }),
      );
    });

    it('пустое имя в профиле не ломает вход — представится обезличенно', async () => {
      withAgent(null);
      await svc.join('u1', 7, 'ABC234');
      expect(livekit.dispatchAgent).toHaveBeenCalledWith(
        'room_ABC234',
        expect.objectContaining({ ownerName: 'пользователя' }),
      );
    });

    it('берёт preamble из чата с ЭТИМ ассистентом, а не с Романом', async () => {
      withAgent();
      await svc.join('u1', 7, 'ABC234');
      expect(calls.buildPreamble).toHaveBeenCalledWith('u1', 7);
    });

    it('не предлагает ведущему спрашивать самого себя', async () => {
      withAgent();
      await svc.join('u1', 7, 'ABC234');
      const meta = livekit.dispatchAgent.mock.calls[0][1] as any;
      expect(meta.specialists.map((s: any) => s.name)).not.toContain('Андрей');
      expect(meta.specialists.length).toBeGreaterThan(0);
    });

    it('не пускает второй вход при живом первом', async () => {
      pg.query.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM agents')) return { rows: [agentRow] };
        if (sql.includes('SELECT id FROM voice_calls')) return { rows: [{ id: 'existing' }] };
        return { rows: [], rowCount: 0 };
      });
      await expect(svc.join('u1', 7, 'ABC234')).rejects.toThrow(ConflictException);
      expect(livekit.dispatchAgent).not.toHaveBeenCalled();
    });

    it('не входит в несуществующую комнату', async () => {
      withAgent();
      rooms.info.mockResolvedValue(null);
      await expect(svc.join('u1', 7, 'ZZZZZZ')).rejects.toThrow(NotFoundException);
      expect(livekit.dispatchAgent).not.toHaveBeenCalled();
    });

    it('не входит в закрытую комнату', async () => {
      withAgent();
      rooms.info.mockResolvedValue({ code: 'ABC234', title: 'x', active: false });
      await expect(svc.join('u1', 7, 'ABC234')).rejects.toThrow(NotFoundException);
    });

    it('неизвестный ассистент — отказ', async () => {
      pg.query.mockResolvedValue({ rows: [], rowCount: 0 });
      await expect(svc.join('u1', 999, 'ABC234')).rejects.toThrow(NotFoundException);
    });

    it('если dispatch не удался — запись не остаётся висеть активной', async () => {
      // Строка в 'dialing' намертво блокирует следующую попытку: лимит
      // «один активный вход» смотрит именно на неё.
      withAgent();
      livekit.dispatchAgent.mockRejectedValue(new Error('livekit down'));
      await expect(svc.join('u1', 7, 'ABC234')).rejects.toThrow('livekit down');
      const failed = pg.query.mock.calls.find(([sql]: [string]) => sql.includes("status = 'failed'"));
      expect(failed).toBeDefined();
    });

    it('пишет провайдера и код комнаты — по ним потом ищет реапер', async () => {
      withAgent();
      await svc.join('u1', 7, 'ABC234');
      const insert = pg.query.mock.calls.find(([s]: [string]) => s.includes('INSERT INTO voice_calls'));
      expect(insert![1]).toContain('linkeon_room');
      expect(insert![1]).toContain('ABC234');
    });
  });

  describe('leave', () => {
    it('выход ассистента НЕ закрывает комнату — люди продолжают встречу', async () => {
      await svc.leave('c1');
      expect(calls.markInterruptedKeepingRoom).toHaveBeenCalledWith('c1');
    });
  });

  describe('noteFirstHuman', () => {
    it('переводит вход в активный и запоминает момент', async () => {
      await svc.noteFirstHuman('c1');
      const upd = pg.query.mock.calls.find(([s]: [string]) => s.includes('first_human_at'));
      expect(upd).toBeDefined();
      expect(upd![0]).toContain("status = 'active'");
    });

    it('повторный вызов не перезаписывает момент — участники входят и выходят', async () => {
      await svc.noteFirstHuman('c1');
      const upd = pg.query.mock.calls.find(([s]: [string]) => s.includes('first_human_at'));
      expect(upd![0]).toContain('COALESCE');
    });
  });

  describe('встреча Taler ID', () => {
    it('берёт токен у них и передаёт воркеру внешнюю комнату', async () => {
      withAgent();
      await svc.join('u1', 7, '36fc367a', 'talerid');

      expect(talerIdRooms.join).toHaveBeenCalledWith('36fc367a', expect.stringContaining('Андрей'));
      const [roomName, meta] = livekit.dispatchAgent.mock.calls[0] as any[];
      // Наша комната пустая и нужна ради job: жизненный цикл и reaper завязаны
      // на неё, а разговор идёт целиком у них.
      expect(roomName).toBe('talerid_36fc367a');
      expect(meta).toMatchObject({
        provider: 'talerid',
        externalUrl: 'wss://api.talerid.io/livekit/',
        externalToken: 'jwt.body.sig',
        mode: 'meeting',
      });
    });

    it('своя встреча внешней комнаты не получает', async () => {
      // Иначе воркер ушёл бы наружу на обычной встрече Linkeon.
      withAgent();
      await svc.join('u1', 7, 'ABC234');
      const meta = livekit.dispatchAgent.mock.calls[0][1] as any;
      expect(meta.externalUrl).toBeUndefined();
      expect(meta.provider).toBeUndefined();
    });

    it('комната под паролем отклоняется внятно, а не падает', async () => {
      withAgent();
      talerIdRooms.info.mockResolvedValue({
        code: '36fc367a', roomName: 'r', isActive: true,
        requiresPassword: true, creatorName: 'Кто-то', title: '',
      });
      await expect(svc.join('u1', 7, '36fc367a', 'talerid')).rejects.toThrow();
      expect(talerIdRooms.join).not.toHaveBeenCalled();
    });

    it('несуществующая комната — 404, запись не остаётся в dialing', async () => {
      withAgent();
      talerIdRooms.info.mockResolvedValue(null);
      await expect(svc.join('u1', 7, 'ZZZZZZ', 'talerid')).rejects.toThrow(NotFoundException);
      expect(livekit.dispatchAgent).not.toHaveBeenCalled();
    });
  });

  describe('пустая комната не умирает по таймауту', () => {
    it('для чужой встречи комната заводится заранее с запасом', async () => {
      // Наша комната при встрече Taler ID пуста по замыслу, а дефолтный
      // empty_timeout у LiveKit — 300 секунд. Семь встреч подряд обрывались
      // на 301-й секунде: ассистента просто выбрасывало из удалённой комнаты.
      withAgent();
      await svc.join('u1', 7, '36fc367a', 'talerid');
      expect(talerIdRooms.join).toHaveBeenCalled();
      expect(livekit.ensureRoom).toHaveBeenCalledWith('talerid_36fc367a', 7200);
    });

    it('для своей встречи заранее заводить нечего — там живые люди', async () => {
      withAgent();
      await svc.join('u1', 7, 'ABC234');
      expect(livekit.ensureRoom).not.toHaveBeenCalled();
    });
  });

  describe('баланс', () => {
    it('пустой баланс не пускает в разговор', async () => {
      // Проверки не было нигде: списание идёт после разговора. Пока звонили
      // одни админы, риск был нулевой; со встречами для всех пользователь с
      // нулём мог провести час Realtime, и узнали бы мы постфактум.
      withAgent();
      balance = 0;
      await expect(svc.join('u1', 7, 'ABC234')).rejects.toThrow();
      expect(livekit.dispatchAgent).not.toHaveBeenCalled();
    });

    it('с непустым балансом вход проходит', async () => {
      withAgent();
      balance = 1;
      await svc.join('u1', 7, 'ABC234');
      expect(livekit.dispatchAgent).toHaveBeenCalled();
    });
  });
});
