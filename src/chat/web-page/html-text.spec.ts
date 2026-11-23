import { clipText, decodeEntities, htmlToPage } from './html-text';

const URL0 = 'https://example.com/dir/page.html';
const page = (html: string, url = URL0) => htmlToPage(html, url);

describe('decodeEntities', () => {
  it('частые именованные и числовые сущности', () => {
    expect(decodeEntities('&amp; &lt;b&gt; &quot;x&quot; &apos;y&apos; &#39;z&#39;')).toBe(`& <b> "x" 'y' 'z'`);
    expect(decodeEntities('&laquo;Привет&raquo; &mdash; &ndash; &hellip; &copy; &euro; &times; &deg;')).toBe('«Привет» — – … © € × °');
    expect(decodeEntities('&#1055;&#x440;&#X438;&#1074;&#1077;&#1090;')).toBe('Привет');
    expect(decodeEntities('&#128512;')).toBe('😀');
    expect(decodeEntities('a&nbsp;b')).toBe('a b');
  });

  it('незнакомое и битое — как есть; недопустимый код — U+FFFD', () => {
    expect(decodeEntities('&nosuch; &amp &#xZZ; & ; AT&T')).toBe('&nosuch; &amp &#xZZ; & ; AT&T');
    expect(decodeEntities('&#0; &#xD800; &#1114112;')).toBe('� � �');
  });

  it('имена из прототипа объекта — не сущности', () => {
    expect(decodeEntities('&constructor; &toString; &__proto__;')).toBe('&constructor; &toString; &__proto__;');
  });

  it('декод однократный: &amp;lt; — это текст «&lt;», а не «<»', () => {
    expect(decodeEntities('&amp;lt;')).toBe('&lt;');
  });
});

describe('htmlToPage: текст', () => {
  it('скрипты, стили и прочая невидимая начинка выкидываются вместе с содержимым', () => {
    const p = page(`<html><head><title>T</title><style>.a{color:red}</style><script>var s = "<p>секрет</p>";</script></head>
      <body><p>Видно</p>
      <script type="text/javascript">document.write('<p>тоже секрет</p>')</script>
      <noscript>Включите JavaScript</noscript>
      <svg viewBox="0 0 1 1"><text>логотип</text></svg>
      <template><p>шаблон</p></template>
      <iframe src="https://x.example/">рамка</iframe>
      <SCRIPT>alert("ВЕРХНИЙ РЕГИСТР")</SCRIPT >
      <p>Тоже видно</p></body></html>`);
    expect(p.text).toBe('Видно\n\nТоже видно');
    expect(p.hasScripts).toBe(true);
  });

  it('незакрытый script съедает хвост, а не выдаёт код', () => {
    const p = page('<p>До</p><script>var x = 1; <p>после</p>');
    expect(p.text).toBe('До');
  });

  it('комментарии и doctype не попадают в текст', () => {
    expect(page('<!DOCTYPE html><p>Раз<!-- скрытый <p>комментарий</p> --> два</p>').text).toBe('Раз два');
  });

  it('заголовки — строками с #, абзацы — через пустую строку', () => {
    const p = page('<h1>Главная</h1><p>Вступление</p><h2>Раздел</h2><h3>Пункт</h3><p>Текст</p>');
    expect(p.text).toBe('# Главная\n\nВступление\n\n## Раздел\n\n### Пункт\n\nТекст');
  });

  it('списки — пунктами «- », вложенные — с отступом', () => {
    const p = page('<ul><li>Раз</li><li>Два<ul><li>Два с половиной</li></ul></li></ul><ol><li>Первый</li></ol>');
    expect(p.text).toBe('- Раз\n- Два\n  - Два с половиной\n\n- Первый');
  });

  it('таблица — ячейки через « | », строки — с новой строки', () => {
    const p = page('<table><thead><tr><th>Имя</th><th>Цена</th></tr></thead><tbody><tr><td>Чай</td><td>100 ₽</td></tr><tr><td>Кофе</td><td>150 ₽</td></tr></tbody></table>');
    expect(p.text).toBe('Имя | Цена\nЧай | 100 ₽\nКофе | 150 ₽');
  });

  it('пробелы сжимаются, br — перенос, строчные элементы не рвут строку', () => {
    const p = page('<p>Первый   абзац\n   с  переносом</p><div>Второй<br>строка<br/>ещё</div><p>Это <b>жирный</b>, <i>курсив</i> и <a href="/x">ссылка</a>.</p>');
    expect(p.text).toBe('Первый абзац с переносом\n\nВторой\nстрока\nещё\n\nЭто жирный, курсив и ссылка.');
  });

  it('сущности в тексте декодируются, а экранированный тег остаётся текстом', () => {
    const p = page('<p>Цена&nbsp;&mdash; 5&nbsp;&euro;; &lt;script&gt;alert(1)&lt;/script&gt;</p>');
    expect(p.text).toBe('Цена — 5 €; <script>alert(1)</script>');
  });

  it('одиночный «<» в тексте и «>» в кавычках атрибута ничего не ломают', () => {
    const p = page('<p>5 < 6 и 7 > 3</p><p><a href="/x" title="a > b">текст</a> дальше</p>');
    expect(p.text).toBe('5 < 6 и 7 > 3\n\nтекст дальше');
  });

  it('pre сохраняет переносы и отступы', () => {
    const p = page('<p>Код:</p><pre>def f():\n    return 1</pre><p>Конец</p>');
    expect(p.text).toBe('Код:\n\ndef f():\n    return 1\n\nКонец');
  });

  it('пустые строки сжимаются до одной, края обрезаются', () => {
    const p = page('<div><div><p>А</p></div></div><div></div><div><p></p><h2></h2></div><div>Б</div>');
    expect(p.text).toBe('А\n\nБ');
  });

  it('выпадающие списки и медиа — без своей начинки', () => {
    const p = page('<p>Страна:</p><select><option>Австралия</option><option>Австрия</option></select><video>Ваш браузер не поддерживает видео</video><p>Дальше</p>');
    expect(p.text).toBe('Страна:\n\nДальше');
  });

  it('страница без скриптов — hasScripts=false', () => {
    expect(page('<p>Просто текст</p>').hasScripts).toBe(false);
  });
});

