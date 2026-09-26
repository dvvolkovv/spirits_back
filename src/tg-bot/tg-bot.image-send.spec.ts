import { fetchMediaBytes } from '../common/net/own-media';
import { TgBotService } from './tg-bot.service';

jest.mock('../common/net/own-media');

/**
 * Telegram не может скачать наши ссылки: my.linkeon.io живёт за РФ-edge
 * Selectel, до которого подсети дата-центров Telegram не доходят (та же
 * причина, по которой вебхуку нужен закреплённый IP). sendPhoto с URL
 * отвечает 400 «failed to get HTTP URL content» — поймано на живом ходе
 * 28.08.2026, картинка при этом успешно сгенерилась.
 *
 * Значит байты качаем сами и отдаём Buffer'ом — ровно как уже сделано для
 * маркера file.
 */
describe('отправка картинки в Telegram', () => {
  const grammy = { sendPhoto: jest.fn(), sendChatAction: jest.fn().mockResolvedValue(undefined) };
  const misc = { generateImage: jest.fn(), editImage: jest.fn() };

  const svc = new TgBotService(
    {} as any, {} as any, {} as any, {} as any, {} as any,
    {} as any, {} as any, {} as any, {} as any, grammy as any, misc as any, {} as any,
  );

  const cfg = { owner_user_id: 'u-1' } as any;
  const msg = { chat: { id: 777 }, message_id: 5 };

  beforeEach(() => {
    jest.clearAllMocks();
    (fetchMediaBytes as jest.Mock).mockResolvedValue({
      data: Buffer.from('picture-bytes'), contentType: 'image/png', finalUrl: 'https://my.linkeon.io/smm-media/cat.png',
    });
  });

  it('картинка уходит байтами, а не ссылкой', async () => {
    misc.generateImage.mockResolvedValue({ images: [{ url: 'https://my.linkeon.io/smm-media/cat.png' }] });

    await (svc as any).dispatchOutgoingMarker(cfg, msg, { kind: 'image', prompt: 'котик в космосе' });

    // Качает fetchMediaBytes — свой MinIO он читает изнутри, чужое проверяет на SSRF.
    expect(fetchMediaBytes).toHaveBeenCalledWith(
      'https://my.linkeon.io/smm-media/cat.png',
      expect.objectContaining({ maxBytes: expect.any(Number), timeoutMs: expect.any(Number) }),
    );
    const [, photo] = grammy.sendPhoto.mock.calls[0];
    expect(Buffer.isBuffer(photo)).toBe(true);
    expect(photo.toString()).toBe('picture-bytes');
  });

  it('правка картинки — тоже байтами', async () => {
    misc.editImage.mockResolvedValue({ images: [{ url: 'https://my.linkeon.io/smm-media/edited.png' }] });

    await (svc as any).dispatchOutgoingMarker(cfg, msg, {
      kind: 'image_edit', prompt: 'убери фон', source: 'https://my.linkeon.io/smm-media/src.png',
    });

    const [, photo] = grammy.sendPhoto.mock.calls[0];
    expect(Buffer.isBuffer(photo)).toBe(true);
  });

  it('пустой URL от генератора — понятная ошибка, а не тихий пропуск', async () => {
    misc.generateImage.mockResolvedValue({ images: [] });

    await expect(
      (svc as any).dispatchOutgoingMarker(cfg, msg, { kind: 'image', prompt: 'что-то' }),
    ).rejects.toThrow('пустой URL');
  });
});
