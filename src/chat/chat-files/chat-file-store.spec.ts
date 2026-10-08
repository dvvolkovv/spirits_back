// src/chat/chat-files/chat-file-store.spec.ts
import { safeGet } from '../../common/net/safe-fetch';
import { ChatFileStore, PERSIST_FILE_TIMEOUT_MS, PERSIST_MAX_FILE_BYTES } from './chat-file-store';

jest.mock('../../common/net/safe-fetch', () => ({
  ...jest.requireActual('../../common/net/safe-fetch'),
  safeGet: jest.fn(),
}));

const get = safeGet as unknown as jest.Mock;

const RELAY = 'https://r.linkeon.io/files/u1_12_ru';

/** Ответ safeGet: тело — Buffer, как при responseType 'arraybuffer'. */
function ok(body: string | Buffer) {
  return { status: 200, headers: {}, data: typeof body === 'string' ? Buffer.from(body) : body, finalUrl: '' };
}

function makeStore(upload?: (input: any) => Promise<string>) {
  const uploads: any[] = [];
  const storage = {
    upload: jest.fn(async (input: any) => {
      uploads.push(input);
      return upload ? upload(input) : 'ignored';
    }),
    publicUrl: jest.fn((bucket: string, key: string) => `https://pub/${bucket}/${key}`),
  };
  return { store: new ChatFileStore(storage as any), uploads };
}

/** Внешний срок для обещания: тест падает внятно, а не по таймауту jest. */
async function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`persist не вернулся за ${ms} мс`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Загрузка в бакет, которая висит, пока её не оборвут сигналом. */
function hangUntilAborted(input: any): Promise<string> {
  return new Promise((_, reject) => {
    const signal: AbortSignal | undefined = input.abortSignal;
    signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
  });
}

const savedAgentUrl = process.env.AGENT_URL;

beforeEach(() => {
  jest.clearAllMocks();
  get.mockReset();
  delete process.env.MINIO_BUCKET_CHAT_FILES;
  delete process.env.AGENT_URL;
});

afterAll(() => {
  if (savedAgentUrl === undefined) delete process.env.AGENT_URL;
  else process.env.AGENT_URL = savedAgentUrl;
});

