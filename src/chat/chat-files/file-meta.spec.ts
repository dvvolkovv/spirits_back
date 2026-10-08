// src/chat/chat-files/file-meta.spec.ts
import {
  MAX_NAME_CHARS,
  contentDispositionFor,
  contentTypeFor,
  encodeStrict,
  fileExt,
  lastPathSegment,
  relayRequestUrl,
  safeFileName,
} from './file-meta';

describe('fileExt', () => {
  it.each([
    ['report.pdf', 'pdf'],
    ['Отчёт.DOCX', 'docx'],
    ['archive.tar.gz', 'gz'],
    ['README', ''],
    ['.env', ''],
    ['name.', ''],
    ['weird.ext!', ''],
  ])('%s → «%s»', (name, ext) => expect(fileExt(name)).toBe(ext));
});

describe('lastPathSegment', () => {
  it('последний сегмент без query и якоря', () => {
    expect(lastPathSegment('https://r.linkeon.io/files/u_12_ru/sub/report.pdf?x=1#y')).toBe('report.pdf');
  });
  it('раскодирует %XX и не падает на одиноком %', () => {
    expect(lastPathSegment('https://h/files/k/%D0%94%D0%BE%D0%B3%D0%BE%D0%B2%D0%BE%D1%80.docx')).toBe('Договор.docx');
    expect(lastPathSegment('https://h/files/k/100%.txt')).toBe('100%.txt');
  });
});

describe('safeFileName', () => {
  it('разделители пути — в подчёркивания, управляющие символы — прочь', () => {
    expect(safeFileName('a/b\\c.pdf')).toBe('a_b_c.pdf');
    const nul = String.fromCharCode(0);
    const lf = String.fromCharCode(10);
    expect(safeFileName(`re${nul}port${lf}.pdf`)).toBe('report.pdf');
  });
  it('пустое и точки → file', () => {
    expect(safeFileName('')).toBe('file');
    expect(safeFileName('   ')).toBe('file');
    expect(safeFileName('..')).toBe('file');
  });
  it('кириллица и пробелы сохраняются', () => {
    expect(safeFileName('Договор аренды.docx')).toBe('Договор аренды.docx');
  });
  it('длинное имя режется до MAX_NAME_CHARS, расширение остаётся', () => {
    const out = safeFileName('а'.repeat(400) + '.docx');
    expect(Array.from(out)).toHaveLength(MAX_NAME_CHARS);
    expect(out.endsWith('.docx')).toBe(true);
  });
});

describe('contentTypeFor', () => {
  it.each([
    ['a.pdf', 'application/pdf'],
    ['a.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['a.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['a.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    ['a.PNG', 'image/png'],
    ['a.svg', 'image/svg+xml'],
    ['a.mp4', 'video/mp4'],
    ['a.mp3', 'audio/mpeg'],
    ['a.zip', 'application/zip'],
    ['a.unknown', 'application/octet-stream'],
    ['noext', 'application/octet-stream'],
  ])('%s → %s', (name, type) => expect(contentTypeFor(name)).toBe(type));

  it.each(['a.html', 'a.HTM', 'a.xhtml', 'a.xml', 'a.js', 'a.mjs'])(
    '%s браузер исполнил бы — отдаём октет-потоком',
    (name) => expect(contentTypeFor(name)).toBe('application/octet-stream'),
  );
});

describe('encodeStrict', () => {
  it(`кодирует и то, что encodeURIComponent оставляет как есть: ' ( ) * !`, () => {
    expect(encodeStrict(`a'b(c)*!.txt`)).toBe('a%27b%28c%29%2A%21.txt');
  });
  it('кириллица и пробел — как у encodeURIComponent', () => {
    expect(encodeStrict('Договор 1.docx')).toBe('%D0%94%D0%BE%D0%B3%D0%BE%D0%B2%D0%BE%D1%80%201.docx');
  });
});

describe('contentDispositionFor', () => {
  it('ASCII-имя как есть', () => {
    expect(contentDispositionFor('report.pdf')).toBe(`attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`);
  });
  it('кириллица: ASCII-замена и закодированное имя', () => {
    expect(contentDispositionFor('Договор 1.docx')).toBe(
      `attachment; filename="_______ 1.docx"; filename*=UTF-8''%D0%94%D0%BE%D0%B3%D0%BE%D0%B2%D0%BE%D1%80%201.docx`,
    );
  });
  it('кавычка не ломает заголовок, скобки и апостроф кодируются в filename*', () => {
    expect(contentDispositionFor(`a"b'(c).txt`)).toBe(
      `attachment; filename="a_b'(c).txt"; filename*=UTF-8''a%22b%27%28c%29.txt`,
    );
  });
});

describe('relayRequestUrl', () => {
  it('кодирует сырой адрес релея', () => {
    expect(relayRequestUrl('https://r.linkeon.io/files/u_12_ru/Договор аренды.docx')).toBe(
      'https://r.linkeon.io/files/u_12_ru/%D0%94%D0%BE%D0%B3%D0%BE%D0%B2%D0%BE%D1%80%20%D0%B0%D1%80%D0%B5%D0%BD%D0%B4%D1%8B.docx',
    );
  });
  it('уже закодированный второй раз не кодирует', () => {
    expect(relayRequestUrl('https://r.linkeon.io/files/k/a%20b.pdf')).toBe('https://r.linkeon.io/files/k/a%20b.pdf');
  });
  it('одинокий % кодирует как символ', () => {
    expect(relayRequestUrl('https://r.linkeon.io/files/k/100%.txt')).toBe('https://r.linkeon.io/files/k/100%25.txt');
  });
});
