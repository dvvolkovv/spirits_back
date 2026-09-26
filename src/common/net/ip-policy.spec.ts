import { canonicalIp, ipInCidr, isBlockedAddress, parseCidr, parseIPv4, parseIPv6 } from './ip-policy';

/**
 * Классификация адресов для защиты от SSRF. Каждый диапазон проверяется с
 * обеих сторон границы: зелёный тест, в котором запрет «работает» только
 * потому, что запрещено вообще всё, ничего не доказывает.
 */
describe('ip-policy: IPv4', () => {
  it.each([
    '0.0.0.0', '0.255.255.255',
    '10.0.0.1', '10.10.0.3', '10.255.255.255',
    '100.64.0.1', '100.127.255.255',
    '127.0.0.1', '127.0.1.1', '127.255.255.254',
    '169.254.0.1', '169.254.169.254',
    '172.16.0.1', '172.17.0.1', '172.31.255.255',
    '192.0.0.1', '192.0.0.255',
    '192.0.2.1',
    '192.88.99.1',
    '192.168.0.1', '192.168.255.255',
    '198.18.0.1', '198.19.255.255',
    '198.51.100.7',
    '203.0.113.9',
    '224.0.0.1', '239.255.255.255',
    '240.0.0.1', '255.255.255.255',
  ])('%s — запрещён', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each([
    '8.8.8.8', '1.1.1.1', '212.113.106.202', '92.53.64.147', '5.101.115.184',
    '9.255.255.255', '11.0.0.0',
    '100.63.255.255', '100.128.0.0',
    '126.255.255.255', '128.0.0.0',
    '169.253.255.255', '169.255.0.0',
    '172.15.255.255', '172.32.0.0',
    '192.0.1.255', '192.0.3.0',
    '192.88.98.255', '192.88.100.0',
    '192.167.255.255', '192.169.0.0',
    '198.17.255.255', '198.20.0.0',
    '198.51.99.255', '198.51.101.0',
    '203.0.112.255', '203.0.114.0',
    '223.255.255.255',
  ])('%s — публичный', (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });

  it('разбирает только строгую dotted-quad запись', () => {
    expect(parseIPv4('127.0.0.1')).toBe(0x7f000001);
    expect(parseIPv4('255.255.255.255')).toBe(0xffffffff);
    expect(parseIPv4('127.1')).toBeNull();
    expect(parseIPv4('2130706433')).toBeNull();
    expect(parseIPv4('1.2.3.256')).toBeNull();
  });
});

describe('ip-policy: IPv6', () => {
  it.each([
    '::', '::1', '0:0:0:0:0:0:0:1', '[::1]',
    // IPv4-mapped — проверяется вшитый адрес
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:169.254.169.254', '::ffff:192.168.1.1',
    // IPv4-compatible (устаревшие) — весь ::/96
    '::127.0.0.1', '::7f00:1', '::8.8.8.8',
    // IPv4-translated
    '::ffff:0:7f00:1', '::ffff:0:808:808',
    // NAT64 с внутренним IPv4
    '64:ff9b::127.0.0.1', '64:ff9b::7f00:1', '64:ff9b::a00:1', '64:ff9b::a9fe:a9fe',
    // NAT64 local-use
    '64:ff9b:1::1',
    // ULA, link-local, site-local, multicast
    'fc00::1', 'fd12:3456:789a::1', 'fe80::1', 'fe80::1%eth0', 'febf::1', 'fec0::1', 'ff02::1', 'ff05::2',
    // документация, Teredo, ORCHID, discard
    '2001:db8::1', '3fff::1', '2001::1', '2001:0:4136:e378::1', '2001:10::1', '2001:20::1', '100::1',
    // 6to4 с внутренним IPv4
    '2002:7f00:1::1', '2002:a00:1::', '2002:a9fe:a9fe::1',
    // вне 2000::/3
    '1::1', '4000::1', 'e000::1',
  ])('%s — запрещён', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each([
    '2a00:1450:4001:82a::200e',
    '2606:4700:4700::1111',
    '2001:4860:4860::8888',
    '2a01:4f8:c0c:1234::1',
    '::ffff:8.8.8.8',
    '64:ff9b::808:808',
    '64:ff9b::8.8.8.8',
    '2002:808:808::1',
    '3fff:1000::1', // 3fff::/20 кончается на 3fff:0fff
  ])('%s — публичный', (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });

  it('разбирает сжатие, скобки, zone id и IPv4-хвост', () => {
    expect(parseIPv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIPv6('[2001:db8::1]')).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 1]);
    expect(parseIPv6('fe80::1%eth0')).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIPv6('::ffff:127.0.0.1')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
    expect(parseIPv6('1:2:3:4:5:6:7:8')).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(parseIPv6('1::2::3')).toBeNull();
    expect(parseIPv6('127.0.0.1')).toBeNull();
  });
});

describe('ip-policy: мусор и канонизация', () => {
  it.each(['', 'abc', '1.2.3', '999.1.1.1', 'localhost', '::g', '1.2.3.4/8'])('%j — запрещён (закрыто по умолчанию)', (s) => {
    expect(isBlockedAddress(s)).toBe(true);
  });

  it('канонизирует адреса для сравнения множеств', () => {
    expect(canonicalIp('::ffff:1.2.3.4')).toBe('1.2.3.4');
    expect(canonicalIp('::ffff:102:304')).toBe('1.2.3.4');
    expect(canonicalIp('2001:DB8::1')).toBe('2001:db8:0:0:0:0:0:1');
    expect(canonicalIp('8.8.8.8')).toBe('8.8.8.8');
    expect(canonicalIp('nope')).toBeNull();
  });

  it('CIDR: IPv4, IPv6 и одиночный адрес', () => {
    const v4 = parseCidr('92.53.64.0/24')!;
    expect(ipInCidr('92.53.64.147', v4)).toBe(true);
    expect(ipInCidr('::ffff:92.53.64.147', v4)).toBe(true);
    expect(ipInCidr('92.53.65.1', v4)).toBe(false);

    const one = parseCidr('5.101.115.184')!;
    expect(ipInCidr('5.101.115.184', one)).toBe(true);
    expect(ipInCidr('5.101.115.185', one)).toBe(false);

    const v6 = parseCidr('2a01:4f8::/32')!;
    expect(ipInCidr('2a01:4f8:1::1', v6)).toBe(true);
    expect(ipInCidr('2a01:4f9::1', v6)).toBe(false);
    expect(ipInCidr('8.8.8.8', v6)).toBe(false);

    expect(parseCidr('10.0.0.0/33')).toBeNull();
    expect(parseCidr('bogus/8')).toBeNull();
  });
});
