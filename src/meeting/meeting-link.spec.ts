import { parseMeetingLink } from './meeting-link';

describe('parseMeetingLink', () => {
  it('находит код в нашей ссылке', () => {
    expect(parseMeetingLink('заходи https://my.linkeon.io/room/ABC234 в три')).toEqual({ code: 'ABC234' });
  });

  it('находит на тестовом домене', () => {
    expect(parseMeetingLink('https://test.linkeon.io/room/ABC234')).toEqual({ code: 'ABC234' });
  });

  it('находит на домене без поддомена', () => {
    expect(parseMeetingLink('https://linkeon.io/room/ABC234')).toEqual({ code: 'ABC234' });
  });

  it('приводит код к верхнему регистру', () => {
    expect(parseMeetingLink('https://my.linkeon.io/room/abc234')).toEqual({ code: 'ABC234' });
  });

  it('игнорирует хвост и query', () => {
    expect(parseMeetingLink('https://my.linkeon.io/room/ABC234?x=1#top')).toEqual({ code: 'ABC234' });
  });

  it('находит ссылку внутри markdown', () => {
    expect(parseMeetingLink('[встреча](https://my.linkeon.io/room/ABC234)')).toEqual({ code: 'ABC234' });
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
});
