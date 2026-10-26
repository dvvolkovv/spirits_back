import {
  Controller,
  Post,
  Get,
  Delete,
  Req,
  Res,
  Headers,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { CHAT_TOOLS, ChatToolsService } from '../chat/chat-tools';
import { ChatService } from '../chat/chat.service';
import { ProblemReportService, SUPPORT_NOTE } from '../problem-report/problem-report.service';
import { verifyLinkeonToolToken } from './linkeon-tool.token';

/**
 * Кто зовёт инструмент — по Bearer.
 *   token  — релей с токеном хода (linkeon-tool.token.ts): пользователь из подписи;
 *   shared — переходный путь: общий MCP_SECRET, пользователь из args.userId,
 *            как до 26.10.2026. Снимается шагом 4 выката (спека
 *            docs/superpowers/specs/2026-10-26-mcp-turn-token-design.md).
 */
export type McpCaller = { kind: 'token'; userId: string } | { kind: 'shared' };

/** Поле userId — только в схеме переходного пути и без примера номера. */
const LEGACY_USER_ID_DESCRIPTION =
  'Current user id from the system context. Required on the transitional shared-secret path — the server uses it to bill tokens and attribute history.';

@Controller('/mcp')
export class McpController {
  private readonly logger = new Logger(McpController.name);

  constructor(
    private readonly tools: ChatToolsService,
    // Без @Optional сознательно: модуль, выпавший из McpModule, должен ронять
    // старт, а не молча выключать сообщения о сбоях — тихий отказ и был
    // поводом для этой работы (Кира, 24.10.2026).
    private readonly problems: ProblemReportService,
    private readonly chat: ChatService,
  ) {}

  /** Кто зовёт. Бросает 401 — значит звать инструмент нечем. */
  private caller(authHeader?: string): McpCaller {
    const header = authHeader || '';
    const shared = process.env.MCP_SECRET || '';
    if (shared && header === `Bearer ${shared}`) return { kind: 'shared' };
    const raw = header.replace(/^Bearer\s+/i, '').trim();
    if (!raw) throw new UnauthorizedException('Нет токена');
    try {
      return { kind: 'token', userId: verifyLinkeonToolToken(raw).userId };
    } catch (e: any) {
      throw new UnauthorizedException(`Токен не принят: ${e?.message}`);
    }
  }

  /**
   * tools/list. По токену — схемы инструментов как есть: пользователь в
   * подписи, аргумента userId нет. По общему секрету — прежняя схема с
   * обязательным userId: прежний релей пишет его в аргумент.
   * Вынесено из makeServer ради проверяемости.
   */
  listTools(caller: McpCaller) {
    return CHAT_TOOLS.map((t) => {
      const schema: any = t.input_schema ?? {};
      const properties: Record<string, any> = { ...(schema.properties ?? {}) };
      const required: string[] = [...(schema.required ?? [])];
      if (caller.kind === 'shared') {
        return {
          name: t.name,
          description: t.description,
          inputSchema: {
            type: 'object' as const,
            properties: { ...properties, userId: { type: 'string', description: LEGACY_USER_ID_DESCRIPTION } },
            required: ['userId', ...required],
          },
        };
      }
      return { name: t.name, description: t.description, inputSchema: { type: 'object' as const, properties, required } };
    });
  }

  private makeServer(authHeader?: string): Server {
    const caller = this.caller(authHeader);
    const server = new Server(
      { name: 'linkeon-mcp', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: this.listTools(caller) }));
    server.setRequestHandler(CallToolRequestSchema, async (req: any) => {
      const { name, arguments: args } = req.params ?? {};
      return this.callTool(authHeader, name, args);
    });
    return server;
  }

  /**
   * tools/call: пользователь — по Bearer, дальше ChatToolsService.executeTool.
   * Вынесено из makeServer ради проверяемости — как в products-mcp.controller.ts.
   */
  async callTool(authHeader: string | undefined, name: string, args: any) {
    const caller = this.caller(authHeader);
    // userId из аргументов выбрасывается ЯВНО (как в products-mcp.controller.ts):
    // по токену пользователь — только из подписи, поле модели не значит ничего.
    const { userId: argUserId, ...toolArgs } = args ?? {};
    let userId: string;
    if (caller.kind === 'token') {
      userId = caller.userId;
    } else {
      // Без пользователя и аргументов: по этой строке видно, что переходный
      // путь ещё кто-то зовёт (шаг 3 выката).
      this.logger.warn(`mcp: вызов по общему секрету (переходный путь), tool=${String(name).slice(0, 64)}`);
      if (!argUserId) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'userId argument required' }) }],
          isError: true,
        };
      }
      userId = String(argUserId);
    }
    this.logger.log(`tools/call ${name} userId=${userId}`);
    const result: any = await this.tools.executeTool(userId, name, toolArgs);
    const notified = !!result && result.ok === false && this.reportFailure(userId, String(name), result);
    // Копия, а не правка объекта инструмента: если ответ когда-нибудь закешируют, поля не протекут в чужие вызовы.
    const out = notified ? { ...result, supportNotified: true, supportNote: SUPPORT_NOTE } : result;
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(out) }],
      isError: !result.ok,
    };
  }

  /**
   * Сбой инструмента — в «Поддержку linkeon» (src/problem-report). Отдаёт,
   * можно ли сказать ассистенту «команда в курсе»: true, если Telegram
   * настроен и сбой поставлен в отправку, склеен с уже отправленным или упёрся
   * в общий потолок. Отправка идёт без ожидания, её исход сюда не доходит:
   * отказ Telegram true не отменит. Никогда не бросает: исключение при разборе
   * сбоя превращается в false.
   */
  private reportFailure(userId: string, tool: string, result: any): boolean {
    try {
      const { supportNotified } = this.problems.reportToolFailure({
        userId,
        assistantId: this.chat.activeAssistantFor(userId),
        tool,
        error: String(result.error ?? ''),
      });
      return supportNotified;
    } catch (e: any) {
      this.logger.warn(`сообщение о сбое ${tool} не обработано: ${e?.message}`);
      return false;
    }
  }

  @Post()
  async post(
    @Req() req: Request,
    @Res() res: Response,
    @Headers('authorization') auth?: string,
  ) {
    this.caller(auth); // отказ до всякой работы
    // Stateless: new transport per request, no session tracking.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = this.makeServer(auth);
    try {
      await server.connect(transport);
      await transport.handleRequest(req as any, res, req.body);
      // Cleanup once response is fully flushed
      res.on('close', () => {
        try {
          transport.close();
          server.close();
        } catch {}
      });
    } catch (e: any) {
      this.logger.error(`mcp post failed: ${e?.message || e}`);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  }

  @Get()
  async get(@Res() res: Response, @Headers('authorization') auth?: string) {
    this.caller(auth);
    // Stateless mode — no server-initiated SSE stream is supported.
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed (stateless mode)' },
      id: null,
    });
  }

  @Delete()
  async delete(@Res() res: Response, @Headers('authorization') auth?: string) {
    this.caller(auth);
    // Stateless — nothing to terminate.
    res.status(204).send();
  }
}
