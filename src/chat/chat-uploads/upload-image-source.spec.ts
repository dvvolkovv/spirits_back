import { ChatUploadTooLargeError } from './chat-uploads.service';
import {
  ChatUploadSourceError, canonicalChatUploadUrl, chatUploadIdFromUrl, chatUploadSourceId, readChatUploadImage,
} from './upload-image-source';

const ID = '77777777-7777-4777-8777-777777777777';
const MB8 = 8 * 1024 * 1024;

const ENV_KEYS = ['BACKEND_URL', 'PUBLIC_BASE_URL', 'CHAT_UPLOADS_ENABLED'];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.BACKEND_URL = 'https://my.linkeon.io';
  delete process.env.PUBLIC_BASE_URL;
  process.env.CHAT_UPLOADS_ENABLED = 'true';
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k] as string;
  }
});

function fakeUploads(result: unknown) {
  return { findOwnedOriginal: jest.fn(async () => result as any) };
}

describe('chatUploadIdFromUrl', () => {
  it('относительный и абсолютный адрес нашего сайта, с подписью и без', () => {
    expect(chatUploadIdFromUrl(`/webhook/chat-uploads/${ID}`)).toBe(ID);
    expect(chatUploadIdFromUrl(`/webhook/chat-uploads/${ID}?exp=1&sig=ab`)).toBe(ID);
    expect(chatUploadIdFromUrl(`https://my.linkeon.io/webhook/chat-uploads/${ID}`)).toBe(ID);
    expect(chatUploadIdFromUrl(`https://my.linkeon.io/webhook/chat-uploads/${ID.toUpperCase()}?exp=1&sig=ab`)).toBe(ID);
  });

  it('свой origin — из BACKEND_URL: на test это test.linkeon.io', () => {
    process.env.BACKEND_URL = 'https://test.linkeon.io';
    expect(chatUploadIdFromUrl(`https://test.linkeon.io/webhook/chat-uploads/${ID}`)).toBe(ID);
  });

  it('чужой домен, //host, http, миниатюра, кривой id и прочие адреса — не загрузка', () => {
    expect(chatUploadIdFromUrl(`https://evil.example/webhook/chat-uploads/${ID}`)).toBeNull();
    expect(chatUploadIdFromUrl(`//evil.example/webhook/chat-uploads/${ID}`)).toBeNull();
    expect(chatUploadIdFromUrl(`http://my.linkeon.io/webhook/chat-uploads/${ID}`)).toBeNull();
    expect(chatUploadIdFromUrl(`/webhook/chat-uploads/${ID}/thumb`)).toBeNull();
    expect(chatUploadIdFromUrl('/webhook/chat-uploads/not-a-uuid')).toBeNull();
    expect(chatUploadIdFromUrl('https://my.linkeon.io/smm-media/linkeon-assets/images/a.png')).toBeNull();
    expect(chatUploadIdFromUrl('data:image/png;base64,AAAA')).toBeNull();
    expect(chatUploadIdFromUrl('')).toBeNull();
  });

  it('id — только форма UUID 8-4-4-4-12: 36 дефисов или сдвинутые группы не распознаются', () => {
    expect(chatUploadIdFromUrl(`/webhook/chat-uploads/${'-'.repeat(36)}`)).toBeNull();
    expect(chatUploadIdFromUrl('/webhook/chat-uploads/777777777-777-4777-8777-777777777777')).toBeNull();
    expect(chatUploadIdFromUrl('/webhook/chat-uploads/77777777777747778777777777777777----')).toBeNull();
    expect(chatUploadIdFromUrl('/webhook/chat-uploads/7777777g-7777-4777-8777-777777777777')).toBeNull();
    expect(chatUploadIdFromUrl(`/webhook/chat-uploads/${ID}/`)).toBe(ID);
  });
});

describe('chatUploadSourceId и canonicalChatUploadUrl', () => {
  it('флаг выключен — адрес загрузки не распознаётся, путь прежний', () => {
    process.env.CHAT_UPLOADS_ENABLED = 'false';
    expect(chatUploadSourceId(`/webhook/chat-uploads/${ID}`)).toBeNull();
    process.env.CHAT_UPLOADS_ENABLED = 'true';
    expect(chatUploadSourceId(`/webhook/chat-uploads/${ID}`)).toBe(ID);
  });

  it('канонический адрес — без подписи, на своём сайте', () => {
    expect(canonicalChatUploadUrl(ID)).toBe(`https://my.linkeon.io/webhook/chat-uploads/${ID}`);
  });
});

