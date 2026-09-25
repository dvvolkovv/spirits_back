import { isIP } from 'net';
import { domainToASCII, domainToUnicode } from 'url';
import { parse } from 'tldts';

/**
 * Зона Линкеона. Всё под ней — адреса платформы (p.linkeon.io, c.linkeon.io),
 * и «своим доменом» быть не может: у продукта такой адрес уже есть.
 */
export const OUR_ZONE = 'linkeon.io';

/**
 * Потолок длины КАЖДОГО имени, включая www. Замерено 24.09.2026 на nginx 1.24
 * машин продуктов: при server_names_hash_bucket_size по умолчанию (64) имя от
 * 47 знаков роняет `nginx -t` ВСЕЙ машины. PHASE 4 ставит корзину 128 —
 * потолок 110 знаков; 100 оставляет запас. Та же граница — в product-vhost.
 */
export const MAX_NAME_LENGTH = 100;

/**
 * Потолок числа меток КАЖДОГО имени, включая www, — как maxLabels у Let's
 * Encrypt/Boulder: он проверяет каждое имя заявки на сертификат, а www у
 * корня — такое же имя заявки, на метку глубже самого домена. Сертификат на
 * имя глубже 10 меток не выпустится никогда, а такая глубина на практике —
 * почти всегда опечатка (лишняя точка, вставленный кусок пути), а не
 * настоящий домен.
 */
export const MAX_LABELS = 10;

/**
 * Потолок СЫРОГО ввода — до любых регулярок и до проверки владельца домена.
 * Замерено 24.09.2026: вход `'.'.repeat(N) + 'x'` на старой (квадратичной по
 * бэктрекингу) регулярке снятия точек — N=1e4 → 86 мс, 3e4 → 797 мс,
 * 1e5 → 8834 мс (из них 8724 мс — сама `.replace`). JSON-лимит бэка — 50 МБ,
 * а нормализатор зовётся ДО проверки владельца — без потолка один запрос
 * любого пользователя вешает API. Регулярка ниже исправлена на линейную по
 * бэктрекингу, но потолок держим отдельно и первой строкой: он режет вход
 * ДО того, как тот попадёт в любую другую регулярку файла, нынешнюю или
 * будущую.
 */
export const MAX_INPUT_LENGTH = 1024;

export type DomainRefusal =
  | 'empty'
  | 'ip'
  | 'no_dot'
  | 'bad_form'
  | 'our_zone'
  | 'too_long'
  | 'mixed_script'
  | 'unknown_tld';

export interface NormalizedDomain {
  /** Что привязываем: корень или поддомен, в punycode. */
  domain: string;
  /** Зона у регистратора (регистрируемый домен) — от неё считаются имена записей. */
  zone: string;
  /** Корень ли. Корень едет вместе с www. */
  apex: boolean;
  /** На какие имена выпускается сертификат. */
  names: string[];
}

export type NormalizeResult = ({ ok: true } & NormalizedDomain) | { ok: false; reason: DomainRefusal; say: string };

const SAY: Record<DomainRefusal, string> = {
  empty: 'Не указан домен.',
  ip: 'Это IP-адрес, а нужен домен — например, mysite.ru.',
  no_dot: 'Нужен домен целиком, вместе с зоной — например, mysite.ru.',
  bad_form: 'Это не похоже на домен. Пример правильного: mysite.ru.',
  our_zone: 'Это адрес Линкеона — он у продукта уже есть. Свой домен — тот, что вы купили у регистратора.',
  too_long: `Слишком длинный домен: имя (у корня — вместе с www) должно укладываться в ${MAX_NAME_LENGTH} знаков и ${MAX_LABELS} частей.`,
  mixed_script: 'В домене смешаны русские и латинские буквы — похоже, сбилась раскладка клавиатуры. Проверьте написание.',
  unknown_tld: 'Такой доменной зоны нет — проверьте окончание домена (например, .ru, .com, .рф).',
};

const refuse = (reason: DomainRefusal): NormalizeResult => ({ ok: false, reason, say: SAY[reason] });

