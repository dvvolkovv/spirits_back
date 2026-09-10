import { parseMeetingLink } from './meeting-link';

describe('parseMeetingLink', () => {
  it('находит код в нашей ссылке', () => {
    expect(parseMeetingLink('заходи https://my.linkeon.io/room/ABC234 в три')).toEqual({ provider: 'linkeon', code: 'ABC234' });
  });

  it('находит на тестовом домене', () => {
    expect(parseMeetingLink('https://test.linkeon.io/room/ABC234')).toEqual({ provider: 'linkeon', code: 'ABC234' });
  });

  it('находит на домене без поддомена', () => {
    expect(parseMeetingLink('https://linkeon.io/room/ABC234')).toEqual({ provider: 'linkeon', code: 'ABC234' });
  });

  it('приводит код к верхнему регистру', () => {
    expect(parseMeetingLink('https://my.linkeon.io/room/abc234')).toEqual({ provider: 'linkeon', code: 'ABC234' });
  });

  it('игнорирует хвост и query', () => {
    expect(parseMeetingLink('https://my.linkeon.io/room/ABC234?x=1#top')).toEqual({ provider: 'linkeon', code: 'ABC234' });
  });

  it('находит ссылку внутри markdown', () => {
    expect(parseMeetingLink('[встреча](https://my.linkeon.io/room/ABC234)')).toEqual({ provider: 'linkeon', code: 'ABC234' });
  });

  it('берёт первую из нескольких', () => {
    const text = 'https://my.linkeon.io/room/AAA234 или https://my.linkeon.io/room/BBB234';
    expect(parseMeetingLink(text)?.code).toBe('AAA234');
  });

  it('отвергает код с двусмысленным знаком — такого мы не выдаём', () => {
    expect(parseMeetingLink('https://my.linkeon.io/room/ABC01D')).toBeNull();
  });

  it('отвергает код неверной длины', () => {
    expect(parseMeetingLink('https://my.linkeon.io/room/ABC')).toBeNull();
    expect(parseMeetingLink('https://my.linkeon.io/room/ABCDEFGH')).toBeNull();
  });

  it('отвергает чужой домен', () => {
    expect(parseMeetingLink('https://evil.com/room/ABC234')).toBeNull();
  });

  it('не ловит домен, лишь заканчивающийся на linkeon.io', () => {
    expect(parseMeetingLink('https://notlinkeon.io/room/ABC234')).toBeNull();
  });

  it('не путает с другими нашими путями', () => {
    expect(parseMeetingLink('https://my.linkeon.io/chat/ABC234')).toBeNull();
  });

  it('текст без ссылок — null', () => {
    expect(parseMeetingLink('созвонимся завтра')).toBeNull();
  });

  it('не падает на пустом и не строке', () => {
    expect(parseMeetingLink('')).toBeNull();
    expect(parseMeetingLink(undefined as any)).toBeNull();
  });

  describe('комнаты Taler ID', () => {
    it('находит код в их ссылке', () => {
      // Настоящая ссылка, выданная владельцем 02.09.2026.
      expect(parseMeetingLink('https://api.talerid.io/room/36fc367a')).toEqual({
        provider: 'talerid', code: '36fc367a',
      });
    });

    it('находит на edge-домене', () => {
      // Абсолютные ссылки на api.talerid.io у пользователей из СНГ режет DPI,
      // поэтому их страница отдаётся и с других поддоменов.
      expect(parseMeetingLink('https://ru2.talerid.io/room/36fc367a')).toEqual({
        provider: 'talerid', code: '36fc367a',
      });
    });

    it('не трогает регистр их кода', () => {
      // Код hex и сверяется точно: приведение к верхнему регистру, уместное
      // для нашего алфавита, увело бы запрос в 404.
      expect(parseMeetingLink('https://api.talerid.io/room/36FC367A')).toEqual({
        provider: 'talerid', code: '36FC367A',
      });
    });

    it('отвергает домен, лишь оканчивающийся на их имя', () => {
      // Без точки перед доменом сюда прошёл бы nottalerid.io и увёл человека
      // на чужую встречу — та же ловушка, что и с linkeon.io.
      expect(parseMeetingLink('https://nottalerid.io/room/36fc367a')).toBeNull();
    });

    it('отвергает не-hex код', () => {
      expect(parseMeetingLink('https://api.talerid.io/room/zzzzzzzz')).toBeNull();
    });

    it('находит ссылку внутри текста и markdown', () => {
      expect(parseMeetingLink('созвон [тут](https://api.talerid.io/room/36fc367a) в пять')).toEqual({
        provider: 'talerid', code: '36fc367a',
      });
    });

    it('своя ссылка не путается с чужой', () => {
      expect(parseMeetingLink('https://my.linkeon.io/room/ABC234')).toEqual({
        provider: 'linkeon', code: 'ABC234',
      });
    });
  });

  describe('встречи Google Meet', () => {
    it('находит код встречи', () => {
      expect(parseMeetingLink('созвон https://meet.google.com/abc-defg-hij в пять')).toEqual({
        provider: 'meet', code: 'abc-defg-hij',
      });
    });

    it('приводит код к нижнему регистру', () => {
      // Код у Meet всегда строчный; вставленный из письма ВЕРСАЛОМ должен
      // сойтись с тем, что мы положим в external_room и в meeting_url.
      expect(parseMeetingLink('https://meet.google.com/ABC-DEFG-HIJ')).toEqual({
        provider: 'meet', code: 'abc-defg-hij',
      });
    });

    it('игнорирует query и хвост', () => {
      expect(parseMeetingLink('https://meet.google.com/abc-defg-hij?authuser=0')).toEqual({
        provider: 'meet', code: 'abc-defg-hij',
      });
    });

    it('находит внутри markdown', () => {
      expect(parseMeetingLink('[созвон](https://meet.google.com/abc-defg-hij)')).toEqual({
        provider: 'meet', code: 'abc-defg-hij',
      });
    });

    it('отвергает домен, лишь оканчивающийся на meet.google.com', () => {
      // Поддомен здесь НЕ необязателен, в отличие от linkeon.io и talerid.io:
      // у Meet его не бывает, а группа (?:[a-z0-9-]+\.)? пропустила бы это.
      expect(parseMeetingLink('https://notmeet.google.com/abc-defg-hij')).toBeNull();
      expect(parseMeetingLink('https://meet.google.com.evil.ru/abc-defg-hij')).toBeNull();
    });

    it('отвергает код неверной формы', () => {
      expect(parseMeetingLink('https://meet.google.com/abcd-efgh-ijkl')).toBeNull();
      expect(parseMeetingLink('https://meet.google.com/abc-def-hij')).toBeNull();
      expect(parseMeetingLink('https://meet.google.com/abc123-defg-hij')).toBeNull();
    });

    it('не путает с другими путями Meet', () => {
      expect(parseMeetingLink('https://meet.google.com/lookup/abc-defg-hij')).toBeNull();
    });

    it('находит код при полностью капсовом URL', () => {
      // Канонический код Meet строчный, но протокол, хост и код могут прийти
      // в любом регистре — отсюда /i в регулярке, а не голый [a-z].
      expect(parseMeetingLink('HTTPS://MEET.GOOGLE.COM/ABC-DEFG-HIJ')).toEqual({
        provider: 'meet', code: 'abc-defg-hij',
      });
    });

    it('битый код своей комнаты не скрывает валидную ссылку Meet', () => {
      // `return null` в ветке linkeon съедал всё сообщение целиком: карточка
      // не показывалась, хотя ссылка на живую встречу в нём была.
      expect(parseMeetingLink('https://my.linkeon.io/room/ABC01D и https://meet.google.com/abc-defg-hij')).toEqual({
        provider: 'meet', code: 'abc-defg-hij',
      });
    });

    it('при двух ссылках разных площадок выигрывает порядок проверки, а не текста', () => {
      // Фиксируем фактическое поведение: ветви идут linkeon → talerid → meet,
      // и своя комната побеждает даже стоя второй в тексте. Выбор «первая по
      // позиции» — отдельное решение, здесь его нет.
      const text = 'https://meet.google.com/abc-defg-hij потом https://my.linkeon.io/room/ABC234';
      expect(parseMeetingLink(text)).toEqual({ provider: 'linkeon', code: 'ABC234' });
    });

    it('каждая площадка узнаётся по отдельности', () => {
      expect(parseMeetingLink('https://my.linkeon.io/room/ABC234')?.provider).toBe('linkeon');
      expect(parseMeetingLink('https://api.talerid.io/room/36fc367a')?.provider).toBe('talerid');
      expect(parseMeetingLink('https://meet.google.com/abc-defg-hij')?.provider).toBe('meet');
    });
  });
  describe('Zoom', () => {
    const LINK = 'https://us04web.zoom.us/j/71077562785?pwd=Y5JwbnVqjs11slpbCOzBOI54zw8bAd.1';

    it('код — числовой id, адрес — нормализованная ссылка', () => {
      // Разделение принципиальное: код опознаёт встречу для человека и для
      // базы, адрес нужен боту. Из кода адрес не собрать — в ссылке хост
      // аккаунта и хеш пароля.
      expect(parseMeetingLink(`зайди сюда ${LINK}`)).toEqual({
        provider: 'zoom',
        code: '71077562785',
        url: LINK,
      });
    });

    it('поддомен аккаунта сохраняется, регистр хоста приводится', () => {
      // us04web, us05web, <компания>.zoom.us — потерять поддомен значит
      // потерять вход.
      expect(parseMeetingLink('https://ACME.Zoom.US/j/123456789')?.url)
        .toBe('https://acme.zoom.us/j/123456789');
    });

    it('вебинарная ссылка /w/ тоже узнаётся', () => {
      expect(parseMeetingLink('https://us05web.zoom.us/w/987654321?pwd=abc')).toEqual({
        provider: 'zoom', code: '987654321', url: 'https://us05web.zoom.us/w/987654321?pwd=abc',
      });
    });

    it('мусорные параметры отбрасываются, pwd и tk остаются', () => {
      // Ссылка уезжает в базу и в чужой сервис: utm-метки там только мешают
      // сверять, а pwd и tk — единственное, без чего бот не войдёт.
      const url = parseMeetingLink(
        'https://us04web.zoom.us/j/71077562785?pwd=SECRET.1&utm_source=mail&tk=TOKEN&uuid=xyz#success',
      )?.url;
      expect(url).toBe('https://us04web.zoom.us/j/71077562785?pwd=SECRET.1&tk=TOKEN');
    });

    it('регистр pwd не трогается', () => {
      // Хеш пароля регистрозависим: приведение к нижнему регистру, уместное
      // для хоста, здесь увело бы в отказ входа.
      expect(parseMeetingLink('https://us04web.zoom.us/j/123456789?pwd=AbCdEf.1')?.url)
        .toBe('https://us04web.zoom.us/j/123456789?pwd=AbCdEf.1');
    });

    it('чужой домен с zoom.us внутри не проходит', () => {
      // Тот же класс защиты, что у notmeet.google.com и notlinkeon.io.
      expect(parseMeetingLink('https://notzoom.us/j/123456789')).toBeNull();
      expect(parseMeetingLink('https://zoom.us.evil.ru/j/123456789')).toBeNull();
    });

    it('личная ссылка /my/ не поддержана — это не встреча с id', () => {
      // Мост достаёт из пути первую числовую группу и на такой ссылке
      // получает пусто. Пусть остаётся обычной ссылкой в разговоре.
      expect(parseMeetingLink('https://us04web.zoom.us/my/dmitry')).toBeNull();
    });

    it('короткий или слишком длинный id не проходит', () => {
      expect(parseMeetingLink('https://us04web.zoom.us/j/12345')).toBeNull();
      expect(parseMeetingLink('https://us04web.zoom.us/j/1234567890123')?.code).not.toBe('1234567890123');
    });

    it('«созвонимся в зуме» карточку не рисует', () => {
      // Та же проверка, что для «созвонимся завтра» у Meet: слово площадки в
      // тексте не ссылка.
      expect(parseMeetingLink('давай созвонимся в зуме после обеда')).toBeNull();
      expect(parseMeetingLink('пришлю zoom.us позже')).toBeNull();
    });

    it('своя комната по-прежнему побеждает по порядку проверки', () => {
      const text = `${LINK} потом https://my.linkeon.io/room/ABC234`;
      expect(parseMeetingLink(text)?.provider).toBe('linkeon');
    });

    it('у остальных площадок адреса в разборе нет', () => {
      // Поле обязано появляться ТОЛЬКО там, где адрес не выводится из кода:
      // иначе оно расползётся по коду как «иногда есть, иногда нет».
      expect(parseMeetingLink('https://meet.google.com/abc-defg-hij')?.url).toBeUndefined();
      expect(parseMeetingLink('https://my.linkeon.io/room/ABC234')?.url).toBeUndefined();
      expect(parseMeetingLink('https://api.talerid.io/room/36fc367a')?.url).toBeUndefined();
    });
  });

});