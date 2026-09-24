import { checkDns, DnsResolver, TXT_LABEL } from './domain-dns';

type Zone = Record<string, { A?: string[]; AAAA?: string[]; TXT?: string[][]; fail?: string }>;

function fake(zone: Zone): DnsResolver {
  const pick = (name: string, key: 'A' | 'AAAA' | 'TXT') => {
    const r = zone[name];
    if (r?.fail) return Promise.reject(Object.assign(new Error(r.fail), { code: r.fail }));
    const v = r?.[key];
    if (!v) return Promise.reject(Object.assign(new Error('ENODATA'), { code: 'ENODATA' }));
    return Promise.resolve(v as any);
  };
  return {
    resolve4: (n) => pick(n, 'A'),
    resolve6: (n) => pick(n, 'AAAA'),
    resolveTxt: (n) => pick(n, 'TXT'),
  };
}

const IP = '139.59.210.42';
const INPUT = { domain: 'dmitryvolkov.ru', names: ['dmitryvolkov.ru', 'www.dmitryvolkov.ru'], token: 'lk-abc', hostIp: IP };
const READY: Zone = {
  [`${TXT_LABEL}.dmitryvolkov.ru`]: { TXT: [['lk-abc']] },
  'dmitryvolkov.ru': { A: [IP] },
  'www.dmitryvolkov.ru': { A: [IP] },
};

describe('проверка DNS своего домена', () => {
  it('всё на месте — ok', async () => {
    const r = await checkDns(INPUT, fake(READY));
    expect(r.ok).toBe(true);
    expect(r.records.map((x) => `${x.type} ${x.name}`)).toEqual([
      'TXT _linkeon.dmitryvolkov.ru',
      'A dmitryvolkov.ru', 'AAAA dmitryvolkov.ru',
      'A www.dmitryvolkov.ru', 'AAAA www.dmitryvolkov.ru',
    ]);
  });

  it('чужой TXT — не ok, и видно, что там сейчас', async () => {
    const r = await checkDns(INPUT, fake({ ...READY, [`${TXT_LABEL}.dmitryvolkov.ru`]: { TXT: [['lk-other']] } }));
    expect(r.ok).toBe(false);
    expect(r.records[0]).toMatchObject({ type: 'TXT', ok: false, current: ['lk-other'], want: 'lk-abc' });
  });

  it('TXT, разрезанный на куски, склеивается', async () => {
    const r = await checkDns(INPUT, fake({ ...READY, [`${TXT_LABEL}.dmitryvolkov.ru`]: { TXT: [['lk-', 'abc']] } }));
    expect(r.ok).toBe(true);
  });

  // Одна чужая A из нескольких — половина посетителей и проверка Let's Encrypt
  // уходят на старый хостинг.
  it('одна чужая A из нескольких — не ok', async () => {
    const r = await checkDns(INPUT, fake({ ...READY, 'dmitryvolkov.ru': { A: [IP, '90.156.201.49'] } }));
    expect(r.ok).toBe(false);
    expect(r.records.find((x) => x.type === 'A' && x.name === 'dmitryvolkov.ru')).toMatchObject({
      ok: false, current: [IP, '90.156.201.49'], want: IP,
    });
  });

  it('A нет вовсе — не ok', async () => {
    const r = await checkDns(INPUT, fake({ ...READY, 'www.dmitryvolkov.ru': {} }));
    expect(r.ok).toBe(false);
  });

  // У машин продуктов нет IPv6, а Let's Encrypt предпочитает IPv6.
  it('оставшаяся AAAA — не ok', async () => {
    const r = await checkDns(INPUT, fake({ ...READY, 'dmitryvolkov.ru': { A: [IP], AAAA: ['2a00:15f8::1'] } }));
    expect(r.ok).toBe(false);
    expect(r.records.find((x) => x.type === 'AAAA' && x.name === 'dmitryvolkov.ru')).toMatchObject({
      ok: false, current: ['2a00:15f8::1'],
    });
  });

  it('сбой резолвера — не ok и не «записи нет», а названная ошибка', async () => {
    const r = await checkDns(INPUT, fake({ ...READY, 'www.dmitryvolkov.ru': { fail: 'ESERVFAIL' } }));
    expect(r.ok).toBe(false);
    expect(r.records.find((x) => x.type === 'A' && x.name === 'www.dmitryvolkov.ru')?.current[0]).toMatch(/ESERVFAIL/);
  });

  it('поддомен — только своё имя', async () => {
    const r = await checkDns(
      { domain: 'shop.x.ru', names: ['shop.x.ru'], token: 't', hostIp: IP },
      fake({ [`${TXT_LABEL}.shop.x.ru`]: { TXT: [['t']] }, 'shop.x.ru': { A: [IP] } }),
    );
    expect(r.ok).toBe(true);
    expect(r.records).toHaveLength(3);
  });
});
