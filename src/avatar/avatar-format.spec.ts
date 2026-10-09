import { AvatarService, sniffAvatarFormat } from './avatar.service';
import { AvatarController } from './avatar.controller';

/**
 * Тип аватарки раньше брался со слов клиента: Content-Type запроса или
 * mimetype из multipart уходил в MinIO как есть. Так в linkeon-assets можно
 * было положить text/html или SVG со скриптом под видом аватарки, а мобильное
 * приложение, которое шлёт файл без типа, хранило аватарки как
 * application/octet-stream — и GET /avatar их не отдавал. Теперь тип
 * определяется по первым байтам файла.
 */

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const GIF = Buffer.from('GIF89a\x01\x00', 'latin1');
const HTML = Buffer.from('<!doctype html><script>alert(1)</script>');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

function makeService() {
  const storage = { upload: jest.fn(async (o: any) => `https://minio.test/${o.bucket}/${o.key}`) };
  const pg = { query: jest.fn(async () => ({ rows: [] })) };
  return { svc: new AvatarService(pg as any, storage as any), storage, pg };
}

function makeRes() {
  return {
    statusCode: 200,
    body: null as any,
    status(c: number) { this.statusCode = c; return this; },
    json(o: any) { this.body = o; return this; },
  };
}

describe('sniffAvatarFormat', () => {
  it.each([
    ['jpeg', JPEG, 'image/jpeg', 'jpg'],
    ['png', PNG, 'image/png', 'png'],
    ['webp', WEBP, 'image/webp', 'webp'],
    ['gif', GIF, 'image/gif', 'gif'],
  ])('%s узнаётся по байтам', (_n, buf, contentType, ext) => {
    expect(sniffAvatarFormat(buf)).toEqual({ contentType, ext });
  });

  it.each([
    ['html', HTML],
    ['svg', SVG],
    ['пустой файл', Buffer.alloc(0)],
    ['обрезанный jpeg', JPEG.subarray(0, 2)],
  ])('%s — не аватарка', (_n, buf) => {
    expect(sniffAvatarFormat(buf)).toBeNull();
  });
});

describe('AvatarService.uploadAvatar', () => {
  it('тип берёт из байтов, а не из слов клиента', async () => {
    const { svc, storage } = makeService();
    await svc.uploadAvatar('u-1', JPEG);
    expect(storage.upload).toHaveBeenCalledWith(expect.objectContaining({
      key: 'avatars/users/u-1.jpg', contentType: 'image/jpeg',
    }));
  });

  it('html под видом картинки в хранилище не попадает', async () => {
    const { svc, storage, pg } = makeService();
    await expect(svc.uploadAvatar('u-1', HTML)).rejects.toThrow(/jpeg, png, webp, gif/i);
    expect(storage.upload).not.toHaveBeenCalled();
    expect(pg.query).not.toHaveBeenCalled();
  });
});

describe('AvatarController.uploadAvatar', () => {
  it('svg с заголовком image/svg+xml — 400, а не 500', async () => {
    const { svc, storage } = makeService();
    const ctrl = new AvatarController(svc);
    const res = makeRes();
    await ctrl.uploadAvatar({ userId: 'u-1' }, { headers: { 'content-type': 'image/svg+xml' }, body: SVG } as any, res as any);
    expect(res.statusCode).toBe(400);
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('jpeg с заголовком image/png сохраняется как jpeg', async () => {
    const { svc, storage } = makeService();
    const ctrl = new AvatarController(svc);
    const res = makeRes();
    await ctrl.uploadAvatar({ userId: 'u-1' }, { headers: { 'content-type': 'image/png' }, body: JPEG } as any, res as any);
    expect(res.statusCode).toBe(200);
    expect(storage.upload).toHaveBeenCalledWith(expect.objectContaining({ contentType: 'image/jpeg' }));
  });
});