describe('ChatFileStore.persist', () => {
  it('копирует файл релея в бакет и отдаёт наш адрес', async () => {
    get.mockResolvedValue(ok('%PDF'));
    const { store, uploads } = makeStore();

    const map = await store.persist([`${RELAY}/report.pdf`]);

    expect(uploads).toHaveLength(1);
    const u = uploads[0];
    expect(u.bucket).toBe('linkeon-chat-files');
    // В ключе нет ни телефона, ни userId — только случайный uuid и имя.
    expect(u.key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/report\.pdf$/);
    expect(Buffer.from(u.body).toString()).toBe('%PDF');
    expect(u.contentType).toBe('application/pdf');
    expect(u.contentDisposition).toBe(`attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`);
    expect(u.cacheControl).toBe('public, max-age=31536000, immutable');

    const id = u.key.split('/')[0];
    expect(map.get(`${RELAY}/report.pdf`)).toBe(`https://pub/linkeon-chat-files/${id}/report.pdf`);
    expect(get.mock.calls[0][0]).toBe(`${RELAY}/report.pdf`);
  });

  it('кириллица с пробелом: ключ сырой, адрес и запрос к релею закодированы', async () => {
    get.mockResolvedValue(ok('x'));
    const { store, uploads } = makeStore();
    const relayUrl = `${RELAY}/Договор аренды.docx`;

    const map = await store.persist([relayUrl]);

    expect(uploads[0].key.endsWith('/Договор аренды.docx')).toBe(true);
    expect(map.get(relayUrl)).toMatch(
      /\/%D0%94%D0%BE%D0%B3%D0%BE%D0%B2%D0%BE%D1%80%20%D0%B0%D1%80%D0%B5%D0%BD%D0%B4%D1%8B\.docx$/,
    );
    expect(get.mock.calls[0][0]).toBe(
      `${RELAY}/%D0%94%D0%BE%D0%B3%D0%BE%D0%B2%D0%BE%D1%80%20%D0%B0%D1%80%D0%B5%D0%BD%D0%B4%D1%8B.docx`,
    );
  });

  it('скобки в имени кодируются в адресе: markdown-ссылка на него не рвётся', async () => {
    get.mockResolvedValue(ok('x'));
    const { store, uploads } = makeStore();
    const relayUrl = `${RELAY}/Договор (1).docx`;

    const map = await store.persist([relayUrl]);

    // Ключ в MinIO — по-прежнему сырое имя.
    expect(uploads[0].key.endsWith('/Договор (1).docx')).toBe(true);
    expect(map.get(relayUrl)).toMatch(/\/%D0%94%D0%BE%D0%B3%D0%BE%D0%B2%D0%BE%D1%80%20%281%29\.docx$/);
  });

  it('непарная скобка «1) План.docx» — в адресе ни одной сырой скобки', async () => {
    get.mockResolvedValue(ok('x'));
    const { store, uploads } = makeStore();
    const relayUrl = `${RELAY}/1) План.docx`;

    const map = await store.persist([relayUrl]);

    expect(uploads[0].key.endsWith('/1) План.docx')).toBe(true);
    expect(map.get(relayUrl)).toMatch(/^https:\/\/pub\/linkeon-chat-files\//);
    expect(map.get(relayUrl)).not.toMatch(/[()]/);
  });

  it('html уходит октет-потоком, svg — картинкой', async () => {
    get.mockResolvedValue(ok('x'));
    const { store, uploads } = makeStore();

    await store.persist([`${RELAY}/page.html`, `${RELAY}/logo.svg`]);

    const byName = (n: string) => uploads.find((u) => u.key.endsWith(`/${n}`));
    expect(byName('page.html').contentType).toBe('application/octet-stream');
    expect(byName('logo.svg').contentType).toBe('image/svg+xml');
    expect(byName('page.html').contentDisposition.startsWith('attachment;')).toBe(true);
  });

  it('404 и сетевой сбой — файла нет в карте, остальные скопированы', async () => {
    get.mockImplementation(async (url: string) => {
      if (url.endsWith('/gone.pdf')) throw Object.assign(new Error('сервер ответил кодом 404'), { response: { status: 404 } });
      if (url.endsWith('/net.pdf')) throw new Error('socket hang up');
      return ok('ok');
    });
    const { store } = makeStore();

    const map = await store.persist([`${RELAY}/gone.pdf`, `${RELAY}/net.pdf`, `${RELAY}/ok.pdf`]);

    expect([...map.keys()]).toEqual([`${RELAY}/ok.pdf`]);
  });

  it('сбой MinIO — файла нет в карте', async () => {
    get.mockResolvedValue(ok('x'));
    const { store } = makeStore(async () => {
      throw new Error('S3 down');
    });

    const map = await store.persist([`${RELAY}/a.pdf`]);

    expect(map.size).toBe(0);
  });

  it('один адрес дважды — одна загрузка', async () => {
    get.mockResolvedValue(ok('x'));
    const { store, uploads } = makeStore();

    const map = await store.persist([`${RELAY}/a.pdf`, `${RELAY}/a.pdf`]);

    expect(uploads).toHaveLength(1);
    expect(map.size).toBe(1);
  });

  it('не больше трёх скачиваний одновременно', async () => {
    let inFlight = 0;
    let peak = 0;
    get.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setImmediate(r));
      inFlight--;
      return ok('x');
    });
    const { store } = makeStore();

    const map = await store.persist(Array.from({ length: 8 }, (_, i) => `${RELAY}/f${i}.txt`));

    expect(map.size).toBe(8);
    expect(peak).toBe(3);
  });

  it('бюджет вышел — новые скачивания не начинаются', async () => {
    get.mockResolvedValue(ok('x'));
    const { store } = makeStore();

    const map = await store.persist([`${RELAY}/a.txt`], { budgetMs: 0 });

    expect(map.size).toBe(0);
    expect(get).not.toHaveBeenCalled();
  });

  it('бакет берётся из MINIO_BUCKET_CHAT_FILES', async () => {
    process.env.MINIO_BUCKET_CHAT_FILES = 'other-bucket';
    get.mockResolvedValue(ok('x'));
    const { store, uploads } = makeStore();

    await store.persist([`${RELAY}/a.txt`]);

    expect(uploads[0].bucket).toBe('other-bucket');
  });
});

