import { MAX_NAME_LENGTH, normalizeDomain, relativeName } from './domain-name';

const ok = (raw: string) => {
  const r = normalizeDomain(raw);
  if (!r.ok) throw new Error(`ждали ok для ${raw}, получили ${r.reason}`);
  return r;
};
const refused = (raw: unknown) => {
  const r = normalizeDomain(raw);
  if (r.ok) throw new Error(`ждали отказ для ${String(raw)}, получили ${r.domain}`);
  return r.reason;
};

describe('нормализация своего домена', () => {
  it('корень привязывается вместе с www', () => {
    expect(ok('dmitryvolkov.ru')).toEqual({
      ok: true, domain: 'dmitryvolkov.ru', zone: 'dmitryvolkov.ru', apex: true,
      names: ['dmitryvolkov.ru', 'www.dmitryvolkov.ru'],
    });
  });

  it('поддомен привязывается один, без www', () => {
    expect(ok('shop.dmitryvolkov.ru')).toMatchObject({
      domain: 'shop.dmitryvolkov.ru', zone: 'dmitryvolkov.ru', apex: false, names: ['shop.dmitryvolkov.ru'],
    });
  });

  it('www.<корень> понимается как корень', () => {
    expect(ok('www.dmitryvolkov.ru')).toMatchObject({ domain: 'dmitryvolkov.ru', apex: true });
  });

  it('схема, путь, запрос, порт, регистр и точка на конце снимаются', () => {
    expect(ok('https://Www.DmitryVolkov.RU:443/path?x=1#top').domain).toBe('dmitryvolkov.ru');
    expect(ok('dmitryvolkov.ru.').domain).toBe('dmitryvolkov.ru');
    expect(ok('  DMITRYVOLKOV.RU  ').domain).toBe('dmitryvolkov.ru');
  });

  // Корень определяется по списку публичных суффиксов, а не «две метки»:
  // иначе site.co.uk считался бы поддоменом co.uk, а shop.site.ru — корнем.
  it('корень по списку публичных суффиксов', () => {
    expect(ok('site.co.uk')).toMatchObject({ apex: true, zone: 'site.co.uk' });
    expect(ok('shop.site.co.uk')).toMatchObject({ apex: false, zone: 'site.co.uk' });

    // spb.ru/msk.ru когда-то были в публичном списке суффиксов (геозоны,
    // поданы FAITID, PR publicsuffix/list#384), но список их с тех пор снял —
    // это било по лимитам выдачи Let's Encrypt, ровно то, от чего список
    // защищает. Сверено 24.09.2026 прямым запросом publicsuffix.org/list и
    // живым parse() из tldts: сейчас 'ru' — единственный суффикс, spb.ru —
    // обычный двухметочный домен, как dmitryvolkov.ru. Утверждение здесь —
    // намеренно НЕ «site.spb.ru — корень» (это было бы неверно сегодня), а
    // обратное: код не должен угадывать региональные зоны сам, только то, что
    // реально отдаёт список суффиксов на момент запуска.
    expect(ok('site.spb.ru')).toMatchObject({ apex: false, zone: 'spb.ru' });
  });

  it('кириллица переводится в punycode', () => {
    expect(ok('пример.рф')).toMatchObject({ domain: 'xn--e1afmkfd.xn--p1ai', apex: true });
  });

  it('IP — не домен', () => {
    expect(refused('1.2.3.4')).toBe('ip');
    expect(refused('1.2.3.4:8080')).toBe('ip');
    expect(refused('[::1]')).toBe('ip');
    expect(refused('[2a00:15f8::1]:443')).toBe('ip');
    expect(refused('http://139.59.210.42/')).toBe('ip');
  });

  it('зоны Линкеона — наши, а не свои', () => {
    expect(refused('linkeon.io')).toBe('our_zone');
    expect(refused('demo.p.linkeon.io')).toBe('our_zone');
    expect(refused('x.c.linkeon.io')).toBe('our_zone');
  });

  it('чужой домен с похожим хвостом — не наша зона', () => {
    expect(ok('evil-linkeon.io').domain).toBe('evil-linkeon.io');
  });

  it('пустое, без точки и кривая форма отбиваются', () => {
    expect(refused('')).toBe('empty');
    expect(refused(undefined)).toBe('empty');
    expect(refused('localhost')).toBe('no_dot');
    expect(refused('a..b.ru')).toBe('bad_form');
    expect(refused('-bad.ru')).toBe('bad_form');
    expect(refused('co.uk')).toBe('bad_form');
    expect(refused('under_score.ru')).toBe('bad_form');
  });

  // Замер на nginx 1.24 машин продуктов: длинное имя роняет `nginx -t` всей
  // машины. Потолок — на каждое имя, включая www.
  it('имя длиннее потолка отбивается, ровно потолок — нет', () => {
    const exact = `${'a'.repeat(48)}.${'b'.repeat(48)}.ru`;
    expect(exact.length).toBe(MAX_NAME_LENGTH);
    expect(ok(exact).names).toEqual([exact]);
    expect(refused(`${'a'.repeat(50)}.${'b'.repeat(50)}.ru`)).toBe('too_long');
  });

  it('у отказа есть человеческий текст', () => {
    const r = normalizeDomain('1.2.3.4');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.say).toMatch(/IP/);
  });

  it('относительное имя записи — от зоны регистратора', () => {
    expect(relativeName('dmitryvolkov.ru', 'dmitryvolkov.ru')).toBe('@');
    expect(relativeName('www.dmitryvolkov.ru', 'dmitryvolkov.ru')).toBe('www');
    expect(relativeName('_linkeon.shop.dmitryvolkov.ru', 'dmitryvolkov.ru')).toBe('_linkeon.shop');
  });
});
