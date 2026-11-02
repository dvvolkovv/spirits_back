import sharp = require('sharp');
import { GrammyError, HttpError } from 'grammy';
import { fetchMediaBytes } from '../common/net/own-media';
import { TgBotService, classifyTelegramPhoto } from './tg-bot.service';

jest.mock('../common/net/own-media');

/**
 * {{file: url=…}} с картинкой уходит фотографией: в чате её видно сразу, а
 * документ надо открывать (находка «Затыков недели» bfc4c3ad — схему зала
 * прислали одними ссылками; модель должна присылать саму картинку, и она
 * должна выглядеть как картинка).
 *
 * Формат и размер читаются из самих БАЙТОВ (sharp), а не из Content-Type
 * ответа — его легко недоговорить или подделать (ревью качества 02.11).
 * Поэтому фикстуры для «это фото» — настоящие картинки, собранные sharp'ом
 * прямо в тесте, а не произвольные байты с нужным заголовком.
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

  const fakeMedia = (contentType: string, size = 1000) => ({
    data: Buffer.alloc(size, 1), contentType, finalUrl: 'https://example.org/x',
  });
  /** Настоящая картинка нужного формата/размера — sharp сам её рисует. */
  const realMedia = async (fmt: string, width: number, height: number, contentType: string) => {
    const img = sharp({ create: { width, height, channels: 3, background: { r: 10, g: 20, b: 30 } } });
    const data = await (fmt === 'jpeg' ? img.jpeg() : fmt === 'png' ? img.png() : img.webp()).toBuffer();
    return { data, contentType, finalUrl: 'https://example.org/x' };
  };
  // Классический 1×1 spacer.gif — настоящие байты формата, который Telegram
  // sendPhoto не принимает (сделал бы из анимации стоп-кадр).
  const GIF_1X1 = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBTAA7', 'base64');

  beforeEach(() => jest.clearAllMocks());

  it.each([
    ['image/jpeg', 'jpeg'],
    ['image/png', 'png'],
    ['image/webp', 'webp'],
  ])('%s → sendPhoto с подписью', async (ct, fmt) => {
    (fetchMediaBytes as jest.Mock).mockResolvedValue(await realMedia(fmt, 40, 30, ct));
    await (svc as any).dispatchOutgoingMarker(cfg, msg, { kind: 'file', url: 'https://example.org/seatmap.jpg', caption: 'Схема зала' });
    expect(grammy.sendPhoto).toHaveBeenCalledTimes(1);
    const [chatId, buf, opts] = grammy.sendPhoto.mock.calls[0];
    expect(chatId).toBe(-100777);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(opts).toMatchObject({ reply_to_message_id: 9, caption: 'Схема зала' });
    expect(grammy.sendDocument).not.toHaveBeenCalled();
    expect(grammy.sendChatAction).toHaveBeenCalledWith(-100777, 'upload_photo');
  });

  it('формат смотрим по байтам, не по Content-Type: application/octet-stream с настоящими jpeg-байтами — всё равно фото', async () => {
    (fetchMediaBytes as jest.Mock).mockResolvedValue(await realMedia('jpeg', 40, 30, 'application/octet-stream'));
    await (svc as any).dispatchOutgoingMarker(cfg, msg, { kind: 'file', url: 'https://example.org/seatmap' });
    expect(grammy.sendPhoto).toHaveBeenCalledTimes(1);
    expect(grammy.sendDocument).not.toHaveBeenCalled();
  });

  it('PDF (не картинка) — документом, как раньше', async () => {
    (fetchMediaBytes as jest.Mock).mockResolvedValue(fakeMedia('application/pdf'));
    await (svc as any).dispatchOutgoingMarker(cfg, msg, { kind: 'file', url: 'https://example.org/report.pdf' });
    expect(grammy.sendPhoto).not.toHaveBeenCalled();
    expect(grammy.sendDocument).toHaveBeenCalledTimes(1);
    expect(grammy.sendChatAction).toHaveBeenCalledWith(-100777, 'upload_document');
  });

  it('настоящий GIF — документом: фото обездвижило бы анимацию', async () => {
    (fetchMediaBytes as jest.Mock).mockResolvedValue({ data: GIF_1X1, contentType: 'image/gif', finalUrl: 'https://example.org/a.gif' });
    await (svc as any).dispatchOutgoingMarker(cfg, msg, { kind: 'file', url: 'https://example.org/a.gif' });
    expect(grammy.sendPhoto).not.toHaveBeenCalled();
    expect(grammy.sendDocument).toHaveBeenCalledTimes(1);
  });

  it('слишком вытянутая и слишком большая картинка — документом, sendPhoto даже не пробуем', async () => {
    (fetchMediaBytes as jest.Mock).mockResolvedValue(await realMedia('png', 9999, 2, 'image/png'));
    await (svc as any).dispatchOutgoingMarker(cfg, msg, { kind: 'file', url: 'https://example.org/weird.png' });
    expect(grammy.sendPhoto).not.toHaveBeenCalled();
    expect(grammy.sendDocument).toHaveBeenCalledTimes(1);
  });

  it('картинка больше 10 МБ — документом без разбора формата (предел sendPhoto)', async () => {
    (fetchMediaBytes as jest.Mock).mockResolvedValue(fakeMedia('image/png', 10 * 1024 * 1024 + 1));
    await (svc as any).dispatchOutgoingMarker(cfg, msg, { kind: 'file', url: 'https://example.org/big.png' });
    expect(grammy.sendPhoto).not.toHaveBeenCalled();
    expect(grammy.sendDocument).toHaveBeenCalledTimes(1);
  });

  it('длинная сторона больше 2560 — фото (превью) и следом оригинал документом', async () => {
    (fetchMediaBytes as jest.Mock).mockResolvedValue(await realMedia('jpeg', 3000, 200, 'image/jpeg'));
    await (svc as any).dispatchOutgoingMarker(
      cfg, msg, { kind: 'file', url: 'https://example.org/wide-seatmap.jpg', caption: 'Схема зала', name: 'seatmap.jpg' },
    );

    expect(grammy.sendPhoto).toHaveBeenCalledTimes(1);
    expect(grammy.sendPhoto.mock.calls[0][2]).toMatchObject({ reply_to_message_id: 9, caption: 'Схема зала' });

    expect(grammy.sendDocument).toHaveBeenCalledTimes(1);
    const [chatId, buf, name, opts] = grammy.sendDocument.mock.calls[0];
    expect(chatId).toBe(-100777);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(name).toBe('seatmap.jpg');
    // Не обычная подпись маркера — короткая оговорка про полный размер (tgText, 7 языков).
    expect(opts).toMatchObject({ reply_to_message_id: 9, caption: 'Оригинал в полном размере.' });
  });

  it('HTML вместо картинки (SPA по относительному пути, страница файла — не сама картинка) — ни фото, ни документ, строка в чат', async () => {
    (fetchMediaBytes as jest.Mock).mockResolvedValue({
      data: Buffer.from('<html><body>not found</body></html>'),
      contentType: 'text/html; charset=utf-8',
      finalUrl: 'https://example.org/wiki/File:Seatmap.jpg',
    });
    await (svc as any).deliverOutgoingMarkers(cfg, msg, [{ kind: 'file', url: 'https://example.org/wiki/File:Seatmap.jpg' }]);
    expect(grammy.sendPhoto).not.toHaveBeenCalled();
    expect(grammy.sendDocument).not.toHaveBeenCalled();
    expect(grammy.sendMessage).toHaveBeenCalledTimes(1);
    expect(grammy.sendMessage.mock.calls[0][1]).toBe('(не удалось приложить файл)');
  });

  it('явно просили html-файл (имя маркера кончается на .html) — документ допустим', async () => {
    (fetchMediaBytes as jest.Mock).mockResolvedValue({
      data: Buffer.from('<html></html>'), contentType: 'text/html', finalUrl: 'https://example.org/report.html',
    });
    await (svc as any).dispatchOutgoingMarker(cfg, msg, { kind: 'file', url: 'https://example.org/report.html', name: 'report.html' });
    expect(grammy.sendDocument).toHaveBeenCalledTimes(1);
    expect(grammy.sendPhoto).not.toHaveBeenCalled();
  });

  it('Telegram ОТКАЗАЛ принять фото (GrammyError 4xx) — тот же файл уходит документом', async () => {
    (fetchMediaBytes as jest.Mock).mockResolvedValue(await realMedia('png', 40, 30, 'image/png'));
    grammy.sendPhoto.mockRejectedValueOnce(
      new GrammyError("Call to 'sendPhoto' failed!", { ok: false, error_code: 400, description: 'Bad Request: PHOTO_INVALID_DIMENSIONS' }, 'sendPhoto', {}),
    );
    await (svc as any).dispatchOutgoingMarker(
      cfg, msg, { kind: 'file', url: 'https://example.org/wide.png', name: 'wide.png', caption: 'подпись' },
    );
    expect(grammy.sendPhoto).toHaveBeenCalledTimes(1);
    expect(grammy.sendDocument).toHaveBeenCalledTimes(1);
    const [chatId, buf, name, opts] = grammy.sendDocument.mock.calls[0];
    expect(chatId).toBe(-100777);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(name).toBe('wide.png');
    expect(opts).toMatchObject({ reply_to_message_id: 9, caption: 'подпись' });
    // Предупреждение в лог — с id чата, чтобы можно было найти разговор.
    expect((svc as any).logger.warn).toHaveBeenCalledWith(expect.stringContaining(String(msg.chat.id)));
  });

  it('исход отправки фото НЕИЗВЕСТЕН (HttpError — обрыв/таймаут) — документом не дублируем, ошибка уходит наверх', async () => {
    (fetchMediaBytes as jest.Mock).mockResolvedValue(await realMedia('png', 40, 30, 'image/png'));
    grammy.sendPhoto.mockRejectedValueOnce(new HttpError("Network request for 'sendPhoto' failed!", new Error('socket hang up')));
    await expect(
      (svc as any).dispatchOutgoingMarker(cfg, msg, { kind: 'file', url: 'https://example.org/x.png' }),
    ).rejects.toThrow(HttpError);
    expect(grammy.sendDocument).not.toHaveBeenCalled();
  });

  it('429 (лимит частоты) — тоже не отказ: документом не дублируем', async () => {
    (fetchMediaBytes as jest.Mock).mockResolvedValue(await realMedia('png', 40, 30, 'image/png'));
    grammy.sendPhoto.mockRejectedValueOnce(
      new GrammyError("Call to 'sendPhoto' failed!", { ok: false, error_code: 429, description: 'Too Many Requests' }, 'sendPhoto', {}),
    );
    await expect(
      (svc as any).dispatchOutgoingMarker(cfg, msg, { kind: 'file', url: 'https://example.org/x.png' }),
    ).rejects.toThrow(GrammyError);
    expect(grammy.sendDocument).not.toHaveBeenCalled();
  });
});

