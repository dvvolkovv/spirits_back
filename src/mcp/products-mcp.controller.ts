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
import { PRODUCT_TOOLS, ProductToolService } from '../products/product-tool.service';
import { verifyProductToolToken } from '../products/product-tool.token';

/**
 * Отдельная точка, а не ветка в /mcp, СОЗНАТЕЛЬНО.
 *
 * На общей точке владелец приезжает полем запроса, которое пишет модель
 * (mcp.controller.ts:74, релей подсказывает телефон в системном промпте —
 * relay-agent/server.mjs:378). Для картинок это цена в токенах, для продуктов —
 * правка чужого сайта.
 *
 * Здесь Bearer — подписанный нами токен сессии с userId внутри, поэтому
 * принадлежность закрыта ПОДПИСЬЮ, а не проверкой: аргумента userId у
 * инструмента нет вовсе, и подделать его нечем. Тот же приём, что у TalerID
 * (пер-сессионный токен в заголовке), и та же линия, что у метки машины,
 * которая и есть её токен.
 */
@Controller('/mcp/products')
export class ProductsMcpController {
  private readonly logger = new Logger(ProductsMcpController.name);

  constructor(private readonly tool: ProductToolService) {}

  /** Владелец из Bearer. Бросает — значит звать инструмент нечем. */
  private owner(authHeader?: string): string {
    const raw = (authHeader || '').replace(/^Bearer\s+/i, '').trim();
    if (!raw) throw new UnauthorizedException('Нет токена');
    try {
      return verifyProductToolToken(raw);
    } catch (e: any) {
      throw new UnauthorizedException(`Токен не принят: ${e?.message}`);
    }
  }

  /** Вынесено из makeServer ради проверяемости: контракт схемы — часть защиты. */
  listTools() {
    return PRODUCT_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.input_schema,
    }));
  }

  /** Вынесено из makeServer по той же причине: здесь живёт разбор владельца. */
  async callTool(authHeader: string | undefined, args: any) {
    const userId = this.owner(authHeader);
    // userId из запроса выбрасывается ЯВНО, а не игнорируется по невнимательности:
    // поле могло бы приехать и перекрыть владельца при любой будущей правке
    // execute(), которая начнёт заглядывать в input.
    const { userId: _drop, ...input } = args ?? {};
    return this.tool.execute(userId, input);
  }

  private makeServer(authHeader?: string): Server {
    const server = new Server(
      { name: 'linkeon-products', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: this.listTools() }));
    server.setRequestHandler(CallToolRequestSchema, async (req: any) => {
      const { name, arguments: args } = req.params ?? {};
      if (name !== PRODUCT_TOOLS[0].name) {
        return {
          content: [
            { type: 'text', text: JSON.stringify({ ok: false, error: `Неизвестный инструмент: ${name}` }) },
          ],
          isError: true,
        };
      }
      const result: any = await this.callTool(authHeader, args);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: !result.ok };
    });
    return server;
  }

  @Post()
  async post(
    @Req() req: Request,
    @Res() res: Response,
    @Headers('authorization') auth?: string,
  ) {
    this.owner(auth); // отказ до всякой работы, как на общей точке
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = this.makeServer(auth);
    try {
      await server.connect(transport);
      await transport.handleRequest(req as any, res, req.body);
      res.on('close', () => {
        try {
          transport.close();
          server.close();
        } catch {}
      });
    } catch (e: any) {
      this.logger.error(`mcp/products failed: ${e?.message || e}`);
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
    this.owner(auth);
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed (stateless mode)' },
      id: null,
    });
  }

  @Delete()
  async delete(@Res() res: Response, @Headers('authorization') auth?: string) {
    this.owner(auth);
    res.status(204).send();
  }
}
