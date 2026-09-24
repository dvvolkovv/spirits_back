import { MAX_INPUT_LENGTH, MAX_LABELS, MAX_NAME_LENGTH, normalizeDomain, registrableZone, relativeName } from './domain-name';

// strictNullChecks выключен в tsconfig.json (build-конфиг его наследует) —
// на !r.ok TS не сужает union NormalizeResult (r.reason/r.say/r.domain дальше
// дают TS2339), а на явном сравнении с литералом r.ok === false/true сужает
// как положено.
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

    // Протокол-относительный префикс (без схемы, просто //) и схема любым
    // регистром — обе формы встречаются, когда домен копируют из адресной
    // строки браузера или из HTML-атрибута.
    expect(ok('//dmitryvolkov.ru').domain).toBe('dmitryvolkov.ru');
    expect(ok('HTTPS://DmitryVolkov.RU').domain).toBe('dmitryvolkov.ru');

    // toLowerCase() до domainToASCII здесь НЕ нужен: своим lower мы бы сами
    // испортили свёртку регистра UTS46 (case folding). Приведение к нижнему
    // регистру превращает 'ẞ' (заглавная эсцет) в 'ß', и та доезжает до
    // punycode, а свёртка внутри domainToASCII разворачивает 'ẞ' в 'ss' — как
    // в браузере, — только если МЫ САМИ не привели строку к нижнему регистру
    // заранее.
    expect(ok('STRAẞE.de').domain).toBe('strasse.de');
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

  // R-LDH (RFC 5891 §4.2.3.1): дефис в 3-4 позиции метки зарезервирован под
  // ACE-префикс xn--. Let's Encrypt/Boulder такие имена отбивает
  // (errInvalidRLDH) — сертификат для них не выпустится никогда.
  it('дефис в 3-4 позиции метки — не xn-- — отбивается', () => {
    expect(refused('ab--cd.ru')).toBe('bad_form');
    expect(refused('shop.ab--cd.example.ru')).toBe('bad_form');
    // xn-- — легитимный ACE-префикс, а не нарушение RLDH.
    expect(ok('пример.рф').domain).toBe('xn--e1afmkfd.xn--p1ai');
  });

  // Типографские тире/апострофы и подобная пунктуация успешно кодируются
  // punycode'ом (ACE-строка синтаксически валидна и проходит все проверки
  // формы), но настоящего домена с такими метками не бывает — почти всегда
  // это автозамена текстового редактора или мобильной клавиатуры.
  it('пунктуация в юникодной форме метки отбивается', () => {
    expect(refused('dmitry–volkov.ru')).toBe('bad_form'); // en dash U+2013
    expect(refused('dmitry’s.ru')).toBe('bad_form'); // «умный» апостроф U+2019

    // Полноширинный дефис U+FF0D — domainToASCII сам разворачивает его в
    // обычный ASCII-дефис ДО нашей проверки пунктуации, дефис из проверки
    // осознанно исключён (иначе обычные имена с дефисом сами не проходили бы).
    expect(ok('dmitry－volkov.ru').domain).toBe('dmitry-volkov.ru');
  });

  // Самая вероятная причина смешения латиницы с кириллицей в одной метке —
  // сбитая раскладка клавиатуры: кириллическая «о» неотличима глазом от
  // латинской, но кодируется в другой punycode, и TXT-запись для проверки
  // владения таким доменом не найдётся никогда — а настоящая зона пользователя
  // тем временем получит записи, которые ничего не подтверждают.
  it('латиница и кириллица в одной метке — mixed_script', () => {
    expect(refused('dmitryvolkоv.ru')).toBe('mixed_script'); // кириллическая "о" (U+043E)
    // Чисто кириллический домен — не смешение: обе метки одного письма.
    expect(ok('магазин.пример.рф').apex).toBe(false);
    // Латиница с диакритикой — тоже не смешение: ü входит в Script=Latin.
    expect(ok('münchen.de').apex).toBe(true);
  });

  // Зона обязана быть настоящей (ICANN или PRIVATE), а не «последняя метка —
  // наверное суффикс»: это поведение tldts по умолчанию для нераспознанной
  // зоны, иначе dmitryvolkov.ruu или опечатка в зоне проходили бы как валидный
  // домен, хотя сертификат для них не выпустится никогда.
  it('несуществующая доменная зона — unknown_tld', () => {
    expect(refused('dmitryvolkov.rf')).toBe('unknown_tld'); // не 'рф' и не реальный TLD
    expect(refused('dmitryvolkov.ruu')).toBe('unknown_tld'); // опечатка в зоне
    expect(refused('site.local')).toBe('unknown_tld'); // спец-использование, не публичная зона
    expect(ok('site.spb.ru').apex).toBe(true); // PRIVATE — настоящая зона
    expect(ok('site.co.uk').apex).toBe(true); // ICANN — настоящая зона
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

  // Boulder (Let's Encrypt) maxLabels = 10 — сертификат для домена глубже не
  // выпустится никогда.
  it('больше 10 меток отбивается, ровно 10 — нет', () => {
    expect(refused('a.b.c.d.e.f.g.h.i.j.ru')).toBe('too_long'); // 11 меток
    expect(ok('a.b.c.d.e.f.g.h.i.ru').names).toEqual(['a.b.c.d.e.f.g.h.i.ru']); // 10 меток
  });

  // Проверяем ПРИЧИНУ отказа, а не время выполнения: синхронный код jest не
  // прервёт, зависший тест просто упёрся бы в общий таймаут раннера, а не
  // указал бы, что именно сломалось. JSON-лимит бэка — 50 МБ, а нормализатор
  // зовётся ДО проверки владельца домена — без потолка на сырой ввод один
  // запрос любого пользователя нагрузил бы API квадратичной регуляркой.
  it('сверхдлинный сырой ввод отбивается потолком, а не регуляркой', () => {
    expect(refused('.'.repeat(100_000) + 'x')).toBe('too_long');
  });

  it('у отказа есть человеческий текст', () => {
    const r = normalizeDomain('1.2.3.4');
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.say).toMatch(/IP/);
  });

  // Инструкцию для регистратора сервис строит от СОХРАНЁННОГО домена, а не
  // повторной нормализацией: правила нормализатора могут ужесточиться, а
  // записи у привязанного домена обязаны остаться прежними.
  it('зона регистратора сохранённого домена — прямым разбором списка суффиксов', () => {
    expect(registrableZone('dmitryvolkov.ru')).toBe('dmitryvolkov.ru');
    expect(registrableZone('shop.dmitryvolkov.ru')).toBe('dmitryvolkov.ru');
    expect(registrableZone('firm.spb.ru')).toBe('firm.spb.ru'); // PRIVATE-зона FAITID, а не поддомен spb.ru
    expect(registrableZone('shop.site.co.uk')).toBe('site.co.uk');
    expect(registrableZone('xn--e1afmkfd.xn--p1ai')).toBe('xn--e1afmkfd.xn--p1ai');
  });

  it('относительное имя записи — от зоны регистратора', () => {
    expect(relativeName('dmitryvolkov.ru', 'dmitryvolkov.ru')).toBe('@');
    expect(relativeName('www.dmitryvolkov.ru', 'dmitryvolkov.ru')).toBe('www');
    expect(relativeName('_linkeon.shop.dmitryvolkov.ru', 'dmitryvolkov.ru')).toBe('_linkeon.shop');
  });

  // fqdn вне зоны раньше молча отдавал '' — тихая порча DNS-записи (запись
  // создалась бы с пустым/корневым именем не в той зоне). Теперь — исключение,
  // чтобы вызывающий код (Task 4) не мог создать запись не в той зоне молча.
  it('fqdn вне зоны — исключение, а не тихое пустое имя', () => {
    expect(() => relativeName('a.ru', 'b.ru')).toThrow();
    // 'ab.ru' оканчивается БУКВАМИ зоны 'b.ru', но не отделена точкой — это
    // не поддомен 'b.ru', а другой домен, которому просто не повезло с именем.
    expect(() => relativeName('ab.ru', 'b.ru')).toThrow();
  });
});