describe('readChatUploadImage', () => {
  it('своя картинка — base64 и mime без параметров; владелец и предел уходят в findOwnedOriginal', async () => {
    const uploads = fakeUploads({ record: { mime: 'image/PNG; charset=binary' }, body: Buffer.from('png-bytes') });
    await expect(readChatUploadImage(uploads, { url: `/webhook/chat-uploads/${ID}?exp=1&sig=ab`, userId: 'u-1', maxBytes: MB8 }))
      .resolves.toEqual({ b64: Buffer.from('png-bytes').toString('base64'), mime: 'image/png' });
    expect(uploads.findOwnedOriginal).toHaveBeenCalledWith({ id: ID, userId: 'u-1', maxBytes: MB8 });
  });

  it('не загрузка — null, реестр не спрашивается', async () => {
    const uploads = fakeUploads(null);
    await expect(readChatUploadImage(uploads, { url: 'https://images.example/cat.png', userId: 'u-1', maxBytes: MB8 })).resolves.toBeNull();
    expect(uploads.findOwnedOriginal).not.toHaveBeenCalled();
  });

  it('флаг выключен — null и для адреса загрузки', async () => {
    process.env.CHAT_UPLOADS_ENABLED = 'false';
    const uploads = fakeUploads(null);
    await expect(readChatUploadImage(uploads, { url: `/webhook/chat-uploads/${ID}`, userId: 'u-1', maxBytes: MB8 })).resolves.toBeNull();
    expect(uploads.findOwnedOriginal).not.toHaveBeenCalled();
  });

  it('чужая или удалённая — not_found', async () => {
    const err = await readChatUploadImage(fakeUploads(null), { url: `/webhook/chat-uploads/${ID}`, userId: 'u-2', maxBytes: MB8 }).catch((e) => e);
    expect(err).toBeInstanceOf(ChatUploadSourceError);
    expect(err.code).toBe('not_found');
    expect(err.message).toMatch(/не найдена/);
  });

  it('не картинка — not_image', async () => {
    const uploads = fakeUploads({ record: { mime: 'application/pdf' }, body: Buffer.from('%PDF') });
    const err = await readChatUploadImage(uploads, { url: `/webhook/chat-uploads/${ID}`, userId: 'u-1', maxBytes: MB8 }).catch((e) => e);
    expect(err).toBeInstanceOf(ChatUploadSourceError);
    expect(err.code).toBe('not_image');
    expect(err.message).toMatch(/не картинка/);
  });

  it('больше предела — too_large с пределом в МБ', async () => {
    const uploads = { findOwnedOriginal: jest.fn(async () => { throw new ChatUploadTooLargeError(9 * 1024 * 1024, MB8); }) };
    const err = await readChatUploadImage(uploads, { url: `/webhook/chat-uploads/${ID}`, userId: 'u-1', maxBytes: MB8 }).catch((e) => e);
    expect(err).toBeInstanceOf(ChatUploadSourceError);
    expect(err.code).toBe('too_large');
    expect(err.message).toMatch(/больше 8 МБ/);
  });

  it('сбой хранилища пробрасывается как есть', async () => {
    const boom = new Error('minio down');
    const uploads = { findOwnedOriginal: jest.fn(async () => { throw boom; }) };
    await expect(readChatUploadImage(uploads, { url: `/webhook/chat-uploads/${ID}`, userId: 'u-1', maxBytes: MB8 })).rejects.toBe(boom);
  });

  it('сервис загрузок не подключён — unavailable', async () => {
    const err = await readChatUploadImage(undefined, { url: `/webhook/chat-uploads/${ID}`, userId: 'u-1', maxBytes: MB8 }).catch((e) => e);
    expect(err).toBeInstanceOf(ChatUploadSourceError);
    expect(err.code).toBe('unavailable');
  });
});
