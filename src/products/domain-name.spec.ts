import { MAX_NAME_LENGTH, normalizeDomain, relativeName } from './domain-name';

// strictNullChecks выключен в проекте (tsconfig.build.json) — на !r.ok TS не
// сужает union NormalizeResult (r.reason/r.say/r.domain дальше дают TS2339),
// а на явном сравнении с литералом r.ok === false/true сужает как положено.
const ok = (raw: string) => {
  const r = normalizeDomain(raw);
  if (r.ok === false) throw new Error(`ждали ok для ${raw}, получили ${r.reason}`);
  return r;
};
const refused = (raw: unknown) => {
  const r = normalizeDomain(raw);
  if (r.ok === true) throw new Error(`ждали отказ для ${String(raw)}, получили ${r.domain}`);
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

    // spb.ru — суффикс из PRIVATE-раздела списка (регистрационная зона
    // FAITID); учитывается через allowPrivateDomains.
    expect(ok('site.spb.ru')).toEqual({
      ok: true, domain: 'site.spb.ru', zone: 'site.spb.ru', apex: true,
      names: ['site.spb.ru', 'www.site.spb.ru'],
    });
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

    // Голый IPv6 без скобок: Node сам распознаёт полную форму как валидный
    // адрес ДО снятия порта — скобки тут не нужны, порт у голого IPv6 без
    // них и не отличить от хвоста адреса.
    expect(refused('::1')).toBe('ip');
    expect(refused('2a00:15f8::1')).toBe('ip');

    // Сокращённая запись IPv4 (127.1 = 127.0.0.1, «октетов меньше четырёх»):
    // ни net.isIP, ни tldts.parse() сырую строку такой не считают, но
    // domainToASCII реализует WHATWG-разбор хоста целиком и разворачивает её
    // в каноническую форму ДО нашей проверки — тогда уже info.isIp ловит.
    expect(refused('127.1')).toBe('ip');
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

  // Потолок считается по КАЖДОМУ имени, включая www, а не по самому домену:
  // *.ck — суффикс-маска (любая метка перед .ck — сама суффикс), поэтому
  // ДВЕ метки перед .ck — уже корень целиком, и www добавляет 4 знака сверху
  // домена, а не идёт вместо одной из его меток. Домен из 97 знаков сам
  // ещё в потолке (100), а с www — уже 101; 96 с www даёт ровно 100.
  it('потолок — это длина имени с www, а не самого домена', () => {
    const domain97 = `${'a'.repeat(63)}.${'b'.repeat(30)}.ck`;
    expect(domain97.length).toBe(97);
    expect(refused(domain97)).toBe('too_long');

    const domain96 = `${'a'.repeat(63)}.${'b'.repeat(29)}.ck`;
    expect(domain96.length).toBe(96);
    expect(ok(domain96)).toEqual({
      ok: true, domain: domain96, zone: domain96, apex: true,
      names: [domain96, `www.${domain96}`],
    });
    expect(`www.${domain96}`.length).toBe(MAX_NAME_LENGTH);
  });

  it('у отказа есть человеческий текст', () => {
    const r = normalizeDomain('1.2.3.4');
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.say).toMatch(/IP/);
  });

  it('относительное имя записи — от зоны регистратора', () => {
    expect(relativeName('dmitryvolkov.ru', 'dmitryvolkov.ru')).toBe('@');
    expect(relativeName('www.dmitryvolkov.ru', 'dmitryvolkov.ru')).toBe('www');
    expect(relativeName('_linkeon.shop.dmitryvolkov.ru', 'dmitryvolkov.ru')).toBe('_linkeon.shop');
  });
});
