import * as fs from 'fs';
import * as path from 'path';
import { ChatThumbController } from './chat-thumb.controller';

function mockRes() {
  const res: any = { headers: {} as Record<string, string> };
  res.status = jest.fn((c: number) => { res._status = c; return res; });
  res.json = jest.fn((b: any) => { res._body = b; return res; });
  res.setHeader = jest.fn((k: string, v: string) => { res.headers[k] = v; });
  res.redirect = jest.fn((c: number, u: string) => { res._status = c; res._location = u; return res; });
  return res;
}
const storage = { publicUrl: (b: string, k: string) => `https://pub/${b}/${k}` };

describe('GET /webhook/chat/thumb', () => {
  it('неправильный src — 400, миниатюру не делает', async () => {
    const thumbs = { resolve: jest.fn() };
    const res = mockRes();
    await new ChatThumbController(thumbs as any, storage as any).thumb('linkeon-smm-videos/a.jpg', res);
    expect(res._status).toBe(400);
    expect(thumbs.resolve).not.toHaveBeenCalled();
  });

  it('миниатюра готова — 302 на неё, кеш на сутки', async () => {
    const thumbs = { resolve: jest.fn(async () => 'https://pub/linkeon-assets/thumbs/x.webp') };
    const res = mockRes();
    await new ChatThumbController(thumbs as any, storage as any).thumb('linkeon-assets/images/a.jpg', res);
    expect(res._status).toBe(302);
    expect(res._location).toBe('https://pub/linkeon-assets/thumbs/x.webp');
    expect(res.headers['Cache-Control']).toBe('public, max-age=86400');
  });

  it('сбой — 302 на оригинал с закодированным ключом и без кеша', async () => {
    const thumbs = { resolve: jest.fn(async () => { throw new Error('исходника нет'); }) };
    const res = mockRes();
    await new ChatThumbController(thumbs as any, storage as any).thumb('linkeon-chat-files/u/кот (1).png', res);
    expect(res._status).toBe(302);
    expect(res._location).toBe('https://pub/linkeon-chat-files/u/%D0%BA%D0%BE%D1%82%20%281%29.png');
    expect(res.headers['Cache-Control']).toBe('no-store');
  });

  it('ручка открыта без входа: на ней нет JwtGuard', () => {
    const src = fs.readFileSync(path.join(__dirname, 'chat-thumb.controller.ts'), 'utf8');
    expect(src).not.toContain('UseGuards');
  });

  it('контроллер и сервис зарегистрированы в ChatModule', () => {
    const mod = fs.readFileSync(path.join(__dirname, '..', 'chat.module.ts'), 'utf8');
    expect(mod).toMatch(/controllers: \[[^\]]*ChatThumbController/);
    expect(mod).toMatch(/providers: \[[^\]]*ThumbnailService/);
  });
});