describe('ChatFileStore: жёсткие сроки', () => {
  it('качает через safeGet: без редиректов, с потолком размера, срок не больше срока на файл', async () => {
    get.mockResolvedValue(ok('x'));
    const { store } = makeStore();

    await store.persist([`${RELAY}/a.pdf`]);
    await store.persist([`${RELAY}/b.pdf`], { fileTimeoutMs: 1234 });

    const opts = get.mock.calls[0][1];
    expect(opts).toEqual(
      expect.objectContaining({ responseType: 'arraybuffer', maxRedirects: 0, maxBytes: PERSIST_MAX_FILE_BYTES }),
    );
    expect(opts.timeoutMs).toBeGreaterThan(0);
    expect(opts.timeoutMs).toBeLessThanOrEqual(PERSIST_FILE_TIMEOUT_MS);
    expect(get.mock.calls[1][1].timeoutMs).toBeGreaterThan(0);
    expect(get.mock.calls[1][1].timeoutMs).toBeLessThanOrEqual(1234);
  });

  it('срок скачивания не больше остатка бюджета хода', async () => {
    get.mockResolvedValue(ok('x'));
    const { store } = makeStore();

    await store.persist([`${RELAY}/a.pdf`], { budgetMs: 500 });

    const { timeoutMs } = get.mock.calls[0][1];
    expect(timeoutMs).toBeGreaterThan(0);
    expect(timeoutMs).toBeLessThanOrEqual(500);
  });

  it('тело уходит в бакет как есть, без копии', async () => {
    const body = Buffer.from('%PDF');
    get.mockResolvedValue(ok(body));
    const { store, uploads } = makeStore();

    await store.persist([`${RELAY}/a.pdf`]);

    expect(uploads[0].body).toBe(body);
  });

  it('загрузка в бакет повисла — persist возвращается по бюджету, файла в карте нет', async () => {
    get.mockResolvedValue(ok('x'));
    const { store, uploads } = makeStore(hangUntilAborted);
    const t0 = Date.now();

    const map = await within(store.persist([`${RELAY}/a.pdf`], { budgetMs: 200 }), 2000);

    expect(Date.now() - t0).toBeLessThan(1000);
    expect(map.size).toBe(0);
    expect(uploads).toHaveLength(1);
    expect(uploads[0].abortSignal.aborted).toBe(true);
  });

  it('загрузка в бакет не дольше срока на файл, даже при длинном бюджете', async () => {
    get.mockResolvedValue(ok('x'));
    const { store } = makeStore(hangUntilAborted);
    const t0 = Date.now();

    const map = await within(store.persist([`${RELAY}/a.pdf`], { budgetMs: 10_000, fileTimeoutMs: 150 }), 2000);

    expect(Date.now() - t0).toBeLessThan(1000);
    expect(map.size).toBe(0);
  });

  it('скачивание повисло вопреки своему сроку — persist всё равно возвращается по бюджету', async () => {
    get.mockImplementation(() => new Promise(() => {}));
    const { store, uploads } = makeStore();
    const t0 = Date.now();

    const map = await within(store.persist([`${RELAY}/a.pdf`], { budgetMs: 200 }), 2000);

    expect(Date.now() - t0).toBeLessThan(1000);
    expect(map.size).toBe(0);
    expect(uploads).toHaveLength(0);
  });

  it('скачивание закончилось после бюджета — в бакет не кладём, в карту не добавляем', async () => {
    let release: (v: unknown) => void = () => {};
    get.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const { store, uploads } = makeStore();

    const map = await within(store.persist([`${RELAY}/a.pdf`], { budgetMs: 100 }), 2000);
    release(ok('late'));
    await new Promise((r) => setTimeout(r, 50));

    expect(uploads).toHaveLength(0);
    expect(map.size).toBe(0);
  });
});

describe('ChatFileStore: бюджет и сроки больше предела таймера Node', () => {
  /** Скачивание идёт ~30 мс: досрочный обрыв по таймеру будет виден. */
  const slowGet = async () => {
    await new Promise((r) => setTimeout(r, 30));
    return ok('x');
  };

  it('бюджет Infinity (так зовёт перенос): копирует всё, срок скачивания — срок на файл', async () => {
    get.mockImplementation(slowGet);
    const { store } = makeStore();

    const map = await within(store.persist([`${RELAY}/a.pdf`, `${RELAY}/b.pdf`], { budgetMs: Infinity }), 2000);

    expect(map.size).toBe(2);
    expect(get.mock.calls[0][1].timeoutMs).toBe(PERSIST_FILE_TIMEOUT_MS);
  });

  it('бюджет и срок на файл больше 2^31-1 мс — таймеры не срабатывают через 1 мс', async () => {
    get.mockImplementation(slowGet);
    const { store, uploads } = makeStore(async (input) => {
      await new Promise((r) => setTimeout(r, 30));
      if (input.abortSignal.aborted) throw new Error('загрузку оборвали');
      return 'ok';
    });

    const map = await within(store.persist([`${RELAY}/a.pdf`], { budgetMs: 2 ** 31, fileTimeoutMs: 2 ** 31 }), 2000);

    expect(map.size).toBe(1);
    expect(uploads).toHaveLength(1);
    expect(get.mock.calls[0][1].timeoutMs).toBeLessThanOrEqual(2 ** 31 - 1);
  });

  it('срок на файл Infinity или дробный — загрузка в бакет не падает', async () => {
    get.mockResolvedValue(ok('x'));
    const { store } = makeStore();

    const map = await store.persist([`${RELAY}/a.pdf`, `${RELAY}/b.pdf`], { fileTimeoutMs: Infinity });
    const map2 = await store.persist([`${RELAY}/c.pdf`], { fileTimeoutMs: 1234.5 });

    expect(map.size).toBe(2);
    expect(map2.size).toBe(1);
  });
});