/** Метка DNS: латиница, цифры, дефис внутри, до 63 знаков. */
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/**
 * Ввод человека → домен, который можно привязать.
 *
 * Корень отличается от поддомена ТОЛЬКО по списку публичных суффиксов
 * (`tldts`): «две метки» ошиблись бы на site.co.uk (корень, три метки) и на
 * shop.site.ru (поддомен). Ошибка здесь стоила бы сертификата: корень без www
 * или поддомен с несуществующим www.
 */
export function normalizeDomain(raw: unknown): NormalizeResult {
  const input = String(raw ?? '');
  if (input.length > MAX_INPUT_LENGTH) return refuse('too_long');

  let s = input.trim();
  if (!s) return refuse('empty');

  // toLowerCase() здесь не нужен и вреден. UTS46 внутри domainToASCII
  // применяет свёртку регистра (case folding — по таблице отображений IDNA),
  // а toLowerCase() — это приведение к нижнему регистру (lowercase mapping,
  // правила JS). Операции разные и расходятся не на экзотике: заглавная ẞ при
  // приведении к нижнему регистру становится ß, а при свёртке — ss. Поэтому
  // 'STRAẞE.de' с нашим lower даёт xn--strae-oqa.de (ß доезжает до punycode),
  // а без lower — как в браузере и в Node — 'strasse.de'. Регистронезависимость
  // шагов до domainToASCII не страдает: isIP к регистру безразличен, схема —
  // через /i.
  s = s.replace(/^(?:[a-z][a-z0-9+.-]*:)?\/\//i, ''); // схема (в т.ч. протокол-относительная //)
  s = s.split(/[/?#]/)[0]; // путь, запрос, якорь

  // IPv6 — до снятия порта: двоеточия у него внутри адреса.
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(s);
  if (bracketed && isIP(bracketed[1])) return refuse('ip');
  if (isIP(s)) return refuse('ip');

  s = s.replace(/:\d+$/, '');
  // Снятие точек на конце: (?<!\.) разрешает начать совпадение только с
  // ПЕРВОЙ точки хвоста, а не с любой из них по очереди — иначе на входе
  // вида '.'.repeat(N) движок перебирает откат на каждой из N позиций
  // квадратично (см. MAX_INPUT_LENGTH выше). Семантика та же: снимается тот
  // же самый хвостовой набор точек, просто за один заход, а не за N.
  s = s.replace(/(?<!\.)\.+$/, '');
  if (!s) return refuse('empty');
  if (isIP(s)) return refuse('ip');

  const ascii = domainToASCII(s);
  if (!ascii) return refuse(s.includes('.') ? 'bad_form' : 'no_dot');
  if (!ascii.includes('.')) return refuse('no_dot');

  const labels = ascii.split('.');
  if (!labels.every((label) => LABEL.test(label))) return refuse('bad_form');

  // R-LDH (RFC 5891 §4.2.3.1): дефис в 3-й и 4-й позиции метки зарезервирован
  // под ACE-префикс xn--. Let's Encrypt/Boulder такие имена отбивает
  // (errInvalidRLDH) — заявка на сертификат для них не пройдёт НИКОГДА,
  // поэтому отбиваем сразу, а не после потерянного шага DNS-проверки.
  if (labels.some((l) => l.slice(2, 4) === '--' && !l.startsWith('xn--'))) return refuse('bad_form');

  // Число меток здесь не считается — только в конце, по КАЖДОМУ имени
  // (см. MAX_LABELS): у корня www на метку глубже самого домена.
  if (ascii.length > 253) return refuse('too_long');

  // Дальше — по человекочитаемой (юникодной) форме меток. Пунктуация/символы
  // и смешение кириллицы с латиницей внутри одной метки успешно кодируются
  // punycode'ом и проходят все проверки выше (ACE-строка синтаксически
  // валидна), но домена с такими метками не бывает в реальности: либо
  // опечатка/автозамена (типографское тире, «умная» кавычка), либо съехавшая
  // раскладка клавиатуры (кириллическая «о» вместо латинской).
  const ulabels = domainToUnicode(ascii).split('.');
  if (ulabels.some((l) => /[\p{P}\p{S}]/u.test(l.replace(/-/g, '')))) return refuse('bad_form');
  if (ulabels.some((l) => /\p{Script=Latin}/u.test(l) && /\p{Script=Cyrillic}/u.test(l))) return refuse('mixed_script');

  if (ascii === OUR_ZONE || ascii.endsWith(`.${OUR_ZONE}`)) return refuse('our_zone');

  // Регистрационные зоны FAITID (spb.ru, msk.ru, com.ru и другие) лежат в
  // PRIVATE-разделе публичного списка суффиксов, а не в ICANN-разделе; tldts
  // по умолчанию PRIVATE не читает (allowPrivateDomains: false). Без опции
  // firm.spb.ru считался бы поддоменом ЧУЖОЙ зоны spb.ru, а не корнем СВОЕЙ:
  // CNAME оказался бы на корне СОБСТВЕННОЙ зоны пользователя (firm.spb.ru) —
  // там, где у регистратора уже сидят SOA/NS и CNAME с ними не уживается, —
  // а relativeName() считала бы имя записи от чужой spb.ru ('firm' вместо
  // '@' в зоне firm.spb.ru), да ещё и не выдался бы www. Побочный эффект
  // опции: приватные суффиксы вида github.io тоже становятся границей зоны —
  // безвредно, DNS там пользователь всё равно не настраивает.
  const info = parse(ascii, { allowPrivateDomains: true });
  if (info.isIp) return refuse('ip');
  if (!info.domain || !info.publicSuffix || !info.domainWithoutSuffix) return refuse('bad_form');

  // Зона обязана быть РЕАЛЬНОЙ (ICANN или PRIVATE), а не угаданной как
  // «последняя метка — наверное суффикс»: это поведение tldts по умолчанию
  // для нераспознанной зоны (правило '*' в основании списка суффиксов),
  // иначе dmitryvolkov.ruu или dmitryvolkov.rf проходили бы как валидный
  // домен — сертификат на них не выпустится никогда.
  if (!info.isIcann && !info.isPrivate) return refuse('unknown_tld');

  let domain = ascii;
  if (domain.startsWith('www.') && domain.slice(4) === info.domain) domain = info.domain;
  const apex = domain === info.domain;
  const names = apex ? [domain, `www.${domain}`] : [domain];
  // Оба потолка — на каждом имени, а не на вводе: сертификат и конфиг nginx
  // получают именно names, и www у корня длиннее домена на 4 знака и глубже
  // на одну метку.
  if (names.some((n) => n.length > MAX_NAME_LENGTH || n.split('.').length > MAX_LABELS)) return refuse('too_long');
  return { ok: true, domain, zone: info.domain, apex, names };
}

/**
 * Зона регистратора для УЖЕ сохранённого домена — прямым разбором списка
 * суффиксов (тем же, что в normalizeDomain), без повторной нормализации: её
 * правила могут ужесточиться, а инструкция у привязанного домена должна
 * остаться прежней.
 */
export function registrableZone(domain: string): string {
  return parse(domain, { allowPrivateDomains: true }).domain ?? domain;
}

/**
 * Домен для глаз человека: `пример.рф`, а не `xn--e1afmkfd.xn--p1ai`. ОДНА
 * функция на все показы — тексты DomainsService и custom_domain_unicode в
 * выборке продуктов: две копии уже расходились (одна падала на ASCII, другая
 * отдавала пустую строку). Битый punycode (`xn--zz.ru`) форму 008 проходит —
 * это ASCII, — а domainToUnicode на нём отдаёт '', поэтому запасной ответ —
 * сам ASCII: пустая строка в карточке — это продукт без адреса.
 */
export function readableDomain(domain: string): string {
  return domainToUnicode(domain) || domain;
}

/** Имя записи так, как его вводят в панели регистратора: относительно зоны. */
export function relativeName(fqdn: string, zone: string): string {
  if (fqdn === zone) return '@';
  if (!fqdn.endsWith(`.${zone}`)) throw new Error(`${fqdn} вне зоны ${zone}`);
  return fqdn.slice(0, -(zone.length + 1));
}
