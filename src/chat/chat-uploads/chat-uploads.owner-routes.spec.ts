import 'reflect-metadata';
import * as http from 'http';
import { createHmac } from 'crypto';
import { Readable } from 'stream';
import { INestApplication, Module, NotFoundException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { JwtService } from '../../common/services/jwt.service';
import { ChatUploadsController } from './chat-uploads.controller';
import { ChatUploadDeleteError, ChatUploadsService } from './chat-uploads.service';

/**
 * Маршруты только для владельца: GET /webhook/chat-uploads/:id/thumb и
 * DELETE /webhook/chat-uploads/:id (спека 2026-11-16-chat-uploads-media-notes).
 * HTTP-прогон по образцу chat-uploads.controller.spec.ts: приложение с тем же
 * глобальным префиксом `webhook`, что в main.ts.
 *
 * Моки сервиса ведут себя как настоящий: владелец — u1, остальным
 * NotFoundException. Здесь сторожится HTTP-слой: разбор Bearer, отказ подписи
 * ассистента ДО вызова сервиса, коды 200/204/404/502 и заголовки миниатюры.
 */

const RECORD_ID = '44444444-4444-4444-8444-444444444444';
const SECRET = 'spec-secret';
const THUMB_BYTES = 'webp-thumb-bytes';

const signature = (id: string, exp: number): string =>
  createHmac('sha256', SECRET).update(`chat-upload:v1:${id}:${exp}`).digest('hex');

function send(
  method: 'GET' | 'DELETE',
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, agent: false, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () =>
        resolve({
          status: res.statusCode || 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

describe('ChatUploadsController: миниатюра и удаление (HTTP)', () => {
  let app: INestApplication;
  let base: string;
  let jwtService: JwtService;
  let savedSecret: string | undefined;

  const openThumb = jest.fn(async (input: { id: string; userId: string }) => {
    if (input.userId !== 'u1') throw new NotFoundException('Upload not found');
    return {
      body: Readable.from([Buffer.from(THUMB_BYTES)]),
      originalName: 'Гостиная.jpg',
      mime: 'image/webp',
      sizeBytes: Buffer.byteLength(THUMB_BYTES),
    };
  });
  const deleteForOwner = jest.fn(async (input: { id: string; userId: string }): Promise<void> => {
    if (input.userId !== 'u1') throw new NotFoundException('Upload not found');
  });
  // Маршруты thumb/DELETE не должны попадать в скачивание исходника.
  const openDownload = jest.fn(async () => {
    throw new Error('openDownload не должен вызываться маршрутами thumb и DELETE');
  });

  const bearer = (userId: string) => ({ authorization: `Bearer ${jwtService.signAccess(userId)}` });
  const assistantQuery = (): string => {
    const exp = Math.floor(Date.now() / 1000) + 600;
    return `exp=${exp}&sig=${signature(RECORD_ID, exp)}`;
  };

  beforeAll(async () => {
    savedSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = SECRET;

    @Module({
      controllers: [ChatUploadsController],
      providers: [
        { provide: ChatUploadsService, useValue: { openThumb, deleteForOwner, openDownload } },
        JwtService,
      ],
    })
    class TestModule {}

    app = await NestFactory.create(TestModule, { logger: false, bodyParser: false });
    app.setGlobalPrefix('webhook');
    await app.listen(0, '127.0.0.1');
    base = `${await app.getUrl()}/webhook/chat-uploads/${RECORD_ID}`;
    jwtService = app.get(JwtService);
  });

  afterAll(async () => {
    await app?.close();
    if (savedSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = savedSecret;
  });

  beforeEach(() => {
    openThumb.mockClear();
    deleteForOwner.mockClear();
    openDownload.mockClear();
  });

  describe('GET :id/thumb', () => {
    it('владелец по JWT: 200 image/webp, inline, private no-store, nosniff, байты миниатюры', async () => {
      const res = await send('GET', `${base}/thumb`, bearer('u1'));

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('image/webp');
      expect(res.headers['content-length']).toBe(String(Buffer.byteLength(THUMB_BYTES)));
      expect(res.headers['content-disposition']).toBe('inline');
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.body).toBe(THUMB_BYTES);
      expect(openThumb).toHaveBeenCalledWith({ id: RECORD_ID, userId: 'u1' });
      expect(openDownload).not.toHaveBeenCalled();
    });

    it('чужой JWT (или нет миниатюры — сервис бросает NotFound) — 404', async () => {
      expect((await send('GET', `${base}/thumb`, bearer('u2'))).status).toBe(404);
      expect(openThumb).toHaveBeenCalledWith({ id: RECORD_ID, userId: 'u2' });
    });

    it('подпись ассистента (exp/sig) без JWT — 401, сервис не вызывается', async () => {
      expect((await send('GET', `${base}/thumb?${assistantQuery()}`)).status).toBe(401);
      expect(openThumb).not.toHaveBeenCalled();
    });

    it('refresh-токен и мусор в Bearer — 401, сервис не вызывается', async () => {
      const refresh = { authorization: `Bearer ${jwtService.signRefresh('u1')}` };
      expect((await send('GET', `${base}/thumb`, refresh)).status).toBe(401);
      expect((await send('GET', `${base}/thumb`, { authorization: 'Bearer not-a-jwt' })).status).toBe(401);
      expect(openThumb).not.toHaveBeenCalled();
    });
  });

  describe('DELETE :id', () => {
    it('владелец по JWT: 204 без тела, в сервис уходят id и userId из токена', async () => {
      const res = await send('DELETE', base, bearer('u1'));

      expect(res.status).toBe(204);
      expect(res.body).toBe('');
      expect(deleteForOwner).toHaveBeenCalledWith({ id: RECORD_ID, userId: 'u1' });
      expect(openDownload).not.toHaveBeenCalled();
    });

    it('чужой JWT или несуществующий id — 404', async () => {
      expect((await send('DELETE', base, bearer('u2'))).status).toBe(404);
    });

    it('подпись ассистента удалению не помогает: без JWT — 401, сервис не вызывается', async () => {
      expect((await send('DELETE', `${base}?${assistantQuery()}`)).status).toBe(401);
      expect((await send('DELETE', base)).status).toBe(401);
      expect(deleteForOwner).not.toHaveBeenCalled();
    });

    it('ChatUploadDeleteError (MinIO не подтвердил удаление) — 502', async () => {
      deleteForOwner.mockRejectedValueOnce(new ChatUploadDeleteError());
      expect((await send('DELETE', base, bearer('u1'))).status).toBe(502);
    });

    it('прочая ошибка сервиса — 500, а не 502', async () => {
      deleteForOwner.mockRejectedValueOnce(new Error('db down'));
      expect((await send('DELETE', base, bearer('u1'))).status).toBe(500);
    });
  });
});
