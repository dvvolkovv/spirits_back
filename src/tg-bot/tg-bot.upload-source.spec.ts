import { fetchMediaBytes } from '../common/net/own-media';
import { TgBotService } from './tg-bot.service';

// fetchMediaBytes — заглушка (готовую картинку бот качает байтами), остальное
// own-media настоящее: по ownOrigins распознаётся адрес загрузки.
jest.mock('../common/net/own-media', () => ({
  ...jest.requireActual('../common/net/own-media'),
  fetchMediaBytes: jest.fn(),
}));

/**
 * Загрузки пользователя (/webhook/chat-uploads/<id>) — приватные файлы
 * владельца бота. Маркеры бота в Telegram (image_edit, image_compose, upscale,
 * video) идут от имени владельца (cfg.owner_user_id), а пишет их модель по
 * просьбе любого участника группы. В очереди 1 исходником в Telegram загрузка
 * не берётся ни при каком значении CHAT_UPLOADS_ENABLED: отказ до misc/video,
 * в чат — attach_bad_link, как у ссылки во внутреннюю сеть.
 */

const OWN = '77777777-7777-4777-8777-777777777777';
const BAD_LINK = '(не удалось приложить файл: ссылка недоступна)';

function make() {
  const grammy = {
    sendPhoto: jest.fn().mockResolvedValue({}),
    sendMessage: jest.fn().mockResolvedValue({}),
    sendChatAction: jest.fn().mockResolvedValue(undefined),
  };
  const misc = {
    generateImage: jest.fn(),
    editImage: jest.fn().mockResolvedValue({ images: [{ url: 'https://my.linkeon.io/smm-media/linkeon-assets/images/out.png' }] }),
    composeImage: jest.fn().mockResolvedValue({ images: [{ url: 'https://my.linkeon.io/smm-media/linkeon-assets/images/out.png' }] }),
    upscaleImage: jest.fn().mockResolvedValue({ images: [{ url: 'https://my.linkeon.io/smm-media/linkeon-assets/images/out.png' }] }),
  };
  const video = { createJob: jest.fn().mockResolvedValue({ jobId: 'job-1', status: 'processing', tokensSpent: 1 }) };
  const pg = { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 1 }) };
  const svc = new TgBotService(
    pg as any, {} as any, {} as any, {} as any, {} as any,
    {} as any, {} as any, {} as any, {} as any, grammy as any, misc as any, video as any,
  );
  (svc as any).logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { svc, grammy, misc, video };
}

const cfg = { id: 'cfg-1', owner_user_id: 'u-1' } as any;
const msg = { chat: { id: -100777 }, message_id: 9 };

const ENV_KEYS = ['BACKEND_URL', 'PUBLIC_BASE_URL', 'CHAT_UPLOADS_ENABLED'];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.BACKEND_URL = 'https://my.linkeon.io';
  delete process.env.PUBLIC_BASE_URL;
  process.env.CHAT_UPLOADS_ENABLED = 'true';
  (fetchMediaBytes as jest.Mock).mockReset().mockResolvedValue({
    data: Buffer.from('picture-bytes'), contentType: 'image/png', finalUrl: 'https://my.linkeon.io/smm-media/out.png',
  });
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const UPLOAD_MARKERS: Array<[string, any]> = [
  ['image_edit', { kind: 'image_edit', prompt: 'убери фон', source: `/webhook/chat-uploads/${OWN}` }],
  ['image_compose', {
    kind: 'image_compose', prompt: 'посади на фон',
    sources: ['https://images.example/bg.png', `https://my.linkeon.io/webhook/chat-uploads/${OWN}?exp=1&sig=ab`],
  }],
  ['upscale', { kind: 'upscale', source: `https://my.linkeon.io/webhook/chat-uploads/${OWN.toUpperCase()}` }],
  ['video', { kind: 'video', prompt: 'говорит в камеру', mode: 'image2video', source: `/webhook/chat-uploads/${OWN}`, duration: 8 }],
];

