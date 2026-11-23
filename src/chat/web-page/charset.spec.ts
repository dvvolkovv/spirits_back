import { decodeBody } from './charset';

// Кириллица в однобайтовых кодировках — без iconv: А..я в windows-1251 идут
// подряд с 0xC0; в KOI8-R — своя раскладка (строчные 0xC0–0xDF, заглавные +0x20).
const KOI8_LOWER = 'юабцдефгхийклмнопярстужвьызшэщчъ';
function cp1251(s: string): Buffer {
  return Buffer.from([...s].map((ch) => {
    const c = ch.charCodeAt(0);
    if (c >= 0x410 && c <= 0x44f) return c - 0x410 + 0xc0;
    if (ch === 'ё') return 0xb8;
    if (ch === 'Ё') return 0xa8;
    if (c < 0x80) return c;
    throw new Error(`нет в тесте: ${ch}`);
  }));
}
function koi8r(s: string): Buffer {
  return Buffer.from([...s].map((ch) => {
    const lower = KOI8_LOWER.indexOf(ch);
    if (lower >= 0) return 0xc0 + lower;
    const upper = KOI8_LOWER.indexOf(ch.toLowerCase());
    if (upper >= 0) return 0xe0 + upper;
    const c = ch.charCodeAt(0);
    if (c < 0x80) return c;
    throw new Error(`нет в тесте: ${ch}`);
  }));
}
const ascii = (s: string) => Buffer.from(s, 'latin1');

describe('decodeBody: кодировка ответа', () => {
  it('проверка помощников теста на известных байтах', () => {
    expect([...cp1251('Привет')]).toEqual([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]);
    expect([...koi8r('Привет')]).toEqual([0xf0, 0xd2, 0xc9, 0xd7, 0xc5, 0xd4]);
  });

  it('по умолчанию — utf-8', () => {
    const r = decodeBody(Buffer.from('<p>Привет, мир</p>', 'utf8'), 'text/html', 'html');
    expect(r).toEqual({ text: '<p>Привет, мир</p>', charset: 'utf-8' });
  });

  it('windows-1251 из Content-Type (регистр и кавычки — любые)', () => {
    const body = cp1251('Съешь же ещё этих мягких французских булок');
    expect(decodeBody(body, 'text/html; charset=windows-1251', 'html').text).toBe('Съешь же ещё этих мягких французских булок');
    expect(decodeBody(body, 'text/plain; Charset="CP1251"', 'other').text).toBe('Съешь же ещё этих мягких французских булок');
  });

  it('koi8-r из Content-Type', () => {
    const r = decodeBody(koi8r('Привет, мир'), 'text/html; charset=KOI8-R', 'html');
    expect(r).toEqual({ text: 'Привет, мир', charset: 'koi8-r' });
  });

  it('без charset в заголовке — <meta charset>', () => {
    const body = Buffer.concat([ascii('<html><head><meta charset="windows-1251"><title>'), cp1251('Заголовок'), ascii('</title>')]);
    const r = decodeBody(body, 'text/html', 'html');
    expect(r.charset).toBe('windows-1251');
    expect(r.text).toContain('<title>Заголовок</title>');
  });

  it('без charset в заголовке — <meta http-equiv content="…; charset=…">', () => {
    const body = Buffer.concat([
      ascii('<HTML><HEAD><META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=koi8-r"></HEAD><BODY>'),
      koi8r('Тело страницы'),
    ]);
    expect(decodeBody(body, '', 'html').text).toContain('Тело страницы');
  });

  it('charset заголовка главнее meta', () => {
    const body = Buffer.concat([ascii('<meta charset="windows-1251">'), koi8r('Привет')]);
    expect(decodeBody(body, 'text/html; charset=koi8-r', 'html').text).toBe('<meta charset="windows-1251">Привет');
  });

  it('BOM главнее всего, и сам BOM в текст не попадает', () => {
    const body = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Привет', 'utf8')]);
    expect(decodeBody(body, 'text/html; charset=windows-1251', 'html')).toEqual({ text: 'Привет', charset: 'utf-8' });
  });

  it('XML: encoding из пролога', () => {
    const body = Buffer.concat([ascii('<?xml version="1.0" encoding="windows-1251"?><rss><title>'), cp1251('Новости'), ascii('</title></rss>')]);
    expect(decodeBody(body, 'application/rss+xml', 'xml').text).toContain('<title>Новости</title>');
  });

  it('незнакомая кодировка — utf-8', () => {
    const body = Buffer.from('Привет', 'utf8');
    expect(decodeBody(body, 'text/html; charset=x-no-such-charset', 'html')).toEqual({ text: 'Привет', charset: 'utf-8' });
    expect(decodeBody(Buffer.concat([ascii('<meta charset="bogus">'), body]), 'text/html', 'html').charset).toBe('utf-8');
  });

  it('метка «replacement» (iso-2022-kr и т.п.) не превращает страницу в один «�» — utf-8', () => {
    const r = decodeBody(Buffer.from('Привет', 'utf8'), 'text/html; charset=iso-2022-kr', 'html');
    expect(r).toEqual({ text: 'Привет', charset: 'utf-8' });
  });

  it('meta с utf-16 в однобайтовом документе — utf-8 (как в браузере)', () => {
    const body = Buffer.from('<meta charset="utf-16"><p>Привет</p>', 'utf8');
    expect(decodeBody(body, 'text/html', 'html').text).toBe('<meta charset="utf-16"><p>Привет</p>');
  });

  it('битые байты utf-8 — U+FFFD, а не исключение', () => {
    expect(decodeBody(Buffer.from([0x41, 0xff, 0x42]), 'text/plain', 'other').text).toBe('A�B');
  });
});
