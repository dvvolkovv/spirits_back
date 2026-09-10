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
  let attendee: { createBot: jest.Mock; removeBot: jest.Mock };
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
    // Attendee настроен: без этих переменных вход в Meet отказывает ещё до
    // всякой логики — так и задумано, но тесты про саму логику должны
    // работать в настроенном окружении.
    process.env.ATTENDEE_BASE_URL = 'https://attendee.test';
    process.env.ATTENDEE_API_KEY = 'k1';
    balance = 50_000;
    pg = { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };
    calls = {
      buildPreamble: jest.fn().mockResolvedValue('Пользователь: привет'),
      load: jest.fn(),
      // Возвращает промис: код местами делает .catch() на результате, и
      // голый jest.fn() ронял тест TypeError'ом вместо проверки поведения.
      fail: jest.fn().mockResolvedValue(undefined),
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
    attendee = {
      createBot: jest.fn().mockResolvedValue({ botId: 'bot_1' }),
      removeBot: jest.fn().mockResolvedValue(true),
    };
    svc = new MeetingService(pg as any, calls as any, livekit as any, rooms as any, talerIdRooms as any, attendee as any);
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

    it('выводит бота из встречи Meet', async () => {
      calls.load.mockResolvedValue({ id: 'c1', provider: 'meet', external_bot_id: 'bot_1' });
      await svc.leave('c1');
      expect(attendee.removeBot).toHaveBeenCalledWith('bot_1');
    });

    it('своя встреча бота не имеет — не зовём', async () => {
      calls.load.mockResolvedValue({ id: 'c1', provider: 'linkeon_room', external_bot_id: null });
      await svc.leave('c1');
      expect(attendee.removeBot).not.toHaveBeenCalled();
    });

    it('недоступность Attendee не мешает ассистенту выйти', async () => {
      // Выход важнее уборки: иначе пользователь заперт лимитом активных.
      calls.load.mockResolvedValue({ id: 'c1', provider: 'meet', external_bot_id: 'bot_1' });
      attendee.removeBot.mockRejectedValue(new Error('сеть'));
      await svc.leave('c1');
      expect(calls.markInterruptedKeepingRoom).toHaveBeenCalledWith('c1');
    });

    it('несуществующий звонок не роняет выход', async () => {
      calls.load.mockRejectedValue(new Error('call not found'));
      await svc.leave('нет-такого');
      expect(calls.markInterruptedKeepingRoom).toHaveBeenCalledWith('нет-такого');
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

  describe('встреча Google Meet', () => {
    it('зовёт воркера в свою пустую комнату', async () => {
      // Бота здесь больше НЕ создаём: порт под звук свой у каждого задания
      // (см. AttendeeAudioHub), и знает его только воркер. Бот создаётся
      // позже, отдельной ручкой attachBot, когда воркер сообщит свой wsUrl.
      withAgent();
      const res = await svc.join('u1', 7, 'abc-defg-hij', 'meet');
      expect(attendee.createBot).not.toHaveBeenCalled();
      // Комната по callId, а не по коду встречи: одну и ту же встречу могут
      // позвать дважды, и имя по коду столкнулось бы с прошлой записью.
      expect(livekit.dispatchAgent).toHaveBeenCalledWith(
        `meet_${res.callId}`,
        expect.objectContaining({ mode: 'meeting', provider: 'meet' }),
      );
    });

    it('пишет провайдера и код встречи в запись звонка', async () => {
      withAgent();
      await svc.join('u1', 7, 'abc-defg-hij', 'meet');
      const insert = pg.query.mock.calls.find(([sql]: any) => /INSERT INTO voice_calls/.test(sql));
      expect(insert).toBeDefined();
      expect(insert[1]).toContain('meet');
      expect(insert[1]).toContain('abc-defg-hij');
    });

    it('комнату заводит заранее с запасом на всю встречу', async () => {
      // Наша комната пуста по замыслу, а дефолтный empty_timeout LiveKit —
      // 300 секунд: без этого ассистента выбрасывало ровно на 301-й секунде.
      withAgent();
      await svc.join('u1', 7, 'abc-defg-hij', 'meet');
      expect(livekit.ensureRoom).toHaveBeenCalledWith(expect.stringMatching(/^meet_/), 7200);
    });

    it('в комнату Meet не ходит за информацией — её негде взять', async () => {
      // У Meet нет публичной ручки «существует ли встреча». Проверить вход
      // заранее нельзя, о неудаче узнаём из состояния бота.
      withAgent();
      await svc.join('u1', 7, 'abc-defg-hij', 'meet');
      expect(rooms.info).not.toHaveBeenCalled();
      expect(talerIdRooms.info).not.toHaveBeenCalled();
    });

    it('токен чужой комнаты не запрашивается', async () => {
      withAgent();
      await svc.join('u1', 7, 'abc-defg-hij', 'meet');
      expect(talerIdRooms.join).not.toHaveBeenCalled();
    });

    it('своя встреча и Taler ID не задеты', async () => {
      withAgent();
      await svc.join('u1', 7, 'ABC234');
      expect(attendee.createBot).not.toHaveBeenCalled();
      expect(livekit.dispatchAgent).toHaveBeenCalledWith('room_ABC234', expect.any(Object));
    });
  });

  describe('attachBot: осиротевший бот', () => {
    it('падение записи id — бот всё равно выводится', async () => {
      // Не гипотеза: ровно так и случилось на стенде 09.09.2026, когда
      // миграция с колонкой ещё не была накатана. Бот создался, UPDATE упал,
      // и бот остался сиротой — реапер ищет по непустому external_bot_id и
      // такого не найдёт никогда.
      withAgent();
      calls.load.mockResolvedValue({ id: 'c1', user_id: 'u1', agent_id: 7, external_room: 'abc-defg-hij' });
      attendee.createBot.mockResolvedValue({ botId: 'bot_1' });
      pg.query.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM agents')) return { rows: [agentRow] };
        if (sql.includes('external_bot_id')) throw new Error('column does not exist');
        if (sql.includes('ai_profiles_consolidated')) return { rows: [{ name: 'Дмитрий' }] };
        return { rows: [], rowCount: 0 };
      });
      await expect(svc.attachBot('c1', 'wss://x/attendee/8140?callId=c1')).resolves.toEqual({ status: 'failed' });
      expect(attendee.removeBot).toHaveBeenCalledWith('bot_1');
    });

    it('бот не создан — убирать нечего', async () => {
      withAgent();
      calls.load.mockResolvedValue({ id: 'c1', user_id: 'u1', agent_id: 7, external_room: 'abc-defg-hij' });
      attendee.createBot.mockResolvedValue(null);
      await expect(svc.attachBot('c1', 'wss://x')).resolves.toEqual({ status: 'failed' });
      expect(attendee.removeBot).not.toHaveBeenCalled();
    });
  });

  describe('Attendee не настроен', () => {
    it('вход в Meet отказывает и записи не создаёт', async () => {
      // Без Attendee входить некуда. Отказ обязан прийти ДО INSERT: иначе
      // строка осталась бы в dialing и заперла пользователю его же
      // следующий вход до реапера.
      delete process.env.ATTENDEE_BASE_URL;
      withAgent();
      await expect(svc.join('u1', 7, 'abc-defg-hij', 'meet')).rejects.toMatchObject({
        response: expect.objectContaining({ reason: 'meet_unavailable' }),
      });
      expect(pg.query.mock.calls.some(([sql]: any) => /INSERT INTO voice_calls/.test(sql))).toBe(false);
    });

    it('свои комнаты и Taler ID не задеты', async () => {
      delete process.env.ATTENDEE_API_KEY;
      withAgent();
      await expect(svc.join('u1', 7, 'ABC234')).resolves.toBeDefined();
    });
  });

  describe('встреча Zoom', () => {
    const URL = 'https://us04web.zoom.us/j/71077562785?pwd=SECRET.1';

    it('зовёт воркера в свою пустую комнату и передаёт настоящего провайдера', async () => {
      // Провайдер в метаданных настоящий, а не «meet»: воркеру он безразличен
      // (звук у обеих площадок ходит одним мостом), но попадает в логи
      // задания, и «meet» на встрече Zoom сбивал бы с толку при разборе.
      withAgent();
      const res = await svc.join('u1', 7, '71077562785', 'zoom', URL);
      expect(attendee.createBot).not.toHaveBeenCalled();
      expect(livekit.dispatchAgent).toHaveBeenCalledWith(
        `zoom_${res.callId}`,
        expect.objectContaining({ mode: 'meeting', provider: 'zoom' }),
      );
    });

    it('адрес входа сохраняется отдельной колонкой, код — в external_room', async () => {
      // Колонка отдельная не из вкуса: в external_room у остальных площадок
      // лежит короткий код, и колонка с двумя смыслами однажды была бы
      // прочитана не тем способом.
      withAgent();
      await svc.join('u1', 7, '71077562785', 'zoom', URL);
      const insert = pg.query.mock.calls.find(([sql]: any) => /INSERT INTO voice_calls/.test(sql));
      expect(insert[0]).toMatch(/external_url/);
      expect(insert[1]).toContain('zoom');
      expect(insert[1]).toContain('71077562785');
      expect(insert[1]).toContain(URL);
    });

    it('без адреса входа отказ ДО создания записи', async () => {
      // Из числового id ссылку не собрать — нужен хост аккаунта и хеш пароля.
      // Отказ до INSERT по той же причине, что и у ненастроенного моста:
      // строка в dialing заперла бы пользователю следующий вход до реапера.
      withAgent();
      await expect(svc.join('u1', 7, '71077562785', 'zoom')).rejects.toMatchObject({
        response: expect.objectContaining({ reason: 'zoom_url_required' }),
      });
      const insert = pg.query.mock.calls.find(([sql]: any) => /INSERT INTO voice_calls/.test(sql));
      expect(insert).toBeUndefined();
    });

    it('комнату заводит заранее с запасом на всю встречу', async () => {
      withAgent();
      const res = await svc.join('u1', 7, '71077562785', 'zoom', URL);
      expect(livekit.ensureRoom).toHaveBeenCalledWith(`zoom_${res.callId}`, 7200);
    });

    it('название нейтральное и по площадке', async () => {
      withAgent();
      const res = await svc.join('u1', 7, '71077562785', 'zoom', URL);
      expect(res.title).toBe('Встреча Zoom');
    });
  });

  describe('потолок моста общий для Meet и Zoom', () => {
    it('встреча Zoom не пускается, пока мост занят встречей Meet', async () => {
      // Потолок физический, а не продуктовый: порт под звук один, и вторая
      // встреча — всё равно какой площадки — не найдёт свободного. Причина
      // остаётся meet_busy: ключ уже переведён во всех локалях фронта, а
      // человеку важно, что мост занят, а не кем именно.
      withAgent();
      pg.query.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM agents')) return { rows: [agentRow] };
        if (sql.includes('SELECT tokens FROM ai_profiles_consolidated')) return { rows: [{ tokens: balance }] };
        if (/count\(\*\)/.test(sql) && /provider = ANY/.test(sql)) return { rows: [{ n: 1 }] };
        if (sql.includes('ai_profiles_consolidated')) return { rows: [{ name: 'Дмитрий' }] };
        return { rows: [], rowCount: 0 };
      });
      await expect(
        svc.join('u2', 7, '71077562785', 'zoom', 'https://us04web.zoom.us/j/71077562785?pwd=S.1'),
      ).rejects.toMatchObject({ response: expect.objectContaining({ reason: 'meet_busy' }) });
    });

    it('счёт идёт по обеим площадкам, а не по одной', async () => {
      // Запрос обязан спрашивать обе: считать только Meet значило бы пустить
      // вторую встречу на занятый порт и получить невнятный отказ от воркера.
      withAgent();
      await svc.join('u1', 7, 'abc-defg-hij', 'meet');
      const busy = pg.query.mock.calls.find(([sql]: any) => /count\(\*\)/.test(sql) && /provider/.test(sql));
      expect(busy[0]).toMatch(/provider = ANY/);
      expect(busy[1][0]).toEqual(['meet', 'zoom']);
    });
  });

  describe('потолок одновременных встреч Meet', () => {
    // Держится здесь, а не надеждой на то, что воркер не найдёт свободного
    // порта: диапазон сужен до одного порта (см. attendee-audio.ts), и без
    // этой проверки второй пользователь упирался бы в отказ через несколько
    // секунд и без внятной причины — при потолке в одну встречу это норма,
    // а не редкость.
    it('вторая одновременная встреча Meet отклоняется внятно', async () => {
      withAgent();
      // Одна встреча Meet уже идёт.
      pg.query.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM agents')) return { rows: [agentRow] };
        if (sql.includes('SELECT tokens FROM ai_profiles_consolidated')) return { rows: [{ tokens: balance }] };
        if (/count\(\*\)/.test(sql) && /provider/.test(sql)) return { rows: [{ n: 1 }] };
        if (sql.includes('ai_profiles_consolidated')) return { rows: [{ name: 'Дмитрий' }] };
        return { rows: [], rowCount: 0 };
      });
      await expect(svc.join('u2', 7, 'abc-defg-hij', 'meet')).rejects.toMatchObject({
        response: expect.objectContaining({ reason: 'meet_busy' }),
      });
    });

    it('при отказе по потолку запись звонка не создаётся', async () => {
      // Иначе строка осталась бы в dialing и заперла пользователю его же
      // следующий вход до реапера.
      withAgent();
      pg.query.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM agents')) return { rows: [agentRow] };
        if (sql.includes('SELECT tokens FROM ai_profiles_consolidated')) return { rows: [{ tokens: balance }] };
        if (/count\(\*\)/.test(sql) && /provider/.test(sql)) return { rows: [{ n: 1 }] };
        if (sql.includes('ai_profiles_consolidated')) return { rows: [{ name: 'Дмитрий' }] };
        return { rows: [], rowCount: 0 };
      });
      await expect(svc.join('u2', 7, 'abc-defg-hij', 'meet')).rejects.toThrow();
      expect(pg.query.mock.calls.some(([sql]: any) => /INSERT INTO voice_calls/.test(sql))).toBe(false);
    });

    it('свободно — встреча заводится', async () => {
      withAgent();
      const res = await svc.join('u1', 7, 'abc-defg-hij', 'meet');
      expect(res.callId).toEqual(expect.any(String));
    });

    it('потолок не мешает своим комнатам и Taler ID', async () => {
      // Он про Meet, а не про встречи вообще.
      withAgent();
      pg.query.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM agents')) return { rows: [agentRow] };
        if (sql.includes('SELECT tokens FROM ai_profiles_consolidated')) return { rows: [{ tokens: balance }] };
        if (/count\(\*\)/.test(sql) && /provider/.test(sql)) return { rows: [{ n: 5 }] };
        if (sql.includes('ai_profiles_consolidated')) return { rows: [{ name: 'Дмитрий' }] };
        return { rows: [], rowCount: 0 };
      });
      await expect(svc.join('u1', 7, 'ABC234')).resolves.toBeDefined();
    });
  });

  describe('attachBot', () => {
    // Порт под звук свой у каждого задания, и знает его только воркер (см.
    // AttendeeAudioHub). Бот поэтому создаётся не в join(), а здесь — когда
    // воркер сообщил бэкенду свой wsUrl отдельной ручкой.
    const wsUrl = 'wss://my.linkeon.io/attendee/8141?callId=c1';

    it('Zoom: адрес берётся из базы целиком, а мост просят о веб-адаптере', async () => {
      // Адрес не собрать из кода, а без sdk: "web" ассистент войдёт немым —
      // нативный адаптер это дефолт моста (проверено живой встречей
      // 10.09.2026). Признак площадки здесь — колонка external_url плюс
      // provider записи.
      withAgent();
      const url = 'https://us04web.zoom.us/j/71077562785?pwd=SECRET.1';
      calls.load.mockResolvedValue({
        id: 'c1', agent_id: 7, user_id: 'u1',
        provider: 'zoom', external_room: '71077562785', external_url: url,
      });
      await svc.attachBot('c1', wsUrl);
      expect(attendee.createBot).toHaveBeenCalledWith(
        expect.objectContaining({ meetingUrl: url, provider: 'zoom' }),
      );
    });

    it('успех: создаёт бота и запоминает его id', async () => {
      withAgent();
      calls.load.mockResolvedValue({ id: 'c1', agent_id: 7, user_id: 'u1', external_room: 'abc-defg-hij' });
      const res = await svc.attachBot('c1', wsUrl);
      expect(res).toEqual({ status: 'ok' });
      expect(attendee.createBot).toHaveBeenCalledWith({
        meetingUrl: 'https://meet.google.com/abc-defg-hij',
        // То же имя, что и раньше собиралось в join(): участники должны
        // видеть, кто к ним пришёл и от кого.
        botName: 'Андрей · ассистент Дмитрий',
        callId: 'c1',
        wsUrl,
        provider: 'meet',
      });
      const upd = pg.query.mock.calls.find(([sql, args]: any) =>
        /external_bot_id/.test(sql) && Array.isArray(args) && args.includes('bot_1'),
      );
      expect(upd).toBeDefined();
    });

    it('Attendee не создал бота — звонок помечается failed', async () => {
      withAgent();
      attendee.createBot.mockResolvedValue(null);
      calls.load.mockResolvedValue({ id: 'c1', agent_id: 7, user_id: 'u1', external_room: 'abc-defg-hij' });
      const res = await svc.attachBot('c1', wsUrl);
      expect(res).toEqual({ status: 'failed' });
      expect(calls.fail).toHaveBeenCalledWith('c1', expect.any(String));
    });

    it('звонок не найден — failed, к Attendee не ходим', async () => {
      calls.load.mockRejectedValue(new Error('call not found'));
      const res = await svc.attachBot('нет-такого', wsUrl);
      expect(res).toEqual({ status: 'failed' });
      expect(attendee.createBot).not.toHaveBeenCalled();
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
