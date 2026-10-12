import sharp = require('sharp');
import { THUMB_SIZE, encodeKeyPath, parseThumbSrc, renderThumb, thumbKeyFor, thumbPathFor } from './thumbnails';

describe('parseThumbSrc', () => {
  it.each([
    ['linkeon-assets/images/1791472069716-j83id2.jpg', { bucket: 'linkeon-assets', key: 'images/1791472069716-j83id2.jpg' }],
    ['linkeon-chat-files/6eb9089f/кот на окне.PNG', { bucket: 'linkeon-chat-files', key: '6eb9089f/кот на окне.PNG' }],
  ])('пропускает %s', (src, want) => {
    expect(parseThumbSrc(src)).toEqual(want);
  });

  it.each([
    ['чужой бакет', 'linkeon-smm-videos/a.jpg'],
    ['аватары, а не сгенерированные', 'linkeon-assets/avatars/users/u.jpg'],
    ['сами миниатюры', 'linkeon-chat-files/thumbs/x.webp'],
    ['выход из папки', 'linkeon-chat-files/../linkeon-assets/images/a.jpg'],
    ['точка-сегмент', 'linkeon-assets/images/./a.jpg'],
    ['пустой сегмент', 'linkeon-assets/images//a.jpg'],
    ['ведущий слэш', '/linkeon-assets/images/a.jpg'],
    ['обратный слэш', 'linkeon-assets/images\\a.jpg'],
    ['не картинка', 'linkeon-chat-files/u/report.pdf'],
    ['svg', 'linkeon-chat-files/u/pic.svg'],
    ['управляющий символ', `linkeon-assets/images/a${String.fromCharCode(10)}.jpg`],
    ['без ключа', 'linkeon-assets'],
    ['слишком длинный', `linkeon-chat-files/${'a'.repeat(300)}.jpg`],
  ])('отклоняет: %s', (_n, src) => {
    expect(parseThumbSrc(src)).toBeNull();
  });

  it('не строка — null', () => {
    expect(parseThumbSrc(undefined)).toBeNull();
    expect(parseThumbSrc(['linkeon-assets/images/a.jpg'])).toBeNull();
  });
});

describe('thumbKeyFor', () => {
  it('один исходник — один ключ, без имени файла', () => {
    const s = { bucket: 'linkeon-chat-files', key: 'u/секретное имя.png' };
    expect(thumbKeyFor(s)).toBe(thumbKeyFor({ ...s }));
    expect(thumbKeyFor(s)).toMatch(/^thumbs\/[0-9a-f]{40}\.webp$/);
    expect(thumbKeyFor(s)).not.toBe(thumbKeyFor({ ...s, key: 'u/другое.png' }));
  });
});

describe('encodeKeyPath', () => {
  it('кодирует каждый сегмент, слэши оставляет', () => {
    expect(encodeKeyPath('u/кот (1).png')).toBe('u/%D0%BA%D0%BE%D1%82%20%281%29.png');
  });
});

describe('thumbPathFor', () => {
  const BASE = 'https://my.linkeon.io/smm-media';

  it('картинка из наших бакетов — путь ручки с раскодированным ключом', () => {
    expect(thumbPathFor(`${BASE}/linkeon-chat-files/u/%D0%BA%D0%BE%D1%82.png`, BASE))
      .toBe(`/webhook/chat/thumb?src=${encodeURIComponent('linkeon-chat-files/u/кот.png')}`);
  });

  it.each([
    ['чужой хост', 'https://evil.example/linkeon-assets/images/a.jpg'],
    ['наш хост, чужой бакет', `${BASE}/linkeon-smm-videos/a.jpg`],
    ['не картинка', `${BASE}/linkeon-chat-files/u/a.pdf`],
    ['нет адреса', undefined],
  ])('%s — без миниатюры', (_n, url) => {
    expect(thumbPathFor(url, BASE)).toBeUndefined();
  });
});

describe('renderThumb', () => {
  it('делает WebP 384×384 из большой картинки', async () => {
    const big = await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#ff6600' } }).png().toBuffer();
    const thumb = await renderThumb(big);
    const meta = await sharp(thumb).metadata();
    expect(meta.format).toBe('webp');
    expect([meta.width, meta.height]).toEqual([THUMB_SIZE, THUMB_SIZE]);
  });

  it('битые байты — ошибка', async () => {
    await expect(renderThumb(Buffer.from('не картинка'))).rejects.toThrow();
  });
});
