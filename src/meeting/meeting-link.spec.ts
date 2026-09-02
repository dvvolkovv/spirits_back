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
});