describe('Telegram: загрузка пользователя исходником не берётся', () => {
  describe.each(['true', 'false', undefined])('CHAT_UPLOADS_ENABLED=%s', (flag) => {
    beforeEach(() => {
      if (flag === undefined) delete process.env.CHAT_UPLOADS_ENABLED;
      else process.env.CHAT_UPLOADS_ENABLED = flag;
    });

    it.each(UPLOAD_MARKERS)('%s — misc/video не вызываются, в чат attach_bad_link', async (_kind, marker) => {
      const { svc, grammy, misc, video } = make();
      await (svc as any).deliverOutgoingMarkers(cfg, msg, [marker], 'ru');
      expect(misc.editImage).not.toHaveBeenCalled();
      expect(misc.composeImage).not.toHaveBeenCalled();
      expect(misc.upscaleImage).not.toHaveBeenCalled();
      expect(video.createJob).not.toHaveBeenCalled();
      expect(grammy.sendPhoto).not.toHaveBeenCalled();
      expect(grammy.sendMessage.mock.calls.map((c) => c[1])).toEqual([BAD_LINK]);
    });

    it('отказ — ошибка с кодом UNSAFE_URL и без адреса в тексте', async () => {
      const { svc } = make();
      const err = await (svc as any).dispatchOutgoingMarker(cfg, msg, UPLOAD_MARKERS[0][1], 'ru').catch((e: any) => e);
      expect(err.code).toBe('UNSAFE_URL');
      expect(err.message).not.toMatch(/chat-uploads|7777/);
    });
  });
});

describe('Telegram: прочие исходники — как раньше', () => {
  it('внешняя картинка в image_edit уходит в misc от имени владельца, результат — байтами', async () => {
    const { svc, grammy, misc } = make();
    await (svc as any).deliverOutgoingMarkers(cfg, msg, [
      { kind: 'image_edit', prompt: 'убери фон', source: 'https://images.example/cat.png' },
    ], 'ru');
    expect(misc.editImage).toHaveBeenCalledWith('u-1', { prompt: 'убери фон', sourceImageUrl: 'https://images.example/cat.png' });
    expect(grammy.sendPhoto).toHaveBeenCalledTimes(1);
    expect(grammy.sendMessage).not.toHaveBeenCalled();
  });

  it('склейка из внешних картинок и upscale своего MinIO — как раньше', async () => {
    const { svc, misc } = make();
    await (svc as any).deliverOutgoingMarkers(cfg, msg, [
      { kind: 'image_compose', prompt: 'p', sources: ['https://images.example/a.png', 'https://images.example/b.png'] },
      { kind: 'upscale', source: 'https://my.linkeon.io/smm-media/linkeon-assets/images/a.png' },
    ], 'ru');
    expect(misc.composeImage).toHaveBeenCalledTimes(1);
    expect(misc.upscaleImage).toHaveBeenCalledWith('u-1', { sourceImageUrl: 'https://my.linkeon.io/smm-media/linkeon-assets/images/a.png' });
  });

  it('видео без исходника и с внешним портретом — задача создаётся', async () => {
    const { svc, video } = make();
    await (svc as any).deliverOutgoingMarkers(cfg, msg, [
      { kind: 'video', prompt: 'закат над морем', mode: 'text2video', duration: 8 },
      { kind: 'video', prompt: 'говорит', mode: 'image2video', source: 'https://images.example/face.jpg', duration: 8 },
    ], 'ru');
    expect(video.createJob).toHaveBeenCalledTimes(2);
    expect(video.createJob.mock.calls[1][1]).toMatchObject({ sourceImageUrl: 'https://images.example/face.jpg' });
  });

  it('чужой домен с путём загрузки — не загрузка: идёт в misc прежним путём', async () => {
    const { svc, misc } = make();
    await (svc as any).deliverOutgoingMarkers(cfg, msg, [
      { kind: 'image_edit', prompt: 'p', source: `https://evil.example/webhook/chat-uploads/${OWN}` },
    ], 'ru');
    expect(misc.editImage).toHaveBeenCalledTimes(1);
  });
});
