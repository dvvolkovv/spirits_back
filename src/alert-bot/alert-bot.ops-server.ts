import * as http from 'http';
import { AlertBotAccess } from './alert-bot.access';
import { alertBotOpsPort } from './alert-bot.config';
import { verifyOpsToken } from './alert-bot.ops-token';
import { OpsToolHandler } from './alert-bot.types';

const MAX_BODY_BYTES = 65_536;

export class AlertBotOpsServer {
  private server: http.Server | null = null;
  private readonly toolCalls = new Map<string, string[]>();

  constructor(
    private readonly access: AlertBotAccess,
    private readonly tools: OpsToolHandler,
  ) {}

  async start(port = alertBotOpsPort()): Promise<void> {
    if (this.server) throw new Error('ops server already started');
    const server = http.createServer((req, res) => { void this.handle(req, res); });
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server.once('error', onError);
        server.listen(port, this.host(), () => {
          server.off('error', onError);
          resolve();
        });
      });
    } catch (error) {
      this.server = null;
      throw error;
    }
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }

  host(): string { return '127.0.0.1'; }

  origin(): string {
    const address = this.server?.address();
    if (!address || typeof address === 'string') throw new Error('ops server not started');
    return `http://${this.host()}:${address.port}`;
  }

  url(): string { return `${this.origin()}/mcp`; }

  consumeToolNames(token: string): string[] {
    const names = this.toolCalls.get(token) || [];
    this.toolCalls.delete(token);
    return names;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const path = new URL(req.url || '/', 'http://127.0.0.1').pathname;
      if (path !== '/mcp') {
        this.sendError(res, 404, null, -32000, 'not found');
        return;
      }

      const match = /^Bearer (.+)$/.exec(req.headers.authorization || '');
      const token = match?.[1];
      const identity = token ? verifyOpsToken(token) : null;
      if (!identity || !token) {
        this.sendEmpty(res, 401);
        return;
      }
      if (!await this.access.isAdminUserId(identity.adminUserId)) {
        this.sendEmpty(res, 403);
        return;
      }

      if (req.method === 'DELETE') {
        this.sendEmpty(res, 204);
        return;
      }
      if (req.method !== 'POST') {
        this.sendError(res, 405, null, -32000, 'stateless endpoint');
        return;
      }

      let raw: string;
      try {
        raw = await this.readBody(req);
      } catch {
        this.sendError(res, 413, null, -32000, 'payload too large');
        return;
      }

      let body: any;
      try {
        body = JSON.parse(raw);
      } catch {
        this.sendError(res, 400, null, -32700, 'parse error');
        return;
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        this.sendError(res, 400, null, -32600, 'invalid request');
        return;
      }

      const id = body.id ?? null;
      if (body.id === undefined && typeof body.method === 'string' && body.method.startsWith('notifications/')) {
        this.sendEmpty(res, 202);
        return;
      }
      if (body.id === undefined || typeof body.method !== 'string') {
        this.sendError(res, 400, null, -32600, 'invalid request');
        return;
      }

      if (body.method === 'initialize') {
        this.sendJson(res, 200, {
          jsonrpc: '2.0', id,
          result: {
            protocolVersion: body.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'ops', version: '1.0.0' },
          },
        });
        return;
      }
      if (body.method === 'tools/list') {
        this.sendJson(res, 200, { jsonrpc: '2.0', id, result: { tools: this.tools.definitions() } });
        return;
      }
      if (body.method === 'tools/call') {
        const name = body.params?.name;
        const args = body.params?.arguments;
        if (typeof name !== 'string' || !args || typeof args !== 'object' || Array.isArray(args)) {
          this.sendError(res, 200, id, -32602, 'invalid params');
          return;
        }
        const names = this.toolCalls.get(token) || [];
        names.push(name);
        this.toolCalls.set(token, names);

        let text: string;
        try {
          text = await this.tools.execute(name, args, identity);
        } catch {
          text = JSON.stringify({ error: 'tool_failed' });
        }
        let isError = false;
        try {
          const parsed = JSON.parse(text);
          isError = Boolean(parsed && typeof parsed === 'object' && 'error' in parsed && parsed.error !== undefined);
        } catch { /* Обычный текст инструмента не является JSON-ошибкой. */ }
        this.sendJson(res, 200, {
          jsonrpc: '2.0', id,
          result: { content: [{ type: 'text', text }], isError },
        });
        return;
      }

      this.sendError(res, 200, id, -32601, 'method not found');
    } catch {
      if (!res.headersSent) this.sendError(res, 500, null, -32603, 'internal error');
    }
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let size = 0;
      let tooLarge = false;
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          tooLarge = true;
          chunks.length = 0;
        } else if (!tooLarge) {
          chunks.push(chunk);
        }
      });
      req.on('end', () => {
        if (tooLarge) reject(new Error('payload too large'));
        else resolve(Buffer.concat(chunks).toString('utf8'));
      });
      req.on('error', reject);
    });
  }

  private sendEmpty(res: http.ServerResponse, status: number): void {
    res.statusCode = status;
    res.end();
  }

  private sendError(res: http.ServerResponse, status: number, id: unknown, code: number, message: string): void {
    this.sendJson(res, status, { jsonrpc: '2.0', id, error: { code, message } });
  }

  private sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload);
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Length', Buffer.byteLength(body));
    res.end(body);
  }
}
