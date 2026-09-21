import axios from 'axios';
import { fetchImageBytes, IMAGE_FETCH_TIMEOUT_MS, MAX_IMAGE_BYTES } from './blog-image.fetch';
import { STUCK_PUBLISHING_MINUTES } from './blog.cron';

jest.mock('axios');

/**
 * Telegram не может забрать картинку по нашей ссылке: my.linkeon.io живёт за
 * РФ-edge Selectel, до которого подсети дата-центров Telegram не доходят.
 * На проде sendPhoto с URL отвечает 400 «failed to get HTTP URL content»,
 * тот же файл мультипартом уходит с первого раза. Значит байты качаем сами.
 */
describe('fetchImageBytes', () => {
  beforeEach(() => jest.clearAllMocks());

  it('отдаёт байты картинки, а не ссылку', async () => {
    (axios.get as jest.Mock).mockResolvedValue({ data: Buffer.from('png-bytes') });

    const buf = await fetchImageBytes('https://my.linkeon.io/smm-media/i.png');

    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.toString()).toBe('png-bytes');
    expect(axios.get).toHaveBeenCalledWith(
      'https://my.linkeon.io/smm-media/i.png',
      expect.objectContaining({ responseType: 'arraybuffer' }),
    );
  });

  it('качает с таймаутом — без него зависший MinIO держал бы пост в publishing', async () => {
    (axios.get as jest.Mock).mockResolvedValue({ data: Buffer.from('x') });

    await fetchImageBytes('https://my.linkeon.io/i.png');

    expect(axios.get).toHaveBeenCalledWith(
      'https://my.linkeon.io/i.png',
      expect.objectContaining({ timeout: IMAGE_FETCH_TIMEOUT_MS, maxContentLength: MAX_IMAGE_BYTES }),
    );
  });

  /**
   * Тик публикации берёт до пяти постов подряд, а сторож зависших забирает
   * пост из `publishing` через STUCK_PUBLISHING_MINUTES. Если таймаут поднять
   * так, что пятёрка не укладывается в порог, сторож перевзведёт пост из-под
   * ещё живой отправки — и в канал уедут два одинаковых.
   */
  it('пятёрка таймаутов укладывается в порог сторожа зависших', () => {
    expect(5 * IMAGE_FETCH_TIMEOUT_MS).toBeLessThan(STUCK_PUBLISHING_MINUTES * 60_000);
  });

  it('не-http ссылка отбивается без похода в сеть', async () => {
    await expect(fetchImageBytes('/smm-media/i.png')).rejects.toThrow(/http/i);
    expect(axios.get).not.toHaveBeenCalled();
  });

  it('сетевая ошибка объясняет, что именно не скачалось', async () => {
    (axios.get as jest.Mock).mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(fetchImageBytes('https://my.linkeon.io/i.png')).rejects.toThrow(/ECONNREFUSED/);
    await expect(fetchImageBytes('https://my.linkeon.io/i.png')).rejects.toThrow(/картинк/i);
  });

  it('пустой ответ — ошибка, а не пустая картинка в Telegram', async () => {
    (axios.get as jest.Mock).mockResolvedValue({ data: Buffer.alloc(0) });

    await expect(fetchImageBytes('https://my.linkeon.io/i.png')).rejects.toThrow(/пуст/i);
  });
});