describe('htmlToPage: заголовок и описание', () => {
  it('title и meta description из head; head в текст не попадает', () => {
    const p = page(`<html><head><meta charset="utf-8"><title> Заголовок &amp; ко </title>
      <meta name="Description" content="Описание &quot;страницы&quot;"><link rel="stylesheet" href="/a.css"></head>
      <body><p>Тело</p></body></html>`);
    expect(p.title).toBe('Заголовок & ко');
    expect(p.description).toBe('Описание "страницы"');
    expect(p.text).toBe('Тело');
  });

  it('без title и meta description — og:title и og:description', () => {
    const p = page('<head><meta property="og:title" content="OG заголовок"><meta property="og:description" content="OG описание"></head><p>x</p>');
    expect(p.title).toBe('OG заголовок');
    expect(p.description).toBe('OG описание');
  });

  it('ничего нет — пустые строки', () => {
    const p = page('<p>x</p>');
    expect(p.title).toBe('');
    expect(p.description).toBe('');
  });

  it('head без закрывающего тега кончается на body', () => {
    const p = page('<head><title>T</title><body><p>Тело</p>');
    expect(p.title).toBe('T');
    expect(p.text).toBe('Тело');
  });
});

describe('htmlToPage: ссылки', () => {
  it('абсолютные http(s), относительно адреса страницы, уникальные, с текстом', () => {
    const p = page(`
      <a href="/about">О нас</a>
      <a href="contacts.html">  Контакты
         и адреса </a>
      <a href="https://other.example/x?a=1&amp;b=2#frag">Чужой сайт</a>
      <a href="/about">О нас ещё раз</a>
      <a href="mailto:a@example.com">Почта</a>
      <a href="javascript:void(0)">Кнопка</a>
      <a href="tel:+79990000000">Телефон</a>
      <a href="#top">Наверх</a>
      <a href="">Пусто</a>
      <a href="/empty"></a>
      <a href="/img"><img src="/i.png" alt="Картинка-ссылка"></a>
      <a href="/aria" aria-label="Подпись для экрана"><span class="icon"></span></a>`);
    expect(p.links).toEqual([
      { text: 'О нас', url: 'https://example.com/about' },
      { text: 'Контакты и адреса', url: 'https://example.com/dir/contacts.html' },
      { text: 'Чужой сайт', url: 'https://other.example/x?a=1&b=2' },
      { text: 'Картинка-ссылка', url: 'https://example.com/img' },
      { text: 'Подпись для экрана', url: 'https://example.com/aria' },
    ]);
  });

  it('base href меняет основу для относительных ссылок', () => {
    const p = page('<head><base href="https://cdn.example.org/root/"></head><a href="doc">Документ</a>');
    expect(p.links).toEqual([{ text: 'Документ', url: 'https://cdn.example.org/root/doc' }]);
  });

  it('не больше 50 ссылок', () => {
    const html = Array.from({ length: 80 }, (_, i) => `<a href="/p${i}">Ссылка ${i}</a>`).join(' ');
    const p = page(html);
    expect(p.links).toHaveLength(50);
    expect(p.links[49]).toEqual({ text: 'Ссылка 49', url: 'https://example.com/p49' });
  });
});

describe('clipText', () => {
  it('короткий текст — как есть', () => {
    expect(clipText('абв', 10)).toEqual({ text: 'абв', truncated: false });
  });

  it('длинный — обрезка до max с флагом, по границе строки, если она рядом', () => {
    const text = `${'а'.repeat(90)}\n${'б'.repeat(50)}`;
    const r = clipText(text, 100);
    expect(r.truncated).toBe(true);
    expect(r.text).toBe('а'.repeat(90));
  });

  it('без близкой границы — ровно max символов', () => {
    const r = clipText('я'.repeat(500), 100);
    expect(r).toEqual({ text: 'я'.repeat(100), truncated: true });
  });

  it('не рвёт суррогатную пару на границе', () => {
    const r = clipText(`${'a'.repeat(99)}😀😀`, 100);
    expect(r.text).toBe('a'.repeat(99));
    expect(r.truncated).toBe(true);
  });
});
