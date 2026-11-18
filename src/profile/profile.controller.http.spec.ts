import 'reflect-metadata';
import * as http from 'http';
import { INestApplication, Module, ServiceUnavailableException, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  AccountDeletionLifecycle,
  EXPLICIT_DELETION_UNAVAILABLE,
} from '../account-deletion/account-deletion.lifecycle';
import { JwtService } from '../common/services/jwt.service';
import { PgService } from '../common/services/pg.service';
import { ProfileController } from './profile.controller';
import { ProfileService } from './profile.service';

/**
 * T18-M3 — транспортный pin явного удаления: DELETE /webhook/profile.
 *
 * Приложение поднимается так же, как в main.ts (глобальный префикс webhook,
 * ValidationPipe), HTTP — настоящим запросом по образцу
 * chat-uploads.controller.spec.ts / agent-versions.http.spec.ts (supertest в
 * репозитории не используется). Настоящие: ProfileController, ProfileService,
 * JwtGuard + JwtService. Подменены: AccountDeletionLifecycle (вся работа
 * удаления — его, покрыт profile-deletion.lifecycle.pg.spec.ts) и PgService
 * (гвард читает isadmin, сервис катит свою миграцию при старте).
 *
 * Контроллер отвечает через @Res(): если lifecycle бросает, ответ ещё не
 * отправлен, и статус ставит штатный exception-filter Nest. Тест закрепляет,
 * что «повторите позже» доходит до клиента честным 503 с фиксированным
 * безопасным телом, а не превращается в 200 {success:true} или 500.
 */

const SECRET = 'profile-http-spec-secret';
const USER = '79990000631';

interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  body: any;
}

function request(method: string, url: string, headers: Record<string, string> = {}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, agent: false, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (text += chunk));
      res.on('error', reject);
      res.on('end', () => {
        // Не-JSON тело — понятное падение теста, а не исключение в обработчике
        // 'end' (промис не завершился бы, тест висел бы до таймаута).
        let body: any = null;
        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          reject(new Error(
            `non-JSON response ${res.statusCode} ${res.headers['content-type'] ?? ''}: ${text.slice(0, 200)}`,
          ));
          return;
        }
        resolve({ status: res.statusCode || 0, headers: res.headers, text, body });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('DELETE /webhook/profile (HTTP, T18-M3)', () => {
  let app: INestApplication;
  let url: string;
  let token: string;
  let savedSecret: string | undefined;
  const deleteExplicit = jest.fn<Promise<void>, [string]>();
  const pgQuery = jest.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [], rowCount: 0 }));

  beforeAll(async () => {
    savedSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = SECRET;

    @Module({
      controllers: [ProfileController],
      providers: [
        ProfileService,
        JwtService,
        { provide: PgService, useValue: { query: pgQuery } },
        { provide: AccountDeletionLifecycle, useValue: { deleteExplicit } },
      ],
    })
    class TestModule {}

    app = await NestFactory.create(TestModule, { logger: false });
    // Как в main.ts: маршрут обязан быть /webhook/profile.
    app.setGlobalPrefix('webhook');
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: false }));
    await app.listen(0, '127.0.0.1');
    url = `${await app.getUrl()}/webhook/profile`;
    token = app.get(JwtService).signAccess(USER);
  });

  afterAll(async () => {
    await app?.close();
    if (savedSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = savedSecret;
  });

  beforeEach(() => {
    deleteExplicit.mockReset();
  });

  it('успешное удаление — 200 {success:true}, lifecycle получил userId из JWT', async () => {
    deleteExplicit.mockResolvedValue(undefined);

    const res = await request('DELETE', url, { authorization: `Bearer ${token}` });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.body).toEqual({ success: true });
    expect(deleteExplicit).toHaveBeenCalledTimes(1);
    expect(deleteExplicit).toHaveBeenCalledWith(USER);
  });

  it('lifecycle «повторите позже» — 503 с фиксированным безопасным телом, не success', async () => {
    deleteExplicit.mockRejectedValue(new ServiceUnavailableException(EXPLICIT_DELETION_UNAVAILABLE));

    const res = await request('DELETE', url, { authorization: `Bearer ${token}` });

    expect(res.status).toBe(503);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.body).toEqual({
      statusCode: 503,
      error: 'Service Unavailable',
      message: EXPLICIT_DELETION_UNAVAILABLE,
    });
    // Тело не раскрывает, чей аккаунт и что именно не удалось.
    expect(res.text).not.toContain(USER);
    expect(res.text).not.toContain('success');
    expect(deleteExplicit).toHaveBeenCalledWith(USER);
  });

  it('повтор после 503 — тот же маршрут доводит до 200 (клиенту есть что повторять)', async () => {
    deleteExplicit
      .mockRejectedValueOnce(new ServiceUnavailableException(EXPLICIT_DELETION_UNAVAILABLE))
      .mockResolvedValueOnce(undefined);

    const first = await request('DELETE', url, { authorization: `Bearer ${token}` });
    const second = await request('DELETE', url, { authorization: `Bearer ${token}` });

    expect(first.status).toBe(503);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ success: true });
    expect(deleteExplicit).toHaveBeenCalledTimes(2);
  });

  it('непредвиденная ошибка lifecycle — 500 без деталей ошибки в теле', async () => {
    deleteExplicit.mockRejectedValue(new Error(`deletion internals for ${USER}: relation does not exist`));

    const res = await request('DELETE', url, { authorization: `Bearer ${token}` });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ statusCode: 500, message: 'Internal server error' });
    expect(res.text).not.toContain(USER);
    expect(res.text).not.toContain('relation');
  });

  it('без Bearer — 401, lifecycle не вызывается', async () => {
    const res = await request('DELETE', url);

    expect(res.status).toBe(401);
    expect(deleteExplicit).not.toHaveBeenCalled();
  });

  it('хелпер запроса: не-JSON ответ — понятный отказ, а не зависание до таймаута', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(502, { 'content-type': 'text/html' });
      res.end('<html>bad gateway</html>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as { port: number };
      await expect(request('GET', `http://127.0.0.1:${port}/`))
        .rejects.toThrow(/^non-JSON response 502 text\/html: <html>bad gateway<\/html>$/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('refresh-токен вместо access — 401, lifecycle не вызывается', async () => {
    const refresh = app.get(JwtService).signRefresh(USER);

    const res = await request('DELETE', url, { authorization: `Bearer ${refresh}` });

    expect(res.status).toBe(401);
    expect(deleteExplicit).not.toHaveBeenCalled();
  });
});
