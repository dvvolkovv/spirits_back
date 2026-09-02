import { TalerIdRoomClient } from './talerid-room.client';

/** Ответ их ручки, как он приходит на самом деле (снят живьём 02.09.2026). */
const REAL_INFO = {
  code: '36fc367a',
  title: '',
  roomName: 'personal-c79530ed-36fc367a',
  isActive: true,
  requiresPassword: false,
  creatorName: 'Дмитрий Волков',
  creatorAvatar: 'https://api.talerid.io/uploads/avatars/6ae81490.jpg',
};

function mockFetch(impl: (url: string, init?: any) => Promise<any> | any) {
  (global as any).fetch = jest.fn(async (url: string, init?: any) => impl(String(url), init));
  return (global as any).fetch as jest.Mock;
}

const ok = (body: any) => ({ ok: true, status: 200, json: async () => body });
const notFound = { ok: false, status: 404, json: async () => ({ message: 'Room not found' }) };

describe('TalerIdRoomClient', () => {
  const OLD_ENV = process.env.TALERID_BASE_URL;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TALERID_BASE_URL = 'https://api.talerid.io';
  });
  afterAll(() => {
    if (OLD_ENV === undefined) delete process.env.TALERID_BASE_URL;
    else process.env.TALERID_BASE_URL = OLD_ENV;
  });

  describe('info', () => {
    it('разбирает настоящий ответ их ручки', async () => {
      mockFetch(() => ok(REAL_INFO));
      const r = await new TalerIdRoomClient().info('36fc367a');
      expect(r).toMatchObject({
        code: '36fc367a',
        roomName: 'personal-c79530ed-36fc367a',
        isActive: true,
        requiresPassword: false,
        creatorName: 'Дмитрий Волков',
      });
    });

    it('404 — это null, а не исключение', async () => {
      // «В сообщении была ссылка на комнату, которой нет» — рабочий случай.
      // Если он полетит исключением, обычная ссылка в разговоре превратится
      // в ошибку в ленте.
      mockFetch(() => notFound);
      await expect(new TalerIdRoomClient().info('ZZZZZZ')).resolves.toBeNull();
    });

    it('недоступный сервис не роняет обработчик', async () => {
      mockFetch(() => { throw new Error('ECONNREFUSED'); });
      await expect(new TalerIdRoomClient().info('36fc367a')).resolves.toBeNull();
    });

    it('битый JSON тоже не роняет', async () => {
      mockFetch(() => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } }));
      await expect(new TalerIdRoomClient().info('36fc367a')).resolves.toBeNull();
    });

    it('ответ без roomName считается негодным', async () => {
      // Ручка могла смениться под нами: партнёрства на голосовые комнаты у нас
      // нет, контракт держится на их веб-странице.
      mockFetch(() => ok({ code: '36fc367a', isActive: true }));
      await expect(new TalerIdRoomClient().info('36fc367a')).resolves.toBeNull();
    });

    it('пароль и выключенность отдаются наверх как есть', async () => {
      mockFetch(() => ok({ ...REAL_INFO, requiresPassword: true, isActive: false }));
      const r = await new TalerIdRoomClient().info('36fc367a');
      expect(r).toMatchObject({ requiresPassword: true, isActive: false });
    });
  });

  describe('join', () => {
    it('возвращает токен и адрес их LiveKit', async () => {
      const f = mockFetch(() => ok({ token: 'jwt.body.sig', roomName: 'personal-x' }));
      const r = await new TalerIdRoomClient().join('36fc367a', 'Роман · ассистент Дмитрия');

      expect(r).toEqual({
        token: 'jwt.body.sig',
        roomName: 'personal-x',
        url: 'wss://api.talerid.io/livekit/',
      });
      // Имя уходит в теле — именно так они подписывают участника в списке.
      const [, init] = f.mock.calls[0];
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({ name: 'Роман · ассистент Дмитрия' });
    });

    it('адрес LiveKit следует за базой, а не прибит к боевому домену', async () => {
      // Прибить api.talerid.io значит сломать стенд и не заметить.
      process.env.TALERID_BASE_URL = 'https://staging.id.taler.tirol';
      mockFetch(() => ok({ token: 't', roomName: 'r' }));
      const r = await new TalerIdRoomClient().join('code', 'имя');
      expect(r!.url).toBe('wss://staging.id.taler.tirol/livekit/');
    });

    it('пустой токен считается отказом', async () => {
      mockFetch(() => ok({ token: '', roomName: 'r' }));
      await expect(new TalerIdRoomClient().join('code', 'имя')).resolves.toBeNull();
    });

    it('404 на join — null', async () => {
      mockFetch(() => notFound);
      await expect(new TalerIdRoomClient().join('ZZZZZZ', 'имя')).resolves.toBeNull();
    });
  });

  it('код комнаты экранируется в пути', async () => {
    // Код приходит из пользовательского сообщения; без экранирования он
    // способен увести запрос на соседнюю ручку.
    const f = mockFetch(() => notFound);
    await new TalerIdRoomClient().info('../../admin');
    expect(String(f.mock.calls[0][0])).not.toContain('/admin');
  });
});
