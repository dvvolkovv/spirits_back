import {
  FIND_FILES_DEFAULT_LIMIT, assistantPart, extractHumanLinks, kindByMime, normalizeForSearch, parseFindFilesInput, plainNote, queryWords, scoreFile, trimUrlTail,
} from './find-files';

describe('parseFindFilesInput', () => {
  it('пустой вход — без слов, любой вид, без фильтров, лимит по умолчанию', () => {
    expect(parseFindFilesInput(undefined)).toEqual({ query: '', kind: 'any', assistant: '', days: null, limit: FIND_FILES_DEFAULT_LIMIT });
  });
  it('kind=link распознаётся, прочее — any', () => {
    expect(parseFindFilesInput({ kind: 'LINK' }).kind).toBe('link');
    expect(parseFindFilesInput({ kind: 'url' }).kind).toBe('any');
  });
  it('приводит типы и зажимает числа в рамки', () => {
    expect(parseFindFilesInput({ query: '  договор ', kind: 'DOCUMENT', assistant: ' Ирина ', days: '30', limit: 500 }))
      .toEqual({ query: 'договор', kind: 'document', assistant: 'Ирина', days: 30, limit: 30 });
    expect(parseFindFilesInput({ kind: 'spreadsheet', days: 0, limit: -3 })).toMatchObject({ kind: 'any', days: null, limit: FIND_FILES_DEFAULT_LIMIT });
    expect(parseFindFilesInput({ days: 99999 }).days).toBe(3650);
  });
  it('длинные строки обрезаются', () => {
    expect(parseFindFilesInput({ query: 'а'.repeat(500) }).query).toHaveLength(200);
  });
});

describe('слова и очки', () => {
  it('ё и регистр не мешают', () => {
    expect(normalizeForSearch('Отчёт ПО Ёлкам')).toBe('отчет по елкам');
  });
  it('слова запроса — от двух знаков, без повторов', () => {
    expect(queryWords('Договор аренды, договор! и 2026')).toEqual(['договор', 'аренды', '2026']);
  });
  it('слово в имени весит больше, чем в тексте', () => {
    expect(scoreFile(['договор'], 'dogovor.docx', 'Подготовила договор аренды')).toBe(1);
    expect(scoreFile(['договор'], 'Договор.docx', 'без слова')).toBe(3);
    expect(scoreFile(['договор', 'аренды'], 'Договор.docx', 'договор аренды')).toBe(5);
    expect(scoreFile(['отчет'], 'report.pdf', 'про погоду')).toBe(0);
  });
});

describe('plainNote', () => {
  it('без разметки, адресов и маркеров, не длиннее предела', () => {
    const text = '## Итог\n\nСделала **договор аренды** — [Скачать d.docx](https://pub/x/d.docx)\n\n![](https://pub/i.png) [VIDEO_JOB:11111111-2222-4333-8444-555555555555]';
    expect(plainNote(text)).toBe('Итог Сделала договор аренды — Скачать d.docx');
    expect(Array.from(plainNote('я'.repeat(500), 50))).toHaveLength(50);
  });
});

describe('assistantPart', () => {
  it('число, кастомный ассистент, «Чистый лист» срезается', () => {
    expect(assistantPart('u1_12', 'u1')).toBe('12');
    expect(assistantPart('u1_custom:0f8e6a1c-1111-4222-8333-444455556666', 'u1')).toBe('custom:0f8e6a1c-1111-4222-8333-444455556666');
    expect(assistantPart('u1_12_fresh_1728000000000', 'u1')).toBe('12');
    expect(assistantPart('u2_12', 'u1')).toBe('');
  });
});

describe('kindByMime', () => {
  it('вид исходной загрузки: mime важнее расширения, без mime — расширение', () => {
    expect(kindByMime('image/png', 'file')).toBe('image');
    expect(kindByMime('video/mp4', 'clip')).toBe('video');
    expect(kindByMime('audio/mpeg', 'voice')).toBe('audio');
    expect(kindByMime('application/octet-stream', 'photo.jpg')).toBe('image');
    expect(kindByMime('', 'архив.zip')).toBe('document');
    expect(kindByMime('application/pdf', 'отчёт.pdf')).toBe('document');
  });
});

describe('extractHumanLinks', () => {
  it('markdown и голые адреса, дубли схлопываются', () => {
    expect(extractHumanLinks('[док](https://example.com/a.pdf) и https://example.com/b.png, снова https://example.com/a.pdf'))
      .toEqual([
        { url: 'https://example.com/a.pdf', text: 'док' },
        { url: 'https://example.com/b.png', text: '' },
      ]);
  });

  it('хвостовая пунктуация и обёртки не входят в адрес, парные скобки внутри — часть адреса', () => {
    expect(extractHumanLinks('зайди на https://example.com/page.')[0].url).toBe('https://example.com/page');
    expect(extractHumanLinks('(https://example.com/x)')[0].url).toBe('https://example.com/x');
    expect(extractHumanLinks('https://ru.wikipedia.org/wiki/Файл_(формат) ок')[0].url).toBe('https://ru.wikipedia.org/wiki/Файл_(формат)');
  });

  it('код — не ссылки', () => {
    expect(extractHumanLinks('```js\nfetch("https://example.com/a")\n``` плюс `https://example.com/inline`')).toEqual([]);
  });

  it('внутренние /webhook/chat-uploads/ исключены: их покрывает источник исходников', () => {
    expect(extractHumanLinks('файл https://my.linkeon.io/webhook/chat-uploads/11111111-1111-4111-8111-111111111111 тут')).toEqual([]);
  });
});

describe('trimUrlTail и cap — защита от квадратичной бомбы', () => {
  it('100 тысяч закрывающих скобок снимаются линейно, быстрее секунды', () => {
    const url = 'http://x' + ')'.repeat(100_000);
    const t0 = Date.now();
    expect(trimUrlTail(url)).toBe('http://x');
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('мусор длиннее cap не становится ссылкой — сообщение с ним не вешает поиск', () => {
    expect(extractHumanLinks('http://x' + ')'.repeat(5000))).toEqual([]);
  });

  it('cap не ломает легитимные длинные адреса: query, fragment, парные скобки', () => {
    const long = 'https://example.com/p?q=' + 'a'.repeat(300) + '#frag';
    expect(extractHumanLinks(`смотри ${long} здесь`)[0].url).toBe(long);
    expect(extractHumanLinks('https://ru.wikipedia.org/wiki/Файл_(формат)?oldid=123456#Ссылки')[0].url)
      .toBe('https://ru.wikipedia.org/wiki/Файл_(формат)?oldid=123456#Ссылки');
  });
});
