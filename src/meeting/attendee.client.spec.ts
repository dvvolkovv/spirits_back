import { AttendeeClient, attendeeConfigured } from './attendee.client';

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as any;

describe('AttendeeClient', () => {
  const realFetch = global.fetch;
  beforeEach(() => {
    process.env.ATTENDEE_BASE_URL = 'https://attendee.test';
    process.env.ATTENDEE_API_KEY = 'k1';
    process.env.ATTENDEE_WEBHOOK_URL = 'https://my.linkeon.io/webhook/meet/attendee';
  });
  afterEach(() => { global.fetch = realFetch; });

  describe('attendeeConfigured', () => {
    it('настроен, когда есть адрес и ключ', () => {
      expect(attendeeConfigured()).toBe(true);
    });

    it('без адреса — не настроен', () => {
      delete process.env.ATTENDEE_BASE_URL;
      expect(attendeeConfigured()).toBe(false);
    });

    it('без ключа — не настроен', () => {
      delete process.env.ATTENDEE_API_KEY;
      expect(attendeeConfigured()).toBe(false);
    });

    it('пустая строка — тоже не настроен', () => {
      // Пустая переменная в .env встречается чаще, чем отсутствующая.
      process.env.ATTENDEE_BASE_URL = '';
      expect(attendeeConfigured()).toBe(false);
    });
  });

  describe('createBot', () => {
    it('возвращает id бота', async () => {
      global.fetch = jest.fn().mockResolvedValue(ok({ id: 'bot_1', state: 'joining' })) as any;
      const r = await new AttendeeClient().createBot({
        meetingUrl: 'https://meet.google.com/abc-defg-hij',
        botName: 'Роман · ассистент Дмитрия',
        callId: 'c1',
        wsUrl: 'wss://my.linkeon.io/attendee/8141?callId=c1',
      });
      expect(r).toEqual({ botId: 'bot_1' });
    });

    it('шлёт имя, метаданные, вебсокет как есть и триггеры', async () => {
      const spy = jest.fn().mockResolvedValue(ok({ id: 'bot_1' }));
      global.fetch = spy as any;
      await new AttendeeClient().createBot({
        meetingUrl: 'https://meet.google.com/abc-defg-hij',
        botName: 'Роман · ассистент Дмитрия',
        callId: 'c1',
        wsUrl: 'wss://my.linkeon.io/attendee/8141?callId=c1',
      });
      const [url, init] = spy.mock.calls[0];
      expect(url).toBe('https://attendee.test/api/v1/bots');
      expect((init.headers as any).Authorization).toBe('Token k1');
      const body = JSON.parse(init.body);
      expect(body.meeting_url).toBe('https://meet.google.com/abc-defg-hij');
      expect(body.bot_name).toBe('Роман · ассистент Дмитрия');
      // callId в metadata — так вебхук находит звонок без своей таблицы.
      expect(body.metadata).toEqual({ callId: 'c1' });
      // wsUrl уходит КАК ЕСТЬ, без сборки из env: порт знает только воркер,
      // он же собирает адрес целиком (см. AttendeeAudioHub.publicUrl).
      expect(body.websocket_settings.audio).toEqual({
        url: 'wss://my.linkeon.io/attendee/8141?callId=c1',
        sample_rate: 24000,
      });
      // Записи не храним: транскрипт ведём сами, а видео переговоров клиента
      // в чужом хранилище — лишняя утечка. По умолчанию Attendee пишет mp4.
      expect(body.recording_settings).toEqual({ format: 'none' });
      // Правила выхода — наши. Дефолт Attendee «один в встрече 60 секунд →
      // ухожу» 09.09.2026 оборвал живую встречу на 95-й секунде и назвал
      // причину сам, вместо нас. Наш выход по опустевшей встрече идёт по
      // событию, эти таймеры — запас.
      expect(body.automatic_leave_settings).toEqual({
        only_participant_in_meeting_timeout_seconds: 300,
        silence_timeout_seconds: 1800,
        max_uptime_seconds: 7500,
      });
      expect(body.webhooks[0].triggers).toEqual([
        'bot.state_change',
        'participant_events.join_leave',
        'participant_events.speech_start_stop',
      ]);
    });

    it('HTTP-ошибка — null, а не исключение', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 502 }) as any;
      await expect(new AttendeeClient().createBot({
        meetingUrl: 'u', botName: 'n', callId: 'c1', wsUrl: 'wss://x/attendee/8141?callId=c1',
      })).resolves.toBeNull();
    });

    it('ответ без id — null', async () => {
      global.fetch = jest.fn().mockResolvedValue(ok({ state: 'joining' })) as any;
      await expect(new AttendeeClient().createBot({
        meetingUrl: 'u', botName: 'n', callId: 'c1', wsUrl: 'wss://x/attendee/8141?callId=c1',
      })).resolves.toBeNull();
    });

    it('неразобранное тело на 200 — null: без id бота нет', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true, status: 200, json: async () => { throw new Error('битый JSON'); },
      }) as any;
      await expect(new AttendeeClient().createBot({
        meetingUrl: 'u', botName: 'n', callId: 'c1', wsUrl: 'wss://x/attendee/8141?callId=c1',
      })).resolves.toBeNull();
    });

    it('падение сети — null', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as any;
      await expect(new AttendeeClient().createBot({
        meetingUrl: 'u', botName: 'n', callId: 'c1', wsUrl: 'wss://x/attendee/8141?callId=c1',
      })).resolves.toBeNull();
    });

    it('без ключа в окружении — null и ни одного запроса', async () => {
      delete process.env.ATTENDEE_API_KEY;
      const spy = jest.fn();
      global.fetch = spy as any;
      await expect(new AttendeeClient().createBot({
        meetingUrl: 'u', botName: 'n', callId: 'c1', wsUrl: 'wss://x/attendee/8141?callId=c1',
      })).resolves.toBeNull();
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('removeBot', () => {
    it('зовёт leave и говорит об успехе', async () => {
      const spy = jest.fn().mockResolvedValue(ok({}));
      global.fetch = spy as any;
      await expect(new AttendeeClient().removeBot('bot_1')).resolves.toBe(true);
      expect(spy.mock.calls[0][0]).toBe('https://attendee.test/api/v1/bots/bot_1/leave');
    });

    it('не падает, если бота уже нет', async () => {
      // Реапер и leave могут прийти одновременно; 404 здесь — норма.
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 404 }) as any;
      await expect(new AttendeeClient().removeBot('bot_1')).resolves.toBe(false);
    });

    it('сетевой сбой — null, а не false: состояние бота неизвестно', async () => {
      // Отличие от 404 принципиальное. false читается вызывающим как «бота и
      // так не было», и при недоступности Attendee Chrome остался бы сидеть
      // в чужой встрече.
      global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as any;
      await expect(new AttendeeClient().removeBot('bot_1')).resolves.toBeNull();
    });

    it('ошибка сервиса — тоже null', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }) as any;
      await expect(new AttendeeClient().removeBot('bot_1')).resolves.toBeNull();
    });

    it('успех определяется статусом, а не телом', async () => {
      // Тело leave нам не нужно, и его может не быть вовсе. Раньше пустой
      // объект от заглушки парсера читался как подтверждённое удаление —
      // случайно, а не по решению.
      global.fetch = jest.fn().mockResolvedValue({
        ok: true, status: 200, json: async () => { throw new Error('пустое тело'); },
      }) as any;
      await expect(new AttendeeClient().removeBot('bot_1')).resolves.toBe(true);
    });

    it('400 на завершённом боте — выводить некого, а не «неизвестно»', async () => {
      // Attendee отвечает на leave 400, а не 404: «Event leave_requested not
      // allowed when bot is in state ended». Проверено на живом сервисе
      // 09.09.2026. Прежняя редакция считала это неизвестным состоянием, и
      // реапер перебирал три давно завершённых бота каждый тик, не очищая
      // external_bot_id никогда.
      const spy = jest.fn()
        .mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ error: 'in state ended' }) })
        .mockResolvedValueOnce(ok({ state: 'ended' }));
      global.fetch = spy as any;
      await expect(new AttendeeClient().removeBot('bot_1')).resolves.toBe(false);
      // Состояние спрашиваем у самого Attendee, а не угадываем по тексту
      // ошибки: формулировка чужая и меняется без предупреждения.
      expect(spy.mock.calls[1][0]).toBe('https://attendee.test/api/v1/bots/bot_1');
    });

    it('400 на боте, который ещё стучится, — null: он может войти', async () => {
      // leave не разрешён и в joining, и в комнате ожидания. Считать такой
      // ответ «бота нет» значило бы забыть про Chrome, который вот-вот
      // окажется в чужих переговорах.
      const spy = jest.fn()
        .mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ error: 'in state joining' }) })
        .mockResolvedValueOnce(ok({ state: 'joining' }));
      global.fetch = spy as any;
      await expect(new AttendeeClient().removeBot('bot_1')).resolves.toBeNull();
    });

    it('400, а состояние узнать не удалось — null', async () => {
      const spy = jest.fn()
        .mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({}) })
        .mockRejectedValueOnce(new Error('ECONNREFUSED'));
      global.fetch = spy as any;
      await expect(new AttendeeClient().removeBot('bot_1')).resolves.toBeNull();
    });

    it('id бота экранируется в пути', async () => {
      const spy = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
      global.fetch = spy as any;
      await new AttendeeClient().removeBot('../../admin');
      expect(spy.mock.calls[0][0]).toBe('https://attendee.test/api/v1/bots/..%2F..%2Fadmin/leave');
    });
  });
});
