import {
  BadRequestException,
  Controller,
  Post,
  Get,
  Delete,
  Req,
  Res,
  Headers,
  NotFoundException,
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
import { NOTE_FILE_TOOL, NOTE_FILE_TOOL_NAME } from '../chat/chat-files/note-file.tool';
import { ChatUploadsService, UPLOAD_NOTE_MAX_CHARS } from '../chat/chat-uploads/chat-uploads.service';
import { errKind, logId } from '../chat/chat-uploads/err-kind';
import { EventsService } from '../events/events.service';
import { DEFAULT_LANGUAGE, LanguageService } from '../common/services/language.service';
import { LINKEON_HELP_TOOL_NAME, executeLinkeonHelp, linkeonHelpTool } from '../platform-kb/linkeon-help';
import { ChatService } from '../chat/chat.service';
import { ProblemReportService } from '../problem-report/problem-report.service';
import { REPORT_PROBLEM_TOOL, REPORT_PROBLEM_TOOL_NAME } from '../problem-report/report-problem.tool';
import { OPEN_PAGE_TOOL, OPEN_PAGE_TOOL_NAME } from '../chat/web-page/open-page.tool';
import { openPage, PageRateLimiter } from '../chat/web-page/open-page';

/**
 * Отдельная точка, а не ветка в точке инструментов linkeon (mcp.controller.ts),
 * СОЗНАТЕЛЬНО. Пользователь и там и здесь — из подписи, но токены разные: у
 * токена хода linkeon (linkeon-tool.token.ts) внутри только userId, а у токена
 * продуктов (product-tool.token.ts) свой тип и ещё канал (он же
 * product_turns.channel), метка хода (по ней чат забирает карточки продуктов)
 * и область help (в Telegram-группе с посторонними — только справка). И сюда
 * же по loopback ходит локальный CLI — Маша и Telegram-бот
 * (products-cli-tool.ts), а точку linkeon зовёт только релей.
 *
 * РЕАЛЬНЫЙ АДРЕС — `/webhook/mcp/products`, а не `/mcp/products`: исключение в
 * main.ts выводит из-под глобального префикса ровно путь `mcp`, но не его
 * подпути. Так и оставлено: на тестовом стенде блока `location /mcp` в nginx
 * нет вовсе, и `/mcp/products` вернул бы там 200 с HTML вместо ответа.
 * Сторож адреса — в products-mcp.controller.spec.ts.
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
  /**
   * Лимит open_page на пользователя — в памяти процесса: контроллер один на
   * приложение, счётчик общий для всех вызовов точки (и релея, и Маши).
   */
  private readonly pageLimiter = new PageRateLimiter();

  constructor(
    private readonly tool: ProductToolService,
    private readonly files: ChatFilesService,
    // Без @Optional — по той же причине, что в mcp.controller.ts: выпавший
    // модуль должен ронять старт, а не молча выключать инструмент.
    private readonly problems: ProblemReportService,
    private readonly chat: ChatService,
    // Реестр загрузок — для note_file. Тоже без @Optional: McpModule
    // импортирует ChatUploadsModule, и пропавший провайдер уронит старт, а не
    // выключит комментарии молча.
    private readonly uploads: ChatUploadsService,
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
   * поддержку — в обоих каналах. Страница по ссылке (open_page) — только в
   * вебе: у CLI в Telegram свой WebFetch, а у релея он с 11.11.2026 выключен.
   */
  private toolsFor(c: Pick<ProductToolClaims, 'channel' | 'client' | 'scope'>) {
    const help = linkeonHelpTool(this.clientOf(c));
    if (c.scope === 'help') return [help];
    // Комментарий к загрузке — только в вебе и только при включённой памяти
    // загрузок (CHAT_UPLOADS_ENABLED): без флага реестр не пишется, и
    // комментировать нечего. Telegram получит его в очереди 2.
    const notes = process.env.CHAT_UPLOADS_ENABLED === 'true' ? [NOTE_FILE_TOOL] : [];
    return c.channel === 'telegram'
      ? [...PRODUCT_TOOLS, REPORT_PROBLEM_TOOL, help]
      : [...PRODUCT_TOOLS, FIND_FILES_TOOL, ...notes, OPEN_PAGE_TOOL, REPORT_PROBLEM_TOOL, help];
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
    if (name === NOTE_FILE_TOOL_NAME) {
      const result = await this.noteFile(userId, input);
      // Статистика админки, как у find_files: канал из подписи и исход — без id
      // файла и текста комментария.
      this.events?.track('note_file_call', { userId, props: { channel, ok: result.ok } });
      return result;
    }
    if (name === OPEN_PAGE_TOOL_NAME) {
      // Пользователь — из подписи (по нему лимит частоты), язык — тоже из
      // подписи, без похода в профиль: он нужен лишь для Accept-Language.
      const { kind, result } = await openPage(userId, input, { limiter: this.pageLimiter, lang: claims.lang });
      // Статистика: канал, исход и вид (html/text/… или причина отказа). Адреса,
      // хоста и текста страницы здесь нет — это переписка пользователя.
      this.events?.track('open_page_call', { userId, props: { channel, ok: result.ok, kind } });
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

  /**
   * note_file: комментарий ассистента к загрузке пользователя. Владелец — из
   * подписи токена (userId из аргументов callTool уже выбросил).
   *
   * Ассистент для note_assistant_id: в токене продуктов его нет (там канал,
   * клиент, вид ассистента staff/custom и метка хода), поэтому — тот же
   * приём, что у report_problem: ассистент самого свежего хода этого
   * пользователя (ChatService.activeAssistantFor), хода нет — null. Это
   * подпись «кто оставил», а не права: писать можно только в свои загрузки.
   * Инструмент есть только в вебе, поэтому оговорки report_problem про
   * Telegram здесь не нужны.
   *
   * Прочие сбои (pg, сеть) модели — общей фразой: сообщение драйвера может
   * повторять запрос или id. В журнал — только вид ошибки и id в кавычках,
   * без текста комментария и владельца.
   */
  private async noteFile(userId: string, input: any) {
    const id = typeof input?.file_id === 'string' ? input.file_id.trim() : '';
    const note = typeof input?.note === 'string' ? input.note : '';
    try {
      const record = await this.uploads.setNote({
        id,
        userId,
        note,
        assistantId: this.chat.activeAssistantFor(userId),
      });
      return { ok: true, id: record.id, note: record.note };
    } catch (e: any) {
      if (e instanceof NotFoundException) {
        return { ok: false, error: 'Файл не найден: передай id из блока загрузок или поле id из find_files.' };
      }
      if (e instanceof BadRequestException) {
        return { ok: false, error: `Комментарий — от 1 до ${UPLOAD_NOTE_MAX_CHARS} символов.` };
      }
      this.logger.error(`note_file (id=${logId(id)}): internal failure: ${errKind(e)}`);
      return { ok: false, error: 'внутренняя ошибка, попробуй позже' };
    }
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