describe('ChatFileStore: копируем только /files/ нашего релея', () => {
  it.each([
    ['чужой хост', 'https://evil.example/files/k/a.pdf'],
    ['хост-двойник', 'https://r.linkeon.io.evil.example/files/k/a.pdf'],
    ['другая схема', 'http://r.linkeon.io/files/k/a.pdf'],
    ['не /files/', 'https://r.linkeon.io/session/k/files'],
    ['адрес папки', 'https://r.linkeon.io/files/k/'],
    ['«..» в пути', 'https://r.linkeon.io/files/k/../../etc/passwd'],
    ['закодированные «..»', 'https://r.linkeon.io/files/k/%2e%2e/%2E%2E/secret'],
    ['«.» в пути', 'https://r.linkeon.io/files/./k/a.pdf'],
    ['закодированный «/» внутри сегмента', 'https://r.linkeon.io/files/k/..%2F..%2Fsecret'],
    ['закодированный «\\» внутри сегмента', 'https://r.linkeon.io/files/k/..%5C..%5Csecret'],
    ['«\\» внутри сегмента', 'https://r.linkeon.io/files/k/..\\..\\secret'],
  ])('%s — отказ без скачивания: %s', async (_why, url) => {
    get.mockResolvedValue(ok('x'));
    const { store, uploads } = makeStore();

    await expect(store.persistOne(url)).rejects.toThrow();
    const map = await store.persist([url]);

    expect(map.size).toBe(0);
    expect(get).not.toHaveBeenCalled();
    expect(uploads).toHaveLength(0);
  });

  it('релей — из AGENT_URL, а не зашитый r.linkeon.io', async () => {
    process.env.AGENT_URL = 'https://relay.example/';
    get.mockResolvedValue(ok('x'));
    const { store } = makeStore();

    const map = await store.persist(['https://relay.example/files/k/a.pdf', `${RELAY}/b.pdf`]);

    expect([...map.keys()]).toEqual(['https://relay.example/files/k/a.pdf']);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('AGENT_URL с заглавными буквами и портом 443 — тот же релей', async () => {
    process.env.AGENT_URL = 'https://R.LINKEON.IO:443/';
    get.mockResolvedValue(ok('x'));
    const { store } = makeStore();

    const map = await store.persist([`${RELAY}/a.pdf`, 'https://evil.example/files/k/b.pdf']);

    expect([...map.keys()]).toEqual([`${RELAY}/a.pdf`]);
  });
});

describe('ChatFileStore: «#», «?» и уже закодированное в имени', () => {
  it('«Задача #3.docx»: # — часть имени, в запросе и в нашем адресе — %23', async () => {
    get.mockResolvedValue(ok('x'));
    const { store, uploads } = makeStore();
    const relayUrl = `${RELAY}/Задача #3.docx`;

    const map = await store.persist([relayUrl]);

    expect(get.mock.calls[0][0]).toBe(`${RELAY}/%D0%97%D0%B0%D0%B4%D0%B0%D1%87%D0%B0%20%233.docx`);
    expect(uploads[0].key.endsWith('/Задача #3.docx')).toBe(true);
    expect(map.get(relayUrl)).toMatch(/\/%D0%97%D0%B0%D0%B4%D0%B0%D1%87%D0%B0%20%233\.docx$/);
  });

  it('«a?b.pdf»: ? — часть имени, а не начало запроса', async () => {
    get.mockResolvedValue(ok('x'));
    const { store, uploads } = makeStore();

    await store.persist([`${RELAY}/a?b.pdf`]);

    expect(get.mock.calls[0][0]).toBe(`${RELAY}/a%3Fb.pdf`);
    expect(uploads[0].key.endsWith('/a?b.pdf')).toBe(true);
  });

  it('закодированное %2C в запросе не становится %252C', async () => {
    get.mockResolvedValue(ok('x'));
    const { store } = makeStore();

    await store.persist([`${RELAY}/a%2Cb.pdf`]);

    expect(get.mock.calls[0][0]).toBe(`${RELAY}/a%2Cb.pdf`);
  });

  it('подпапка: путь в запросе сохраняется, имя — последний сегмент', async () => {
    get.mockResolvedValue(ok('x'));
    const { store, uploads } = makeStore();

    await store.persist([`${RELAY}/sub/x.pdf`]);

    expect(get.mock.calls[0][0]).toBe(`${RELAY}/sub/x.pdf`);
    expect(uploads[0].key).toMatch(/^[0-9a-f-]{36}\/x\.pdf$/);
  });
});