describe('контракт: любой ok-результат — валидная привязываемая форма', () => {
  // ~30 разнообразных входов, которые обязаны дать ok: регистры, схемы (в т.ч.
  // протокол-относительная и нестандартная), порты, путь/запрос/якорь, IDN
  // (кириллица, диакритика), www-корни, поддомены на разной глубине, co.uk и
  // spb.ru (суффикс из нескольких меток — ICANN и PRIVATE), уже готовый
  // punycode, цифровые и дефисные метки, глубина ровно на потолке меток.
  //
  // Для КАЖДОГО ok-результата держат остальные части фичи (Task 4 — запись
  // DNS/сертификата, Task 9 — поиск продукта ассистентом): форма domain
  // совпадает с ограничением БД product_domains_domain_form (миграция 008),
  // names[0] — это и есть domain, www — вторым элементом и только у корня, и
  // оба потолка (знаки, метки) держатся на КАЖДОМ имени, а не только на домене:
  // нормализатор проверяет их одним условием по names. Для знаков www у корня
  // закреплён тестом про *.ck выше (с одним доменом проверка бы его не
  // поймала). Для меток такого теста нет и сегодня быть не может: самое
  // глубокое правило в списке суффиксов tldts 7.4 — семь меток
  // (*.airflow.cn-northwest-1.on.amazonwebservices.com.cn), корень не глубже
  // восьми, его www — девяти, до потолка в 10 не дотянуть. Здесь потолок
  // меток — инвариант выдачи.
  const corpus = [
    'dmitryvolkov.ru', 'shop.dmitryvolkov.ru', 'www.dmitryvolkov.ru',
    'DMITRYVOLKOV.RU', 'https://dmitryvolkov.ru', 'http://dmitryvolkov.ru:8080/path',
    'ftp://dmitryvolkov.ru', 'dmitryvolkov.ru#section', 'dmitryvolkov.ru?x=1',
    'dmitryvolkov.ru.', '  dmitryvolkov.ru  ',
    'site.co.uk', 'shop.site.co.uk', 'site.spb.ru', 'firm.spb.ru',
    'xn--e1afmkfd.xn--p1ai', 'пример.рф', 'münchen.de', 'магазин.пример.рф',
    '123.ru', 'a1b2.ru', '3dprint.ru', 'shop-online.ru',
    'a.b.c.dmitryvolkov.ru', 'a.b.c.d.e.f.g.h.i.ru',
    'evil-linkeon.io', 'site.com', 'shop.example.com',
    'my-shop.spb.ru', 'sub.my-shop.spb.ru', 'localhost.ru',
    'shop.dmitryvolkov.ru:8443',
  ];

  it.each(corpus)('инварианты для %s', (raw) => {
    const r = normalizeDomain(raw);
    if (r.ok === false) throw new Error(`ждали ok для ${raw}, получили ${r.reason}: ${r.say}`);
    expect(r.domain).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/);
    expect(r.names[0]).toBe(r.domain);
    // Зона, от которой сервис считает записи для регистратора (по сохранённому
    // домену), — та же, что увидела нормализация.
    expect(registrableZone(r.domain)).toBe(r.zone);
    expect([1, 2]).toContain(r.names.length);
    if (r.names.length === 2) expect(r.names[1]).toBe(`www.${r.domain}`);
    for (const n of r.names) {
      expect(n.length).toBeLessThanOrEqual(MAX_NAME_LENGTH);
      expect(n.split('.').length).toBeLessThanOrEqual(MAX_LABELS);
    }
  });

  // www у НЕ-корня — буквальная метка поддомена, а не «www-псевдоним корня»:
  // срезать её значило бы привязать продукту www.shop.example.com вместо
  // shop.example.com, который попросил пользователь, — чужое доменное имя.
  it('www.<не-корень> не срезается: остаётся поддоменом, одно имя', () => {
    expect(ok('www.shop.example.com')).toMatchObject({
      domain: 'www.shop.example.com', apex: false, names: ['www.shop.example.com'],
    });
  });
});
