/**
 * Командная строка product-vhost и проверка имён домена.
 *
 * Имя домена приезжает с сервера и уезжает в argv скрипта, который пишет из
 * него конфиг nginx. Шелла в цепочке нет (execFile), но скрипт сам кладёт
 * имя в `server_name` — и мусор там роняет `nginx -t` ВСЕЙ машины, то есть
 * все продукты всех клиентов перестают перечитываться. Поэтому проверка своя,
 * хотя сервер имя уже нормализовал: сервер и агент выкатываются порознь.
 */
import { MAX_DOMAIN_LENGTH, assertDomainName, vhostArgv } from './vhost';

describe('vhostArgv', () => {
  it('без имён — ровно прежняя форма, и для прокси, и для заглушки', () => {
    expect(vhostArgv('product-vhost', 'shop', 8001)).toEqual(['product-vhost', 'shop', '8001']);
    expect(vhostArgv('product-vhost', 'shop', '--asleep')).toEqual(['product-vhost', 'shop', '--asleep']);
    expect(vhostArgv('product-vhost', 'shop', 8001, [])).toEqual(['product-vhost', 'shop', '8001']);
  });

  it('имена уезжают парами --domain <имя> после цели, в порядке прихода', () => {
    expect(vhostArgv('product-vhost', 'shop', 8001, ['a.ru', 'www.a.ru'])).toEqual([
      'product-vhost', 'shop', '8001', '--domain', 'a.ru', '--domain', 'www.a.ru',
    ]);
    expect(vhostArgv('/usr/local/bin/product-vhost', 'shop', '--asleep', ['a.ru'])).toEqual([
      '/usr/local/bin/product-vhost', 'shop', '--asleep', '--domain', 'a.ru',
    ]);
  });

  it('мусорное имя — отказ всей командной строки, а не пропуск имени', () => {
    // Пропуск молча выпустил бы конфиг без домена, за который человек платил
    // попыткой выпуска, — и ровно с тем же зелёным отчётом.
    expect(() => vhostArgv('product-vhost', 'shop', 8001, ['a.ru', 'a.ru; rm -rf /'])).toThrow(/имя домена/);
  });
});

describe('assertDomainName', () => {
  it.each([
    '', 'a', 'a..b.ru', '-a.ru', 'a-.ru', 'a.ru;', 'a ru', 'A.RU', 'a.ru/x', '.a.ru', 'a.ru.',
  ])('отвергает %j', (name) => {
    expect(() => assertDomainName(name)).toThrow(/имя домена не годится/);
  });

  it('не строка — тоже отказ, а не TypeError из регекспа', () => {
    expect(() => assertDomainName(undefined as unknown as string)).toThrow(/имя домена не годится/);
    expect(() => assertDomainName(42 as unknown as string)).toThrow(/имя домена не годится/);
  });

  it('обычные имена, www и punycode проходят', () => {
    for (const name of ['a.ru', 'www.a.ru', 'shop-1.example.co.uk', 'xn--e1afmkfd.xn--p1ai']) {
      expect(() => assertDomainName(name)).not.toThrow();
    }
  });

  it('граница длины — ровно 100 знаков проходит, 101 нет', () => {
    const exact = `${'a'.repeat(48)}.${'b'.repeat(48)}.ru`;
    expect(exact).toHaveLength(MAX_DOMAIN_LENGTH);
    expect(() => assertDomainName(exact)).not.toThrow();
    expect(() => assertDomainName(`a${exact}`)).toThrow(/имя домена не годится/);
  });

  it('метка длиннее 63 знаков — отказ, хотя имя в целом короче потолка', () => {
    expect(() => assertDomainName(`${'a'.repeat(64)}.ru`)).toThrow(/имя домена не годится/);
    expect(() => assertDomainName(`${'a'.repeat(63)}.ru`)).not.toThrow();
  });
});
