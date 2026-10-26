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
  Optional,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { PRODUCT_TOOLS, ProductToolService } from '../products/product-tool.service';
import {
  ProductToolChannel,
  ProductToolClaims,
  ProductToolClient,
  ProductToolScope,
  verifyProductToolToken,
} from '../products/product-tool.token';
import { ChatFilesService } from '../chat/chat-files/chat-files.service';
import { FIND_FILES_TOOL, FIND_FILES_TOOL_NAME } from '../chat/chat-files/find-files.tool';
import { parseFindFilesInput } from '../chat/chat-files/find-files';
import { EventsService } from '../events/events.service';
import { DEFAULT_LANGUAGE, LanguageService } from '../common/services/language.service';
import { LINKEON_HELP_TOOL_NAME, executeLinkeonHelp, linkeonHelpTool } from '../platform-kb/linkeon-help';
import { ChatService } from '../chat/chat.service';
import { ProblemReportService } from '../problem-report/problem-report.service';
import { REPORT_PROBLEM_TOOL, REPORT_PROBLEM_TOOL_NAME } from '../problem-report/report-problem.tool';

/**
 * Отдельная точка, а не ветка в /mcp, СОЗНАТЕЛЬНО.
 *
 * РЕАЛЬНЫЙ АДРЕС — `/webhook/mcp/products`, а не `/mcp/products`: исключение в
 * main.ts выводит из-под глобального префикса ровно путь `mcp`, но не его
 * подпути. Так и оставлено: на тестовом стенде блока `location /mcp` в nginx
 * нет вовсе, и `/mcp/products` вернул бы там 200 с HTML вместо ответа.
 * Сторож адреса — в products-mcp.controller.spec.ts.
 *
 * До 26.10.2026 на общей точке владелец приезжал полем запроса, которое пишет
 * модель (релей подсказывал телефон в реплике хода). Для картинок это цена в
 * токенах, для продуктов — правка чужого сайта. Теперь и там токен хода
 * (src/mcp/linkeon-tool.token.ts); поле осталось только на переходном пути по
 * общему секрету.
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

  constructor(
    private readonly tool: ProductToolService,
    private readonly files: ChatFilesService,
    // Без @Optional — по той же причине, что в mcp.controller.ts: выпавший
    // модуль должен ронять старт, а не молча выключать инструмент.
    private readonly problems: ProblemReportService,
    private readonly chat: ChatService,
    @Optional() private readonly events?: EventsService,
    @Optional() private readonly language?: LanguageService,
  ) {}

  /** Владелец и канал из Bearer. Бросает — значит звать инструмент нечем. */
  private owner(authHeader?: string): ProductToolClaims {
    const raw = (authHeader || '').replace(/^Bearer\s+/i, '').trim();
    if (!raw) throw new UnauthorizedException('Нет токена');
    try {
      return verifyProductToolToken(raw);
    } catch (e: any) {
      throw new UnauthorizedException(`Токен не принят: ${e?.message}`);
    }
  }

  /** Клиент для справки: из подписи, а у токена без поля — по каналу. */
  private clientOf(c: Pick<ProductToolClaims, 'channel' | 'client'>): ProductToolClient {
    return c.client ?? (c.channel === 'telegram' ? 'telegram' : 'web');
  }

  /**
   * Инструменты по токену. Справка — всем; по токену с областью help — только
   * она: такой получают ходы Telegram-группы с посторонними, где продукты и
   * файлы владельца трогать нельзя, а сообщать в поддержку от их имени — тоже.
   * Поиск файлов — только в вебе (TG-бот в эту фичу не входит); сообщить в
   * поддержку — в обоих каналах.
   */
  private toolsFor(c: Pick<ProductToolClaims, 'channel' | 'client' | 'scope'>) {
    const help = linkeonHelpTool(this.clientOf(c));
    if (c.scope === 'help') return [help];
    return c.channel === 'telegram'
      ? [...PRODUCT_TOOLS, REPORT_PROBLEM_TOOL, help]
      : [...PRODUCT_TOOLS, FIND_FILES_TOOL, REPORT_PROBLEM_TOOL, help];
  }

  /** Вынесено из makeServer ради проверяемости: контракт схемы — часть защиты. */
  listTools(channel: ProductToolChannel = 'web', opts: { client?: ProductToolClient; scope?: ProductToolScope } = {}) {
    return this.toolsFor({ channel, ...opts }).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.input_schema,
    }));
  }

  /** Вынесено из makeServer по той же причине: здесь живёт разбор владельца. */
  async callTool(authHeader: string | undefined, args: any, name: string = PRODUCT_TOOLS[0].name) {
    const claims = this.owner(authHeader);
    const { userId, channel, turn } = claims;
    // userId из запроса выбрасывается ЯВНО, а не игнорируется по невнимательности:
    // поле могло бы приехать и перекрыть владельца при любой будущей правке
    // execute(), которая начнёт заглядывать в input. channel и turn — туда же:
    // канал хода (web/telegram) и метка хода несут подпись токена, а не поле,
    // которое пишет модель — иначе модель могла бы приписать карточку чужому ходу.
    const { userId: _drop, channel: _dropChannel, turn: _dropTurn, ...input } = args ?? {};
    if (!this.toolsFor(claims).some((t) => t.name === name)) {
      return { ok: false, error: `Неизвестный инструмент: ${name}` };
    }
    if (name === LINKEON_HELP_TOOL_NAME) {
      // Язык — из подписи; у токена, выпущенного до справки, — из профиля.
      const lang = claims.lang ?? (await this.language?.resolveUserLanguage(userId)) ?? DEFAULT_LANGUAGE;
      const client = this.clientOf(claims);
      const result = executeLinkeonHelp(input, { lang, client });
      // Статистика: о чём спрашивают и каких тем не хватает. Текста разговора нет.
      this.events?.track('linkeon_help_call', {
        userId,
        props: {
          channel,
          client,
          lang,
          scope: claims.scope ?? 'full',
          agent: claims.agent ?? null,
          topics: result.articles.map((a) => a.id),
          index: !!result.index,
        },
      });
      return result;
    }
    if (name === FIND_FILES_TOOL_NAME) {
      const result = await this.files.searchForUser(userId, parseFindFilesInput(input));
      // Статистика админки: сколько отдали модели и сколько из этого можно скачать.
      this.events?.track('find_files_call', {
        userId,
        props: { channel, found: result.files.length, stored: result.files.filter((f) => f.stored).length },
      });
      return result;
    }
    if (name === REPORT_PROBLEM_TOOL_NAME) {
      // Пользователь и канал — из подписи, как у остальных инструментов точки.
      // Ассистент хода — только в вебе: у TG-бота хода в ChatService нет, а
      // параллельный веб-ход того же человека подписал бы сообщение чужим именем.
      return this.problems.reportFromAssistant({
        userId,
        channel,
        assistantId: channel === 'web' ? this.chat.activeAssistantFor(userId) : null,
        assistantArg: input.assistant,
        kind: input.kind,
        summary: input.summary,
      });
    }
    return this.tool.execute(userId, input, channel, turn);
  }

  private makeServer(authHeader?: string): Server {
    const claims = this.owner(authHeader);
    const server = new Server(
      { name: 'linkeon-products', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.listTools(claims.channel, { client: claims.client, scope: claims.scope }),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (req: any) => {
      const { name, arguments: args } = req.params ?? {};
      const result: any = await this.callTool(authHeader, args, name);
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
