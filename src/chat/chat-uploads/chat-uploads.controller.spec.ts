import 'reflect-metadata';
import * as http from 'http';
import { createHmac } from 'crypto';
import { PassThrough, Readable } from 'stream';
import { INestApplication, Module, NotFoundException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ChatUploadsController } from './chat-uploads.controller';
import { ChatUploadsService } from './chat-uploads.service';
import { JwtService } from '../../common/services/jwt.service';
import { contentDispositionFor } from '../chat-files/file-meta';

/**
 * Приватное скачивание исходников. HTTP-прогон по образцу
 * agent-versions.http.spec.ts (supertest в репозитории не используется):
 * приложение поднимается тем же способом, что и main.ts, — с глобальным
 * префиксом `webhook`.
 *
 * Мок openDownload ведёт себя как настоящий сервис: владелец ИЛИ валидная
 * короткоживущая подпись, иначе NotFoundException. Всё остальное (404 без
 * раскрытия существования, проверка HMAC) уже покрыто
 * chat-uploads.service.spec.ts — здесь сторожится HTTP-слой: маршрутный
 * адрес, разбор Bearer, проброс exp/sig и заголовки ответа.
 */

const RECORD_ID = '11111111-1111-4111-8111-111111111111';
const SECRET = 'spec-secret';
const BYTES = 'private-bytes';
// Имя с кириллицей, пробелом и скобкой: contentDispositionFor кодирует его
// сам, и тест сверяет заголовок с той же функцией — самописная кодировка в
// контроллере здесь не пройдёт.
const NAME = 'Отчёт 1).pdf';

const signature = (id: string, exp: number): string =>
  createHmac('sha256', SECRET).update(`chat-upload:v1:${id}:${exp}`).digest('hex');

function fakeOpenDownload(input: { id: string; userId?: string; exp?: string; sig?: string }) {
  const owner = input.userId === 'u1';
  const exp = Number(input.exp);
  const assistant =
    input.exp !== undefined &&
    input.sig !== undefined &&
    /^\d+$/.test(String(input.exp)) &&
    exp >= Math.floor(Date.now() / 1000) &&
    input.sig === signature(input.id, exp);
  if (!owner && !assistant) {
    return Promise.reject(new NotFoundException('Upload not found'));
  }
  return Promise.resolve({
    body: Readable.from([Buffer.from(BYTES)]),
    originalName: NAME,
    mime: 'application/pdf',
    sizeBytes: Buffer.byteLength(BYTES),
  });
}

function get(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { agent: false, headers }, (res) => {
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
  });
}

describe('ChatUploadsController (HTTP)', () => {
  let app: INestApplication;
  let base: string;
  let jwtService: JwtService;
  let savedSecret: string | undefined;
  const openDownload = jest.fn(fakeOpenDownload);

  beforeAll(async () => {
    savedSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = SECRET;

    @Module({
      controllers: [ChatUploadsController],
      providers: [{ provide: ChatUploadsService, useValue: { openDownload } }, JwtService],
    })
    class TestModule {}

    app = await NestFactory.create(TestModule, { logger: false, bodyParser: false });
    // Тот же префикс, что в main.ts: маршрут обязан быть /webhook/chat-uploads/:id.
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

  beforeEach(() => openDownload.mockClear());

  it('JWT владельца скачивает, чужой JWT и неверная подпись — 404', async () => {
    const owner = jwtService.signAccess('u1');
    const other = jwtService.signAccess('u2');
    expect((await get(base, { authorization: `Bearer ${owner}` })).status).toBe(200);
    expect((await get(base, { authorization: `Bearer ${other}` })).status).toBe(404);
    expect((await get(`${base}?exp=1&sig=bad`)).status).toBe(404);
  });

  it('ответ владельцу: приватные заголовки, disposition из file-meta и байты', async () => {
    const res = await get(base, { authorization: `Bearer ${jwtService.signAccess('u1')}` });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-length']).toBe(String(Buffer.byteLength(BYTES)));
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-disposition']).toBe(contentDispositionFor(NAME));
    expect(res.body).toBe(BYTES);
    expect(openDownload).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: RECORD_ID, userId: 'u1' }),
    );
  });

  it('невалидный Bearer — анонимный запрос (404), а не 500', async () => {
    // verifyAccess бросает на мусоре: контроллер обязан считать такой запрос
    // анонимным и отдать решение подписи, а не ронять ответ.
    expect((await get(base, { authorization: 'Bearer not-a-jwt' })).status).toBe(404);
  });

  it('подпись ассистента без JWT открывает файл, exp/sig доходят до сервиса', async () => {
    const exp = Math.floor(Date.now() / 1000) + 600;
    const sig = signature(RECORD_ID, exp);
    const res = await get(`${base}?exp=${exp}&sig=${sig}`);
    expect(res.status).toBe(200);
    expect(openDownload).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: RECORD_ID, exp: String(exp), sig }),
    );
  });
});

describe('ChatUploadsController (ошибка потока)', () => {
  it('сбой стрима уничтожает ответ и не оставляет процесс висеть', async () => {
    const body = new Readable({
      read() {
        this.destroy(new Error('minio gone'));
      },
    });
    const svc = {
      openDownload: jest.fn(async () => ({
        body,
        originalName: 'a.pdf',
        mime: 'application/pdf',
        sizeBytes: 1,
      })),
    };
    const ctrl = new ChatUploadsController(svc as any, { verifyAccess: jest.fn() } as any);
    const res: any = new PassThrough();
    res.setHeader = jest.fn();
    const destroy = jest.fn();
    res.destroy = destroy;

    await ctrl.download(RECORD_ID, { headers: {}, query: {} } as any, res);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(destroy).toHaveBeenCalled();
  });
});
