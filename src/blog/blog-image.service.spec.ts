// src/blog/blog-image.service.spec.ts
import { BlogImageService, buildBackgroundPrompt } from './blog-image.service';

const settingsMock = (imageStyle = 'плоская иллюстрация') => ({
  get: jest.fn().mockResolvedValue({ channelChatId: '-100', slotDays: [1], slotHourMsk: 10, imageStyle }),
});

describe('buildBackgroundPrompt', () => {
  it('добавляет запрет текста в кадре', () => {
    const p = buildBackgroundPrompt('котик у окна', 'акварель');
    expect(p.toLowerCase()).toContain('no text');
  });

  it('подмешивает фирменный стиль из настроек', () => {
    expect(buildBackgroundPrompt('котик', 'акварель')).toContain('акварель');
  });

  it('пустой стиль не ломает промпт', () => {
    expect(buildBackgroundPrompt('котик', '')).toContain('котик');
  });
});

describe('BlogImageService.render', () => {
  it('нормальный путь: генерация фона, наложение текста, загрузка', async () => {
    const misc = {
      generateRawImage: jest.fn().mockResolvedValue({ b64Image: 'AAA', mimeType: 'image/png' }),
      uploadAssetImage: jest.fn().mockResolvedValue('https://minio/img.png'),
    };
    const svc = new BlogImageService(misc as any, settingsMock() as any);
    (svc as any).overlay = jest.fn().mockResolvedValue(Buffer.from('banner'));

    const url = await svc.render('Заголовок', 'сцена');
    expect(url).toBe('https://minio/img.png');
    expect(misc.generateRawImage).toHaveBeenCalledTimes(1);
  });

  it('отказ генерации → фолбэк на фон без модели, пост всё равно выходит', async () => {
    const misc = {
      generateRawImage: jest.fn().mockRejectedValue(new Error('IMAGE_RECITATION')),
      uploadAssetImage: jest.fn().mockResolvedValue('https://minio/fallback.png'),
    };
    const svc = new BlogImageService(misc as any, settingsMock() as any);
    (svc as any).overlay = jest.fn().mockResolvedValue(Buffer.from('banner'));

    const url = await svc.render('Заголовок', 'сцена');
    expect(url).toBe('https://minio/fallback.png');
    // Два захода в модель: основной промпт и упрощённый — и только потом фолбэк.
    expect(misc.generateRawImage).toHaveBeenCalledTimes(2);
  });

  it('если и загрузка упала — ошибка наверх', async () => {
    const misc = {
      generateRawImage: jest.fn().mockRejectedValue(new Error('нет ключа')),
      uploadAssetImage: jest.fn().mockRejectedValue(new Error('minio недоступен')),
    };
    const svc = new BlogImageService(misc as any, settingsMock() as any);
    (svc as any).overlay = jest.fn().mockResolvedValue(Buffer.from('banner'));

    await expect(svc.render('З', 'сцена')).rejects.toThrow(/minio/);
  });
});
