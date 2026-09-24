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

/** Резолвер-заглушка: этот метод падает с заданным кодом независимо от имени. */
function failWith(code: string): () => Promise<never> {
  return () => Promise.reject(Object.assign(new Error(code), { code }));
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
    expect(r.records.find((x) => x.type === 'A' && x.name === 'www.dmitryvolkov.ru')).toMatchObject({
      ok: false, error: 'ESERVFAIL', current: [],
    });
  });

  it('таймаут на AAAA — не ok и не «записей нет», а названная ошибка', async () => {
    const resolver: DnsResolver = { ...fake(READY), resolve6: failWith('ETIMEOUT') };
    const r = await checkDns(INPUT, resolver);
    expect(r.ok).toBe(false);
    const aaaaRecords = r.records.filter((x) => x.type === 'AAAA');
    expect(aaaaRecords).toHaveLength(2);
    for (const rec of aaaaRecords) {
      expect(rec).toMatchObject({ ok: false, error: 'ETIMEOUT', current: [] });
    }
  });

  it('TXT отсутствует как NXDOMAIN — «нет записи», а не ошибка', async () => {
    const resolver: DnsResolver = { ...fake(READY), resolveTxt: failWith('ENOTFOUND') };
    const r = await checkDns(INPUT, resolver);
    expect(r.records[0]).toMatchObject({ type: 'TXT', ok: false, error: null, current: [] });
  });

  it('TXT в кавычках у регистратора — ok', async () => {
    const r = await checkDns(INPUT, fake({ ...READY, [`${TXT_LABEL}.dmitryvolkov.ru`]: { TXT: [['"lk-abc"']] } }));
    expect(r.ok).toBe(true);
  });

  it('TXT с пробелами по краям — ok', async () => {
    const r = await checkDns(INPUT, fake({ ...READY, [`${TXT_LABEL}.dmitryvolkov.ru`]: { TXT: [[' lk-abc ']] } }));
    expect(r.ok).toBe(true);
  });

  it('TXT в верхнем регистре — ok', async () => {
    const r = await checkDns(INPUT, fake({ ...READY, [`${TXT_LABEL}.dmitryvolkov.ru`]: { TXT: [['LK-ABC']] } }));
    expect(r.ok).toBe(true);
  });

  it('10 TXT-записей — current обрезан до 5', async () => {
    const ten = Array.from({ length: 10 }, (_, i) => [`v${i}`]);
    const r = await checkDns(INPUT, fake({ ...READY, [`${TXT_LABEL}.dmitryvolkov.ru`]: { TXT: ten } }));
    expect(r.records[0].current).toHaveLength(5);
  });

  it('TXT на 500 знаков — current обрезан до 100', async () => {
    const long = 'a'.repeat(500);
    const r = await checkDns(INPUT, fake({ ...READY, [`${TXT_LABEL}.dmitryvolkov.ru`]: { TXT: [[long]] } }));
    expect(r.records[0].current[0]).toHaveLength(100);
  });

  it('TXT с непечатным мусором — current только печатный ASCII', async () => {
    const dirty = 'ok\x00\x1b[31mрусский😀text';
    const r = await checkDns(INPUT, fake({ ...READY, [`${TXT_LABEL}.dmitryvolkov.ru`]: { TXT: [[dirty]] } }));
    expect(r.records[0].current[0]).toBe('ok[31mtext');
  });

  it('поддомен — только своё имя', async () => {
    const r = await checkDns(
      { domain: 'shop.x.ru', names: ['shop.x.ru'], token: 't', hostIp: IP },
      fake({ [`${TXT_LABEL}.shop.x.ru`]: { TXT: [['t']] }, 'shop.x.ru': { A: [IP] } }),
    );
    expect(r.ok).toBe(true);
    expect(r.records).toHaveLength(3);
  });

  it('пустой names — программная ошибка вызывающего', async () => {
    await expect(checkDns({ domain: 'x.ru', names: [], token: 't', hostIp: IP }, fake({}))).rejects.toThrow();
  });
});
