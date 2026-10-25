import { SLUG_PATTERN, shortSlug, slugBase } from './short-slug';
import { DEFAULT_LINK_BASE, linkBase, shortLink, shortLinks, shortTarget } from './short-links';

describe('slugBase', () => {
  it('кириллица — латиницей, всё прочее — подчёркиванием', () => {
    expect(slugBase('Залог при аренде!')).toBe('zalog_pri_arende');
    expect(slugBase('Щука, ёлка и Юля')).toBe('schuka_elka_i_yulya');
    expect(slugBase('  --  ')).toBe('');
  });
});

describe('shortSlug', () => {
  it('основа и 4 знака id, не длиннее 40 и под шаблон меток', () => {
    expect(shortSlug('Залог при аренде', 'ab12cd34-0000-4000-8000-000000000000')).toBe('zalog_pri_arende_ab12');
    const long = shortSlug('очень '.repeat(20), 'ffff0000-0000-4000-8000-000000000000');
    expect(long.length).toBeLessThanOrEqual(40);
    expect(SLUG_PATTERN.test(long)).toBe(true);
    expect(long.endsWith('_ffff')).toBe(true);
  });

  it('тема без букв — short и хвост id', () => {
    expect(shortSlug('!!!', '0a0b0c0d-0000-4000-8000-000000000000')).toBe('short_0a0b');
  });
});

describe('ссылки роликов', () => {
  it('ведут в чат ассистента с метками площадки и кампании', () => {
    const url = shortLink({ base: 'https://my.linkeon.io', target: shortTarget(10), platform: 'telegram', slug: 'zalog_ab12' });
    expect(url).toBe('https://my.linkeon.io/chat?assistant=10&utm_source=telegram&utm_medium=short&utm_campaign=sh_zalog_ab12');
  });

  it('без ассистента — в чат', () => {
    expect(shortTarget(null)).toBe('chat');
  });

  it('по ссылке на каждую площадку', () => {
    const links = shortLinks('https://my.linkeon.io', 'chat', 'x_0000');
    expect(Object.keys(links).sort()).toEqual(['telegram', 'vk', 'youtube']);
    expect(links.youtube).toContain('utm_source=youtube');
  });

  it('кривой слаг метку не получает', () => {
    expect(() => shortLink({ base: 'https://my.linkeon.io', target: 'chat', platform: 'vk', slug: 'Залог' })).toThrow(/слаг/);
  });

  it('адрес кабинета — из SHORTS_LINK_BASE, хвостовой слэш снимается', () => {
    expect(linkBase({})).toBe(DEFAULT_LINK_BASE);
    expect(linkBase({ SHORTS_LINK_BASE: 'https://test.linkeon.io/' })).toBe('https://test.linkeon.io');
  });
});
