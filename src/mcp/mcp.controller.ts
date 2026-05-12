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

@Controller('/mcp')
export class McpController {
  private readonly logger = new Logger(McpController.name);

  constructor(private readonly tools: ChatToolsService) {}

  private auth(authHeader?: string) {
    const secret = process.env.MCP_SECRET || '';
    if (!secret) {
      throw new UnauthorizedException('MCP_SECRET not configured on server');
    }
    if (!authHeader || authHeader !== `Bearer ${secret}`) {
      throw new UnauthorizedException('Invalid bearer token');
    }
  }

  /**
   * Build a fresh MCP server instance per request (stateless mode).
   * Registers tools/list and tools/call handlers backed by ChatToolsService.
   */
  private makeServer(): Server {
    const server = new Server(
      { name: 'linkeon-mcp', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );

    // tools/list — augment original schema with required userId argument
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: CHAT_TOOLS.map((t) => {
        const origProps = (t.input_schema as any)?.properties ?? {};
        const origRequired = (t.input_schema as any)?.required ?? [];
        return {
          name: t.name,
          description: t.description,
          inputSchema: {
            type: 'object',
            properties: {
              ...origProps,
              userId: {
                type: 'string',
                description:
                  'Current user phone (e.g. "79030169187"). Required for all calls — server uses it to bill tokens and attribute history.',
              },
            },
            required: ['userId', ...origRequired],
          },
        };
      }),
    }));

    // tools/call — pop userId, delegate to ChatToolsService.executeTool
    server.setRequestHandler(CallToolRequestSchema, async (req: any) => {
      const { name, arguments: args } = req.params ?? {};
      const userId = args?.userId;
      if (!userId) {
        return {
          content: [
            { type: 'text', text: JSON.stringify({ ok: false, error: 'userId argument required' }) },
          ],
          isError: true,
        };
      }
      const { userId: _omit, ...toolArgs } = args;
      this.logger.log(`tools/call ${name} userId=${userId}`);
      const result = await this.tools.executeTool(userId, name, toolArgs);
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        isError: !result.ok,
      };
    });

    return server;
  }

  @Post()
  async post(
    @Req() req: Request,
    @Res() res: Response,
    @Headers('authorization') auth?: string,
  ) {
    this.auth(auth);
    // Stateless: new transport per request, no session tracking.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = this.makeServer();
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
    this.auth(auth);
    // Stateless mode — no server-initiated SSE stream is supported.
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed (stateless mode)' },
      id: null,
    });
  }

  @Delete()
  async delete(@Res() res: Response, @Headers('authorization') auth?: string) {
    this.auth(auth);
    // Stateless — nothing to terminate.
    res.status(204).send();
  }
}
