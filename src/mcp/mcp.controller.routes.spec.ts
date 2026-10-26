import 'reflect-metadata';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { AddressInfo } from 'net';
import { INestApplication, Module, RequestMethod } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { McpController } from './mcp.controller';
import { ChatToolsService } from '../chat/chat-tools';
import { ChatService } from '../chat/chat.service';
import { ProblemReportService } from '../problem-report/problem-report.service';
import { signLinkeonToolToken } from './linkeon-tool.token';

jest.setTimeout(60_000);

/**
 * АДРЕСА ТОЧКИ — живым приложением Nest, а не метаданными: адрес складывается
 * из @Controller и исключения глобального префикса в main.ts, и по отдельности
 * ни то ни другое правды не говорит (см. «адрес точки» в
 * products-mcp.controller.spec.ts). Зависимости контроллера — заглушки:
 * проверяются маршрутизация и вход, а не инструменты.
 */
@Module({
  controllers: [McpController],
  providers: [
    { provide: ChatToolsService, useValue: { executeTool: async () => ({ ok: true }) } },
    { provide: ProblemReportService, useValue: { reportToolFailure: () => ({ supportNotified: false }) } },
    { provide: ChatService, useValue: { activeAssistantFor: () => null } },
  ],
})
class McpRoutesSpecModule {}

describe('адреса точки инструментов Linkeon', () => {
  const OLD = { jwt: process.env.JWT_SECRET, mcp: process.env.MCP_SECRET };
  let app: INestApplication;
  let port = 0;

  beforeAll(async () => {
    process.env.JWT_SECRET = 'mcp-routes-spec';
    process.env.MCP_SECRET = 'mcp-routes-shared';
    app = await NestFactory.create(McpRoutesSpecModule, { logger: false, abortOnError: false });
    // Ровно как в main.ts — что строка там та же, проверяет первый тест.
    app.setGlobalPrefix('webhook', { exclude: [{ path: 'mcp', method: RequestMethod.ALL }] });
    await app.listen(0, '127.0.0.1');
    port = (app.getHttpServer().address() as AddressInfo).port;
  });

  afterAll(async () => {
    await app?.close();
    if (OLD.jwt === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = OLD.jwt;
    if (OLD.mcp === undefined) delete process.env.MCP_SECRET; else process.env.MCP_SECRET = OLD.mcp;
  });

  /** Запрос без keep-alive (agent: false): открытый сокет не держит jest. */
  function call(method: string, p: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: p, method, headers, agent: false }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }
  const token = () => `Bearer ${signLinkeonToolToken('u-routes')}`;
  const status = async (p: string, auth?: string) => (await call('GET', p, auth ? { Authorization: auth } : {})).status;

  it('в main.ts то же исключение из глобального префикса', () => {
    const src = fs.readFileSync(path.join(__dirname, '../main.ts'), 'utf8');
    expect(src).toMatch(/setGlobalPrefix\('webhook',\s*\{\s*exclude:\s*\[\{\s*path:\s*'mcp',\s*method:\s*RequestMethod\.ALL\s*\}\]/);
  });

  it('основной адрес /webhook/mcp/linkeon: с токеном хода — до обработчика (405 у GET), без — 401', async () => {
    expect(await status('/webhook/mcp/linkeon', token())).toBe(405);
    expect(await status('/webhook/mcp/linkeon')).toBe(401);
  });

  it('прежний /mcp на переходный период: общий секрет и токен хода доходят до обработчика', async () => {
    expect(await status('/mcp', 'Bearer mcp-routes-shared')).toBe(405);
    expect(await status('/mcp', token())).toBe(405);
    expect(await status('/mcp')).toBe(401);
  });

  it('других адресов у точки нет', async () => {
    expect(await status('/mcp/linkeon', token())).toBe(404);
    expect(await status('/webhook/mcp', token())).toBe(404);
  });

  it('tools/list по HTTP на основном адресе — без userId', async () => {
    const r = await call('POST', '/webhook/mcp/linkeon', {
      Authorization: token(),
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    }, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    expect(r.status).toBe(200);
    // Ответ — SSE (`event: message` + `data: {...}`) или чистый JSON.
    const data = r.text.split('\n').find((l) => l.startsWith('data: '));
    const msg = JSON.parse(data ? data.slice(6) : r.text);
    expect(msg.result.tools.length).toBeGreaterThan(0);
    for (const t of msg.result.tools) expect(Object.keys(t.inputSchema.properties ?? {})).not.toContain('userId');
  });
});
