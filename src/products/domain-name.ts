import { isIP } from 'net';
import { domainToASCII } from 'url';
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

export type DomainRefusal = 'empty' | 'ip' | 'no_dot' | 'bad_form' | 'our_zone' | 'too_long';

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
  too_long: `Слишком длинный домен: вместе с www имя должно укладываться в ${MAX_NAME_LENGTH} знаков.`,
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
  let s = String(raw ?? '').trim().toLowerCase();
  if (!s) return refuse('empty');

  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // схема
  s = s.split(/[/?#]/)[0]; // путь, запрос, якорь

  // IPv6 — до снятия порта: двоеточия у него внутри адреса.
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(s);
  if (bracketed && isIP(bracketed[1])) return refuse('ip');
  if (isIP(s)) return refuse('ip');

  s = s.replace(/:\d+$/, '').replace(/\.+$/, '');
  if (!s) return refuse('empty');
  if (isIP(s)) return refuse('ip');

  const ascii = domainToASCII(s);
  if (!ascii) return refuse(s.includes('.') ? 'bad_form' : 'no_dot');
  if (!ascii.includes('.')) return refuse('no_dot');
  if (ascii.length > 253 || !ascii.split('.').every((label) => LABEL.test(label))) return refuse('bad_form');

  if (ascii === OUR_ZONE || ascii.endsWith(`.${OUR_ZONE}`)) return refuse('our_zone');
  // Регистрационные зоны FAITID (spb.ru, msk.ru, com.ru и другие) лежат в
  // PRIVATE-разделе публичного списка суффиксов, а не в ICANN-разделе; tldts
  // по умолчанию PRIVATE не читает (allowPrivateDomains: false). Без опции
  // firm.spb.ru считался бы поддоменом зоны spb.ru: получил бы CNAME на
  // корне ЧУЖОЙ настоящей зоны (запрещено стандартом) и не получил бы www.
  // Побочный эффект: приватные суффиксы вида github.io тоже становятся
  // границей зоны — безвредно, DNS там пользователь всё равно не настраивает.
  const info = parse(ascii, { allowPrivateDomains: true });
  if (info.isIp) return refuse('ip');
  if (!info.domain || !info.publicSuffix || !info.domainWithoutSuffix) return refuse('bad_form');

  let domain = ascii;
  if (domain.startsWith('www.') && domain.slice(4) === info.domain) domain = info.domain;
  const apex = domain === info.domain;
  const names = apex ? [domain, `www.${domain}`] : [domain];
  if (names.some((n) => n.length > MAX_NAME_LENGTH)) return refuse('too_long');
  return { ok: true, domain, zone: info.domain, apex, names };
}

/** Имя записи так, как его вводят в панели регистратора: относительно зоны. */
export function relativeName(fqdn: string, zone: string): string {
  return fqdn === zone ? '@' : fqdn.slice(0, -(zone.length + 1));
}
