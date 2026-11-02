import { fetchMediaBytes } from '../common/net/own-media';
import { TgBotService } from './tg-bot.service';

jest.mock('../common/net/own-media');

/**
 * {{file: url=…}} с картинкой уходит фотографией: в чате её видно сразу, а
 * документ надо открывать (находка «Затыков недели» bfc4c3ad — схему зала
 * прислали одними ссылками; модель должна присылать саму картинку, и она
 * должна выглядеть как картинка).
 */
describe('маркер {{file:}} с картинкой', () => {
  const grammy = {
    sendPhoto: jest.fn().mockResolvedValue({}),
    sendDocument: jest.fn().mockResolvedValue({}),
    sendMessage: jest.fn().mockResolvedValue({}),
    sendChatAction: jest.fn().mockResolvedValue(undefined),
  };
  const svc = new TgBotService(
    {} as any, {} as any, {} as any, {} as any, {} as any,
    {} as any, {} as any, {} as any, {} as any, grammy as any, {} as any, {} as any,
  );
  (svc as any).logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };
  const cfg = { owner_user_id: 'u-1' } as any;
  const msg = { chat: { id: -100777 }, message_id: 9 };
  const media = (contentType: string, size = 1000) => ({
    data: Buffer.alloc(size, 1), contentType, finalUrl: 'https://example.org/x',
  });

  beforeEach(() => jest.clearAllMocks());

  it.each(['image/jpeg', 'image/png', 'image/webp', 'image/jpeg; charset=binary'])('%s → sendPhoto с подписью', async (ct) => {
    (fetchMediaBytes as jest.Mock).mockResolvedValue(media(ct));
    await (svc as any).dispatchOutgoingMarker(cfg, msg, { kind: 'file', url: 'https://example.org/seatmap.jpg', caption: 'Схема зала' });
    expect(grammy.sendPhoto).toHaveBeenCalledTimes(1);
    const [chatId, buf, opts] = grammy.sendPhoto.mock.calls[0];
    expect(chatId).toBe(-100777);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(opts).toMatchObject({ reply_to_message_id: 9, caption: 'Схема зала' });
    expect(grammy.sendDocument).not.toHaveBeenCalled();
  });

  it('PDF — документом, как раньше', async () => {
    (fetchMediaBytes as jest.Mock).mockResolvedValue(media('application/pdf'));
    await (svc as any).dispatchOutgoingMarker(cfg, msg, { kind: 'file', url: 'https://example.org/report.pdf' });
    expect(grammy.sendPhoto).not.toHaveBeenCalled();
    expect(grammy.sendDocument).toHaveBeenCalledTimes(1);
  });

  it('GIF — документом: фото его обездвижит', async () => {
    (fetchMediaBytes as jest.Mock).mockResolvedValue(media('image/gif'));
    await (svc as any).dispatchOutgoingMarker(cfg, msg, { kind: 'file', url: 'https://example.org/a.gif' });
    expect(grammy.sendPhoto).not.toHaveBeenCalled();
    expect(grammy.sendDocument).toHaveBeenCalledTimes(1);
  });

  it('картинка больше 10 МБ — документом (предел sendPhoto)', async () => {
    (fetchMediaBytes as jest.Mock).mockResolvedValue(media('image/png', 10 * 1024 * 1024 + 1));
    await (svc as any).dispatchOutgoingMarker(cfg, msg, { kind: 'file', url: 'https://example.org/big.png' });
    expect(grammy.sendPhoto).not.toHaveBeenCalled();
    expect(grammy.sendDocument).toHaveBeenCalledTimes(1);
  });

  it('Telegram не принял фото — тот же файл уходит документом', async () => {
    (fetchMediaBytes as jest.Mock).mockResolvedValue(media('image/png'));
    grammy.sendPhoto.mockRejectedValueOnce(new Error('PHOTO_INVALID_DIMENSIONS'));
    await (svc as any).dispatchOutgoingMarker(cfg, msg, { kind: 'file', url: 'https://example.org/wide.png', name: 'wide.png' });
    expect(grammy.sendDocument).toHaveBeenCalledTimes(1);
    expect(grammy.sendDocument.mock.calls[0][2]).toBe('wide.png');
  });
});
