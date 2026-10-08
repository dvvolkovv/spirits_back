// src/chat/chat-files/chat-file-store.spec.ts
import axios from 'axios';
import { ChatFileStore, PERSIST_FILE_TIMEOUT_MS, PERSIST_MAX_FILE_BYTES } from './chat-file-store';

jest.mock('axios');
const get = axios.get as jest.Mock;

const RELAY = 'https://r.linkeon.io/files/u1_12_ru';

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

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.MINIO_BUCKET_CHAT_FILES;
});

describe('ChatFileStore.persist', () => {
  it('копирует файл релея в бакет и отдаёт наш адрес', async () => {
    get.mockResolvedValue({ data: Buffer.from('%PDF') });
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
    expect(get).toHaveBeenCalledWith(
      `${RELAY}/report.pdf`,
      expect.objectContaining({
        responseType: 'arraybuffer',
        timeout: PERSIST_FILE_TIMEOUT_MS,
        maxContentLength: PERSIST_MAX_FILE_BYTES,
      }),
    );
  });

  it('кириллица с пробелом: ключ сырой, адрес и запрос к релею закодированы', async () => {
    get.mockResolvedValue({ data: Buffer.from('x') });
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

  it('html уходит октет-потоком, svg — картинкой', async () => {
    get.mockResolvedValue({ data: Buffer.from('x') });
    const { store, uploads } = makeStore();

    await store.persist([`${RELAY}/page.html`, `${RELAY}/logo.svg`]);

    const byName = (n: string) => uploads.find((u) => u.key.endsWith(`/${n}`));
    expect(byName('page.html').contentType).toBe('application/octet-stream');
    expect(byName('logo.svg').contentType).toBe('image/svg+xml');
    expect(byName('page.html').contentDisposition.startsWith('attachment;')).toBe(true);
  });

  it('404 и сетевой сбой — файла нет в карте, остальные скопированы', async () => {
    get.mockImplementation(async (url: string) => {
      if (url.endsWith('/gone.pdf')) throw Object.assign(new Error('Request failed with status code 404'), { response: { status: 404 } });
      if (url.endsWith('/net.pdf')) throw new Error('socket hang up');
      return { data: Buffer.from('ok') };
    });
    const { store } = makeStore();

    const map = await store.persist([`${RELAY}/gone.pdf`, `${RELAY}/net.pdf`, `${RELAY}/ok.pdf`]);

    expect([...map.keys()]).toEqual([`${RELAY}/ok.pdf`]);
  });

  it('сбой MinIO — файла нет в карте', async () => {
    get.mockResolvedValue({ data: Buffer.from('x') });
    const { store } = makeStore(async () => {
      throw new Error('S3 down');
    });

    const map = await store.persist([`${RELAY}/a.pdf`]);

    expect(map.size).toBe(0);
  });

  it('один адрес дважды — одна загрузка', async () => {
    get.mockResolvedValue({ data: Buffer.from('x') });
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
      return { data: Buffer.from('x') };
    });
    const { store } = makeStore();

    const map = await store.persist(Array.from({ length: 8 }, (_, i) => `${RELAY}/f${i}.txt`));

    expect(map.size).toBe(8);
    expect(peak).toBe(3);
  });

  it('бюджет вышел — новые скачивания не начинаются', async () => {
    get.mockResolvedValue({ data: Buffer.from('x') });
    const { store } = makeStore();

    const map = await store.persist([`${RELAY}/a.txt`], { budgetMs: 0 });

    expect(map.size).toBe(0);
    expect(get).not.toHaveBeenCalled();
  });

  it('бакет берётся из MINIO_BUCKET_CHAT_FILES', async () => {
    process.env.MINIO_BUCKET_CHAT_FILES = 'other-bucket';
    get.mockResolvedValue({ data: Buffer.from('x') });
    const { store, uploads } = makeStore();

    await store.persist([`${RELAY}/a.txt`]);

    expect(uploads[0].bucket).toBe('other-bucket');
  });
});