describe('classifyTelegramPhoto — план отправки по метаданным sharp', () => {
  const meta = (format: string, width: number, height: number, pages?: number) => ({ format, width, height, pages });

  it('jpeg/png/webp обычного размера — только фото', () => {
    expect(classifyTelegramPhoto(meta('jpeg', 800, 600))).toBe('photo');
    expect(classifyTelegramPhoto(meta('png', 800, 600))).toBe('photo');
    expect(classifyTelegramPhoto(meta('webp', 800, 600))).toBe('photo');
  });

  it('webp: pages не сообщили или 1 — не анимация', () => {
    expect(classifyTelegramPhoto(meta('webp', 800, 600, undefined))).toBe('photo');
    expect(classifyTelegramPhoto(meta('webp', 800, 600, 1))).toBe('photo');
  });

  it('gif — документом вне зависимости от размера', () => {
    expect(classifyTelegramPhoto(meta('gif', 10, 10))).toBe('none');
  });

  it('анимированный webp (pages > 1) — документом: sendPhoto сделал бы стоп-кадр', () => {
    expect(classifyTelegramPhoto(meta('webp', 800, 600, 3))).toBe('none');
  });

  it('формат не из кандидатов (tiff/avif и т. п.) — документом', () => {
    expect(classifyTelegramPhoto(meta('tiff', 800, 600))).toBe('none');
    expect(classifyTelegramPhoto(meta('avif', 800, 600))).toBe('none');
  });

  it('сумма сторон больше 10000 — документом, даже с нормальным соотношением', () => {
    expect(classifyTelegramPhoto(meta('jpeg', 5500, 4600))).toBe('none'); // ratio ~1.2, sum 10100
  });

  it('соотношение сторон больше 20 — документом, даже с небольшой суммой', () => {
    expect(classifyTelegramPhoto(meta('jpeg', 1000, 40))).toBe('none'); // sum 1040, ratio 25
  });

  it('длинная сторона больше 2560, остальное в норме — фото и оригинал', () => {
    expect(classifyTelegramPhoto(meta('jpeg', 3000, 200))).toBe('photo+original'); // sum 3200, ratio 15
  });

  it('длинная сторона ровно 2560 — ещё только фото, оригинал не дублируем', () => {
    expect(classifyTelegramPhoto(meta('jpeg', 2560, 200))).toBe('photo'); // ratio 12.8, sum 2760
  });

  it('вырожденные размеры (0) — документом', () => {
    expect(classifyTelegramPhoto(meta('jpeg', 0, 100))).toBe('none');
    expect(classifyTelegramPhoto(meta('jpeg', 100, 0))).toBe('none');
  });
});
