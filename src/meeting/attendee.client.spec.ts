import { AttendeeClient } from './attendee.client';

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as any;

describe('AttendeeClient', () => {
  const realFetch = global.fetch;
  beforeEach(() => {
    process.env.ATTENDEE_BASE_URL = 'https://attendee.test';
    process.env.ATTENDEE_API_KEY = 'k1';
    process.env.ATTENDEE_WEBHOOK_URL = 'https://my.linkeon.io/webhook/meet/attendee';
    process.env.ATTENDEE_AUDIO_WS_URL = 'wss://voice.linkeon.io/attendee';
  });
  afterEach(() => { global.fetch = realFetch; });

  describe('createBot', () => {
    it('возвращает id бота', async () => {
      global.fetch = jest.fn().mockResolvedValue(ok({ id: 'bot_1', state: 'joining' })) as any;
      const r = await new AttendeeClient().createBot({
        meetingUrl: 'https://meet.google.com/abc-defg-hij',
        botName: 'Роман · ассистент Дмитрия',
        callId: 'c1',
      });
      expect(r).toEqual({ botId: 'bot_1' });
    });

    it('шлёт имя, метаданные, вебсокет и триггеры', async () => {
      const spy = jest.fn().mockResolvedValue(ok({ id: 'bot_1' }));
      global.fetch = spy as any;
      await new AttendeeClient().createBot({
        meetingUrl: 'https://meet.google.com/abc-defg-hij',
        botName: 'Роман · ассистент Дмитрия',
        callId: 'c1',
      });
      const [url, init] = spy.mock.calls[0];
      expect(url).toBe('https://attendee.test/api/v1/bots');
      expect((init.headers as any).Authorization).toBe('Token k1');
      const body = JSON.parse(init.body);
      expect(body.meeting_url).toBe('https://meet.google.com/abc-defg-hij');
      expect(body.bot_name).toBe('Роман · ассистент Дмитрия');
      // callId в metadata — так вебхук находит звонок без своей таблицы.
      expect(body.metadata).toEqual({ callId: 'c1' });
      expect(body.websocket_settings.audio).toEqual({
        url: 'wss://voice.linkeon.io/attendee?callId=c1',
        sample_rate: 24000,
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
        meetingUrl: 'u', botName: 'n', callId: 'c1',
      })).resolves.toBeNull();
    });

    it('ответ без id — null', async () => {
      global.fetch = jest.fn().mockResolvedValue(ok({ state: 'joining' })) as any;
      await expect(new AttendeeClient().createBot({
        meetingUrl: 'u', botName: 'n', callId: 'c1',
      })).resolves.toBeNull();
    });

    it('неразобранное тело на 200 — null: без id бота нет', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true, status: 200, json: async () => { throw new Error('битый JSON'); },
      }) as any;
      await expect(new AttendeeClient().createBot({
        meetingUrl: 'u', botName: 'n', callId: 'c1',
      })).resolves.toBeNull();
    });

    it('падение сети — null', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as any;
      await expect(new AttendeeClient().createBot({
        meetingUrl: 'u', botName: 'n', callId: 'c1',
      })).resolves.toBeNull();
    });

    it('без ключа в окружении — null и ни одного запроса', async () => {
      delete process.env.ATTENDEE_API_KEY;
      const spy = jest.fn();
      global.fetch = spy as any;
      await expect(new AttendeeClient().createBot({
        meetingUrl: 'u', botName: 'n', callId: 'c1',
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

    it('id бота экранируется в пути', async () => {
      const spy = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
      global.fetch = spy as any;
      await new AttendeeClient().removeBot('../../admin');
      expect(spy.mock.calls[0][0]).toBe('https://attendee.test/api/v1/bots/..%2F..%2Fadmin/leave');
    });
  });
});
