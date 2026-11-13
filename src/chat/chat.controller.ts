import { Controller, Post, Get, Delete, Body, Query, Req, Res, UseGuards, Optional, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import { ChatService, SdkUsageTotals, RelayTurnCost } from './chat.service';
import { relayAuthHeaders } from './relay-auth';
import { appendLinkeonFields } from './linkeon-relay-fields';
import { JwtGuard } from '../common/guards/jwt.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import { JwtService } from '../common/services/jwt.service';
import { Neo4jService } from '../neo4j/neo4j.service';
import { EventsService } from '../events/events.service';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { makeReadWithinDirGuard, neutralizeAtMentions, stripWordJoiner } from '../common/agent-guards';
import { decodeMultipartFilename } from '../common/utils/multipart-filename';
import { TEST_USERS } from '../common/test-users';
import { parseClientUi } from './client-ui';
import { ClientPing, startClientPing } from './client-ping';
import { isStoreBuild } from './client-kind';
import { toActivity } from './activity-map';
import { RelayOutputFile, collectOutputFiles, outputFileLines } from './chat-files/relay-links';
import { stripProductActionBlocks } from '../products/product-action-tail';
import { UserLlmProviderService } from '../common/services/user-llm-provider.service';
import { relayProviderFields, resolveAnswerProvider } from './answer-provider';
import { ChatUploadsService, ChatUploadRecord } from './chat-uploads/chat-uploads.service';

// Потолок загрузки и зачем он именно такой — в upload-limits.ts, вместе с
// самой константой (менять его можно только вместе с ОБОИМИ nginx).
import { MAX_UPLOAD_FILE_BYTES, MAX_UPLOAD_TOTAL_BYTES } from './upload-limits';
export { MAX_UPLOAD_FILE_BYTES, MAX_UPLOAD_TOTAL_BYTES };

/**
 * Экранирование имени файла для markdown-ссылки в истории: `\`, `[`, `]`.
 * Имена приходят из multipart и могут содержать любые символы — без экранировки
 * имя с квадратной скобкой ломало бы ссылку `📎 [имя](url)` в сохранённой строке.
 */
function markdownEscapeName(name: string): string {
  return name.replace(/\\/g, '\\\\').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
}

/**
 * Бюджет сохранения исходников ДО первого байта ответа (ревью I1, 13.11.2026),
 * мс. Сохранение (MinIO PutObject + PG insert) идёт до res.status/begin, и без
 * бюджета деградация MinIO держала бы клиента на молчащем соединении: nginx
 * режет 504, а бэкенд продолжает и платит за ход релея, который никто не ждёт.
 * Дефолт в стиле PERSIST_TURN_BUDGET_MS (chat-files); env-переопределение
 * читается в момент вызова — для тестов и аварийных сценариев.
 */
const CHAT_UPLOADS_SAVE_BUDGET_MS_DEFAULT = 20_000;
function chatUploadsSaveBudgetMs(): number {
  const parsed = Number(process.env.CHAT_UPLOADS_SAVE_BUDGET_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : CHAT_UPLOADS_SAVE_BUDGET_MS_DEFAULT;
}

@Controller('')
export class ChatController {
  private readonly logger = new Logger(ChatController.name);

  constructor(
    private readonly chatService: ChatService,
    private readonly jwtSvc: JwtService,
    @Optional() private readonly neo4j: Neo4jService,
    @Optional() private readonly events?: EventsService,
    // Модель ответов человека: личный выбор или общий рубильник (админка,
    // spec 2026-10-30-llm-provider-switch, 2026-10-31-global-llm-switch) —
    // для хода с файлами. Последним и @Optional: спеки собирают контроллер позиционно.
    @Optional() private readonly llmProvider?: UserLlmProviderService,
    // Память загрузок (spec 2026-11-13-chat-upload-memory): исходники файлов
    // в наше хранилище до вызова релея. Тоже последним и @Optional — по той же причине.
    @Optional() private readonly chatUploads?: ChatUploadsService,
  ) {}

  /**
   * Сколько ходов прямо сейчас в полёте. Спрашивает deploy.sh перед
   * `pm2 restart`: рестарт посреди стрима убивает ответ молча — ни ошибки
   * пользователю, ни ретрая, ни строки в истории (инцидент 2026-08-10 20:22).
   *
   * Без авторизации сознательно: у деплой-скрипта нет токена, а наружу уходит
   * одно число без единой подробности о том, кто и о чём говорит.
   */
  @Get('chat/active-streams')
  activeStreams() {
    return { active: this.chatService.getActiveStreamCount() };
  }

  /**
   * Идёт ли ход прямо сейчас у ЭТОГО пользователя с этим ассистентом.
   *
   * Фронт спрашивает при загрузке чата: индикатор «печатает» жил только в
   * памяти вкладки, и перезагрузка посреди пятиминутного ответа превращала
   * работающий чат в молчащий. Пользователь решал, что всё зависло, и слал «?» —
   * а этим «?» убивал собственный ход, потому что релей пре-эмптит предыдущий
   * процесс сессии.
   */
  @Get('chat/active-turn')
  @UseGuards(JwtGuard)
  activeTurn(@CurrentUser() user: any, @Query('assistantId') assistantId: string) {
    return this.chatService.getActiveTurn(user.userId, assistantId);
  }

  @Post('soulmate/chat')
  async chat(@Req() req: Request, @Res() res: Response) {
    // Auth: check Bearer but don't throw (auth inside workflow behavior)
    const authHeader = req.headers['authorization'];
    let userId: string | null = null;
    if (authHeader?.startsWith('Bearer ')) {
      try {
        const payload = this.jwtSvc.verify(authHeader.substring(7));
        if (payload.type === 'access') userId = payload.userId;
      } catch {}
    }

    if (!userId) {
      // Return empty response (matching n8n behavior — auth check inside workflow)
      //
      // ⚠️ КОНТРАКТ ДЛЯ КЛИЕНТОВ: неавторизованному здесь уходит 200 С ПУСТЫМ ТЕЛОМ, а не 401.
      // Два следствия, на которых уже обожглись (лаунчер, 04.11.2026):
      //  1. пустой поток на этой ручке — это «токен не принят», а не «модель промолчала»;
      //  2. «не 401» с этого адреса НЕ доказывает, что сессия жива, — как и с других публичных
      //     ручек (/webhook/agents, /webhook/<uuid>/agent/avatar/*, first-contact). Клиент,
      //     считавший любой не-401 признаком входа, сам стирал себе память «сервер отверг».
      // Менять код ответа здесь нельзя без ревизии клиентов: на 200 завязан веб.
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.status(200).send('');
    }

    const body = req.body || {};
    const message = body.message || body.chatInput;
    const assistantId = body.assistantId || body.assistant;
    const sessionId = body.sessionId;
    // Язык интерфейса. Фронт шлёт его в каждом чат-запросе (ChatInterface.tsx),
    // но до 2026-08-09 бэк это поле не читал вовсе. Используется только как
    // подстраховка при пустом языке в профиле — приоритет разбирается в
    // LanguageService.resolveUserLanguage.
    const requestLang = typeof body.lang === 'string' ? body.lang : undefined;
    // Часовой пояс клиента (IANA). Фронт берёт его из Intl и шлёт в каждом
    // запросе — иначе ассистент считает время по UTC сервера.
    const clientTz = typeof body.tz === 'string' ? body.tz.slice(0, 64) : undefined;
    // Канал распространения клиента. Мобильное приложение шлёт его заголовком
    // в каждом запросе (ApiClient). В сборке для магазина ассистент не должен
    // давать ссылку на пополнение: правило 3.1.1 считает нарушением любую
    // точку доступа к оплате мимо биллинга Apple, и отказ 17.08.2026 пришёл
    // именно за такую ссылку.
    //
    // Неизвестное или отсутствующее значение — НЕ магазин: так ведут себя веб
    // и старые сборки, где оплата разрешена. Ошибиться в эту сторону дешевле,
    // чем молча выключить пополнение всему вебу.
    const storeBuild = isStoreBuild(req.headers['x-linkeon-distribution']);
    if (!message || !assistantId) {
      return res.status(400).json({ error: 'Missing message or assistantId' });
    }

    // Get Neo4j profile context
    let profileText = '';
    if (this.neo4j) {
      try {
        profileText = await this.neo4j.getProfileDescription(userId);
      } catch {}
    }

    // «Чистый лист»: фронт передаёт fresh=true + freshTs (метка включения
    // режима). Сессия собирается на бэке — фронт не знает формат userId.
    const fresh = body.fresh === true && /^\d{6,}$/.test(String(body.freshTs || ''));
    const finalSessionId = fresh
      ? `${userId}_${assistantId}_fresh_${body.freshTs}`
      : (sessionId || `${userId}_${assistantId}`);

    // Пинг мониторинга (smoke / synthetic-runner): ход уходит на дешёвую модель,
    // потому что проверяется живость пути, а не качество ответа.
    //
    // Флаг признаётся ТОЛЬКО у тестовых аккаунтов. Иначе это ручка, которой
    // любой пользователь молча понижает себе модель — и разбираться потом
    // придётся с жалобой «ассистент поглупел», у которой нет следа ни в логах,
    // ни в промпте.
    const probe = body.probe === true && TEST_USERS.includes(userId);
    // Что умеет клиент — шаги работы и карточки вопросов (client-ui.ts).
    const ui = parseClientUi(body.ui);
    const startedAt = Date.now();
    try {
      await this.chatService.streamChat(
        userId,
        message,
        String(assistantId),
        finalSessionId,
        profileText,
        res,
        req,
        fresh,
        requestLang,
        clientTz,
        storeBuild,
        probe,
        ui,
      );
      this.events?.track('response_received', {
        userId,
        sessionId: finalSessionId,
        props: { assistant_id: String(assistantId), duration_ms: Date.now() - startedAt },
      });
    } catch (e: any) {
      this.events?.track('response_failed', {
        userId,
        sessionId: finalSessionId,
        props: { assistant_id: String(assistantId), error: e?.message?.slice(0, 200) || 'unknown' },
      });
      throw e;
    }
  }

  @Post('agent/upload-and-chat')
  async uploadAndChat(@Req() req: Request, @Res() res: Response) {
    const authHeader = req.headers['authorization'];
    let userId: string | null = null;
    if (authHeader?.startsWith('Bearer ')) {
      try {
        const payload = this.jwtSvc.verify(authHeader.substring(7));
        if (payload.type === 'access') userId = payload.userId;
      } catch {}
    }
    if (!userId) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.status(200).send('');
    }

    const multer = require('multer');
    const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_FILE_BYTES } });

    // any(), а не single('file'): принимаем и один файл, и группу.
    //
    // Раньше стоял upload.single('file') — ровно один файл за запрос, и
    // клиенту приходилось слать пачку последовательно, отдельным диалогом на
    // каждый. При этом дальше, на агент, файл уже уходил под именем `files`
    // во множественном числе, то есть ограничение было только на входе.
    //
    // Старое имя поля `file` продолжает работать: any() собирает всё, что
    // прислали, независимо от имени.
    // Ошибку multer'а раньше просто пробрасывали наружу — Nest отвечал голым
    // 500, фронт показывал «не удалось обработать файл», и причина («файл
    // больше лимита») не доходила до пользователя вообще. Отвечаем внятным
    // кодом: фронту есть что показать, а нам — что искать в логах.
    const uploadErr: any = await new Promise<any>((resolve) => {
      upload.any()(req as any, res as any, (err: any) => resolve(err || null));
    });
    if (uploadErr) {
      const tooBig = uploadErr.code === 'LIMIT_FILE_SIZE';
      // eslint-disable-next-line no-console
      console.warn(`[upload-and-chat] multer отказал для ${userId}: ${uploadErr.code || uploadErr.message}`);
      return res.status(tooBig ? 413 : 400).json({
        error: tooBig ? 'file_too_large' : 'upload_failed',
        maxFileBytes: MAX_UPLOAD_FILE_BYTES,
        detail: uploadErr.message,
      });
    }

    const files: any[] = ((req as any).files || []).map((f: any) => ({
      ...f,
      originalname: decodeMultipartFilename(f.originalname),
    }));
    const body = (req as any).body || {};
    const message = body.message || body.task || '';
    const assistantId = body.assistantId || 'Роман';

    if (!files.length) return res.status(400).json({ error: 'No file uploaded' });

    const totalBytes = files.reduce((sum: number, f: any) => sum + (f.size || f.buffer?.length || 0), 0);
    if (totalBytes > MAX_UPLOAD_TOTAL_BYTES) {
      // eslint-disable-next-line no-console
      console.warn(`[upload-and-chat] партия ${Math.round(totalBytes / 1048576)} МБ превышает потолок для ${userId}`);
      return res.status(413).json({
        error: 'batch_too_large',
        totalBytes,
        maxTotalBytes: MAX_UPLOAD_TOTAL_BYTES,
      });
    }

    // Канал распространения — до шлагбаума (ревью качества 02.11, I5): в
    // магазинной сборке текст остановки не должен упоминать токены/баланс
    // вовсе (правило Apple 3.1.1), и noTokensReply ниже должен это знать.
    // Переиспользуется дальше, в buildUploadHandoff — раньше вычислялся там
    // второй раз тем же вызовом.
    const storeBuild = isStoreBuild(req.headers['x-linkeon-distribution']);

    // Шлагбаум по балансу — тот же, что на обычном ходе чата (chat.service.ts,
    // «Check token balance»). До 06.09.2026 его здесь не было вовсе: загрузка
    // файлов не только не тарифицировалась, но и не спрашивала баланс, то есть
    // пользователь с нулём получал самый дорогой тип хода без ограничений.
    const balance = await this.chatService
      .getTokenBalance(userId)
      .catch(() => 0);
    if (balance <= 0) {
      res.status(200);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Transfer-Encoding', 'chunked');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Accel-Buffering', 'no');
      res.setHeader('Access-Control-Allow-Origin', '*');
      const noTokensMsg = await this.chatService.noTokensReply(
        userId,
        typeof body.lang === 'string' ? body.lang : undefined,
        // upload: файлы этого запроса тоже выброшены — текст должен попросить
        // прикрепить их заново, а не только переслать сообщение (I4).
        { upload: true, storeBuild },
      );
      res.write(JSON.stringify({ type: 'begin' }) + '\n');
      res.write(JSON.stringify({ type: 'item', content: noTokensMsg }) + '\n');
      res.write(JSON.stringify({ type: 'end', content: noTokensMsg, reason: 'no_tokens', usage: { input: 0, output: 0, total: 0 } }) + '\n');
      res.end();
      return;
    }

    let profileText = '';
    if (this.neo4j) {
      try { profileText = await this.neo4j.getProfileDescription(userId); } catch {}
    }

    // «Чистый лист» — как в текстовом ходе (см. `chat`): у режима своя сессия на
    // релее, и файл обязан уехать в неё же. Тело здесь multipart, поэтому флаг
    // приезжает строкой, а не булевым.
    const freshFlag = body.fresh === true || body.fresh === 'true';
    const fresh = freshFlag && /^\d{6,}$/.test(String(body.freshTs || ''));
    const freshSessionId = fresh
      ? `${userId}_${assistantId}_fresh_${body.freshTs}`
      : undefined;

    // Ключ сессии, персона и хвост переписки — те же, что у текстового хода.
    // Отдельная сборка здесь однажды уже разошлась с основной и на три недели
    // увела вложения в собственную сессию (см. relay-session.ts).
    // Что умеет клиент (client-ui.ts). Тело multipart — ui приезжает строкой.
    const ui = parseClientUi(body.ui);

    let handoff = await this.chatService.buildUploadHandoff({
      userId,
      assistantId: String(assistantId),
      profileText,
      freshSessionId,
      requestLang: typeof body.lang === 'string' ? body.lang : undefined,
      ask: ui.ask,
      storeBuild,
      ui,
    });

    // Профиль уехал в systemPrompt вместе с персоной — в тело реплики его
    // больше не клеим: там он оседал копией на каждый ход с файлом.
    const fullMessage = message || 'Проанализируй этот файл';

    const AGENT_URL = process.env.AGENT_URL || 'https://r.linkeon.io';

    // Модель ответов человека — тот же выбор, что у текстового хода
    // (streamUniversalAgent). Проб мониторинга у загрузки нет.
    const answerRoute = await resolveAnswerProvider(false, userId, this.llmProvider);

    // Между сборкой handoff и этой границей были await (персона, история,
    // выбор модели). Проверяем consent здесь, непосредственно перед fd.append:
    // раннего gate в builder недостаточно. Возвращаются согласованные prompt,
    // sessionId и fs_key, поэтому resumed-сессия и папка хода не расходятся.
    handoff = await this.chatService.finalizeUploadHandoffForDispatch(userId, handoff);

    // Исходники — в наше хранилище ДО отправки на релей (chat-uploads,
    // spec 2026-11-13-chat-upload-memory): сбой релея или пустой ответ не
    // должны терять файл. Сбой самого сохранения ход не прерывает: текущий
    // ответ продолжается по прежнему relay-пути, а клиенту ниже уходит
    // событие upload_persist_failed.
    const uploadSessionId = freshSessionId || `${userId}_${assistantId}`;
    let savedUploads: ChatUploadRecord[] = [];
    let uploadPersistFailed = false;
    if (process.env.CHAT_UPLOADS_ENABLED === 'true' && this.chatUploads) {
      const budgetMs = chatUploadsSaveBudgetMs();
      const savePromise = this.chatUploads.saveOriginals({ userId, sessionId: uploadSessionId, files });
      // Проигравший гонку saveOriginals может дорезолвиться (или упасть) уже
      // после бюджета: результат игнорируется, а reject обязан быть погашен,
      // иначе унесём unhandledRejection в уже идущий ответ (ревью I1).
      void savePromise.catch(() => {});
      let budgetTimer: NodeJS.Timeout | undefined;
      try {
        const result = await Promise.race([
          savePromise,
          new Promise<never>((_, reject) => {
            budgetTimer = setTimeout(
              () => reject(new Error(`save budget ${budgetMs}ms exceeded`)),
              budgetMs,
            );
          }),
        ]);
        savedUploads = result.saved;
        uploadPersistFailed = result.failed.length > 0;
      } catch (e: any) {
        // Два случая: бросок до пофайлового цикла (например,
        // createBucketIfAbsent при недоступном MinIO — saveOriginals ловит
        // сбои только внутри цикла) и превышение бюджета. Ход не прерывается:
        // текущий ответ продолжается по прежнему relay-пути.
        this.logger.warn(
          `[upload-and-chat] saveOriginals для ${userId}_${assistantId} не завершилась (${e?.message?.slice(0, 200) || e}), продолжаю без исходников`,
        );
        savedUploads = [];
        uploadPersistFailed = true;
      } finally {
        if (budgetTimer) clearTimeout(budgetTimer);
      }
    }

    // Строка истории о файлах: сохранённые — markdown-ссылкой на приватное
    // скачивание (JWT владельца), несохранённые — прежним именем. При
    // выключенной фиче или пустом saved совпадает с прежней `📎 имена\nсообщение`
    // посимвольно (historyMerge.ts сверяет строки истории).
    const uploadLinks = savedUploads.map(
      (r) => `📎 [${markdownEscapeName(r.originalName)}](${this.chatUploads!.ownerUrl(r.id)})`,
    );
    const failedUploadNames = files
      .filter((f: any) => !savedUploads.some((r) => r.originalName === f.originalname))
      .map((f: any) => f.originalname);
    const userMsgForHistory = [
      ...uploadLinks,
      ...(failedUploadNames.length ? [`📎 ${failedUploadNames.join(', ')}`] : []),
      message,
    ].join('\n');

    // Proxy file + message to remote agent server
    const FormData = require('form-data');
    const axios = require('axios');
    const fd = new FormData();
    // Поле `files` повторяется по разу на файл — так multipart и передаёт
    // список. Агент это поле принимал и раньше, менялся только вход.
    for (const f of files) {
      fd.append('files', f.buffer, { filename: f.originalname, contentType: f.mimetype });
    }
    fd.append('message', fullMessage);
    fd.append('sessionId', handoff.sessionId);
    // Релей всегда передаёт --system-prompt и без нашего поля подставляет свой
    // «universal agent»: в общей с текстовым ходом сессии это подменяло бы
    // персону на каждом ходе с файлом.
    if (handoff.systemPrompt) fd.append('systemPrompt', handoff.systemPrompt);
    // Вставится только при холодном старте сессии — в resumed история уже есть.
    if (handoff.history) fd.append('history', handoff.history);
    // Продукты, поиск файлов и справка — те же поля, что у текстового хода.
    fd.append('products_token', handoff.products.products_token);
    fd.append('products_mcp_url', handoff.products.products_mcp_url);
    // Инструменты Linkeon и папка хода — как у текстового хода (linkeon-relay-fields.ts).
    appendLinkeonFields(fd, handoff.linkeon);
    // Модель (личный выбор или рубильник) — релей сразу идёт к ней (answer-provider.ts).
    for (const [k, v] of Object.entries(relayProviderFields(false, answerRoute.provider))) fd.append(k, v);

    // Set streaming headers
    res.status(200);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Access-Control-Allow-Origin', '*');

    res.write(JSON.stringify({ type: 'begin' }) + '\n');

    const chunks: string[] = [];
    // Файлы хода — копируются к нам после потока (chat-files), см. finally.
    const pendingFiles: RelayOutputFile[] = [];
    let upstreamError: Error | null = null;
    // Расход хода. Релей присылает его в событии `done` с 07.08.2026 — до
    // 06.09.2026 обработчик загрузки эти поля молча выбрасывал, и ход с
    // вложениями был бесплатным (см. persistUploadTurn).
    const agentUsage: SdkUsageTotals = {
      input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, webSearch: 0, webFetch: 0,
    };
    let agentCostUsd = 0;
    // Стоимость самого хода по счёту CLI; хоть один done без неё — неизвестна.
    const agentTurnCost = new RelayTurnCost();
    let turnFailed = false;
    let failReason = '';
    const streamStartTime = Date.now();

    // Если клиент дисконнектился (переключил ассистента), всё равно дочитываем
    // r.linkeon.io до конца и сохраняем ответ в БД — иначе результат теряется.
    // Пинг клиенту на долгом ходе (client-ping.ts): заводится перед запросом
    // к релею, тишину отсчитывает каждая строка, ушедшая через safeWrite.
    let clientPing: ClientPing | null = null;
    const safeWrite = (payload: any) => {
      try { res.write(JSON.stringify(payload) + '\n'); clientPing?.touch(); } catch {}
    };

    // Исходник этого запроса не сохранён — сообщаем клиенту сразу, до начала
    // ответа: в будущих разговорах файл не найдётся (spec «Обработка ошибок»).
    // На сам ответ не влияет: ход продолжается как обычно.
    if (uploadPersistFailed) {
      safeWrite({ type: 'upload_persist_failed', content: 'Файл не сохранён для будущих разговоров' });
    }

    // Открываем ход для activeStreams ДО запроса к релею: deploy.sh ждёт
    // /chat/active-streams === 0 перед рестартом, а копия файлов после потока
    // (chat-files, ниже) занимает до ~60с — без этого ход с вложениями не
    // был виден вовсе, и рестарт мог оборвать именно её.
    this.chatService.beginStream();
    // Ход с вложениями — и в учёт идущих ходов (active-turn): иначе посреди
    // долгого разбора файла кабинет не видит хода, а «?» его пре-эмптит.
    const turnMark = this.chatService.beginUploadTurn(userId, String(assistantId));
    // Закрывает ход ровно один раз. beginStream/endStream раньше были
    // завязаны на то, какая ветка кода ниже доберётся до конца — бросок
    // где-то посреди finally (например, в computeUploadCharge) обходил обе
    // ветки endStream() и навсегда уводил activeStreams в плюс: deploy.sh
    // ждал бы несуществующий ход до собственного таймаута. closeStream
    // вызывается и из setImmediate-колбэка персиста (нормальный путь —
    // после сохранения истории), и из внешнего finally — для любого другого
    // выхода, включая непредвиденный throw. persistDispatched бережёт
    // нормальный путь: внешний finally не должен закрывать ход синхронно,
    // раньше, чем успеет отработать уже запущенный персист.
    let streamClosed = false;
    const closeStream = () => {
      if (streamClosed) return;
      streamClosed = true;
      this.chatService.endStream();
      this.chatService.endUploadTurn(userId, String(assistantId), turnMark);
    };
    let persistDispatched = false;
    // Живой процесс релея этой сессии (relayRunning, ChatService.
    // beginRelayRun/endRelayRun) — тот же ключ relaySid, что и у текстового
    // хода (handoff.sessionId строится relaySessionKey, см. buildUploadHandoff):
    // если текстовое сообщение той же сессии придёт, пока этот процесс ещё жив,
    // оно корректно увидит «тот ход прерван» (interrupted-turn.ts). Открыт
    // вокруг самого вызова релея, закрыт в finally ДО копирования файлов —
    // см. комментарий у объявления relayRunning в chat.service.ts.
    const relayMark = this.chatService.beginRelayRun(handoff.sessionId);
    try {
    // Пинг на весь ход: разбор большого файла и копия файлов хода — ровно те
    // места, где клиенту минутами ничего не уходит. Гасится перед res.end()
    // ниже и страховкой — во внешнем finally.
    clientPing = startClientPing(() => {
      if (!res.writableEnded) safeWrite({ type: 'ping' });
    });
    try {
      const agentRes = await axios.default.post(`${AGENT_URL}/chat`, fd, {
        headers: { ...fd.getHeaders(), ...relayAuthHeaders() },
        responseType: 'stream',
        timeout: 600000,
        maxRedirects: 0,
      });

      await new Promise<void>((resolve) => {
        let buffer = '';
        agentRes.data.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            try {
              const ev = JSON.parse(line.slice(6));
              if (ev.type === 'delta' || ev.type === 'text') {
                chunks.push(ev.text);
                safeWrite({ type: 'item', content: ev.text });
              } else if (ev.type === 'notice' && ev.text) {
                // Служебная реплика платформы — показываем всегда, в отличие от
                // `result` ниже (тот дублировал бы уже отданный текст).
                chunks.push(ev.text);
                safeWrite({ type: 'item', content: ev.text });
              } else if (ev.type === 'tool') {
                // Шаг работы (activity-map.ts): чтение большого PDF — ровно то
                // место, где человек дольше всего смотрит на пустой пузырь.
                if (ui.activity) {
                  const step = toActivity(ev.tool, ev.input, { userId, relaySessionId: handoff.sessionId, fsKey: handoff.linkeon.fs_key });
                  if (step) safeWrite(step);
                }
              } else if (ev.type === 'result' && ev.text && chunks.length === 0) {
                chunks.push(ev.text);
                safeWrite({ type: 'item', content: ev.text });
              } else if (ev.type === 'done') {
                if (ev.failed === true) {
                  turnFailed = true;
                  failReason = typeof ev.failReason === 'string' ? ev.failReason : 'unknown';
                }
                if (typeof ev.costUsd === 'number' && ev.costUsd > 0) agentCostUsd += ev.costUsd;
                agentTurnCost.add(ev);
                if (ev.usage && typeof ev.usage === 'object') {
                  for (const k of Object.keys(agentUsage) as (keyof SdkUsageTotals)[]) {
                    const v = ev.usage[k];
                    if (typeof v === 'number' && v > 0) agentUsage[k] += v;
                  }
                }
                collectOutputFiles(pendingFiles, ev.outputFiles);
              }
            } catch {}
          }
        });
        agentRes.data.on('end', () => resolve());
        agentRes.data.on('error', (err: Error) => { upstreamError = err; resolve(); });
      });
    } catch (err: any) {
      upstreamError = err;
    } finally {
      // Процесс релея этой сессии закончился (поток дочитан или упал) —
      // снимаем метку ДО копирования файлов ниже (до ~60 с): см. комментарий
      // у beginRelayRun выше.
      this.chatService.endRelayRun(handoff.sessionId, relayMark);
      // Ссылки на файлы хода — уже на наше хранилище, до `end` и до истории:
      // одна строка в обоих местах (historyMerge.ts сверяет посимвольно).
      // Здесь, в отличие от текстового хода, они дописываются всегда — так было
      // и до переноса.
      if (pendingFiles.length > 0) {
        // Копия может занять до ~60с (chat-files, PERSIST_TURN_BUDGET_MS) —
        // всё это время от релея клиенту уже ничего не приходит, а мобильный
        // клиент (Flutter) рвёт стрим после 60с тишины. Живым его держит
        // пинг всего хода (clientPing выше).
        try {
          // storeRelayLinks сама не бросает (relay-links.ts), но это гарантия
          // чужого модуля — страхуемся локально: без неё сбой внутри уронил
          // бы весь finally, и клиент не получил бы ни `end`, ни res.end().
          const lines = await this.chatService.storeRelayLinks(outputFileLines(pendingFiles, AGENT_URL), AGENT_URL, { userId });
          const tail = '\n\n' + lines.join('\n');
          chunks.push(tail);
          safeWrite({ type: 'item', content: tail });
        } catch (e: any) {
          // eslint-disable-next-line no-console
          console.warn(`[upload-and-chat] storeRelayLinks упала, ссылка остаётся на релей: ${e?.message}`);
          const tail = '\n\n' + outputFileLines(pendingFiles, AGENT_URL).join('\n');
          chunks.push(tail);
          safeWrite({ type: 'item', content: tail });
        }
      }
      // M5: этот путь (загрузка файла) ни разу не ходит в product-tool и
      // ничего сам не прикрепляет — он только мог ДОНЕСТИ до пользователя
      // то, что модель написала текстом. Модели нельзя доверять печатать
      // ```product-action``` блок самой (тот же приём, что в chat.service.ts,
      // streamUniversalAgent/agentReply): она видит старые блоки в истории
      // и знает actionId из результатов прежних инструментов — скопированный
      // оттуда блок рисует ВТОРУЮ карточку старого, уже решённого действия.
      // Без чистки здесь текст уходил И в `end.content`, И в
      // persistUploadTurn — то есть в историю — как есть.
      const fullText = stripProductActionBlocks(chunks.join(''));

      if (fullText.length > 0) {
        // Индикатор считается тем же методом, что и списание в persistUploadTurn.
        // Раньше здесь стояла длина ответа в символах: пользователь видел «2073
        // токена» за ход, за который не списали ничего.
        const shown = turnFailed
          ? 0
          : this.chatService.computeUploadCharge(agentUsage, agentCostUsd, fullText, agentTurnCost.usd).tokens;
        safeWrite({ type: 'end', content: fullText, usage: { input: 0, output: shown, total: shown } });
      } else if (upstreamError) {
        const errText = 'Ошибка обработки файла. Попробуйте ещё раз.';
        safeWrite({ type: 'item', content: errText });
        safeWrite({ type: 'end', content: errText, usage: { input: 0, output: 0, total: 0 } });
      }
      clientPing?.stop();
      try { res.end(); } catch {}
      // Ответ клиенту уже доставлен — метка хода снимается здесь, а не после
      // persistUploadTurn/consolidateAfterChatPublic ниже (три LLM-вызова
      // подряд, карточка бизнеса — таймаут 120 с): иначе метка висела бы
      // секунды-десятки секунд после ответа, кабинет решал бы, что ассистент
      // ещё работает, и следующее сообщение получало бы ложную
      // INTERRUPTED_TURN_NOTE (ревью Б2 Step 5). У текстового хода
      // (streamUniversalAgent) метка снимается в finally сразу после end —
      // здесь то же самое, только раньше closeStream. Вызов в closeStream
      // остаётся страховкой на случай исключения до этой строки: повторный
      // endUploadTurn с той же меткой — no-op (closeTurn сверяет метку).
      this.chatService.endUploadTurn(userId, String(assistantId), turnMark);

      // Save history — гарантированно, даже если клиент дисконнектился
      // на любом этапе. Запускаем после res.end чтобы не блокировать ответ.
      // С сохранёнными исходниками (chat-uploads) запись обязательна и при
      // пустом ответе: «пустой или упавший ответ ассистента не отменяет
      // сохранение» — ссылка на файл в истории должна остаться. Поведение
      // прежних путей не меняется: без сохранённых исходников персист, как
      // раньше, только при непустом ответе.
      if (fullText.length > 0 || savedUploads.length > 0) {
        persistDispatched = true;
        setImmediate(async () => {
          try {
            await this.chatService.persistUploadTurn({
              userId,
              assistantId,
              userMsg: userMsgForHistory,
              assistantMsg: fullText,
              usage: agentUsage,
              costUsd: agentCostUsd,
              turnCostUsd: agentTurnCost.usd,
              durationMs: Date.now() - streamStartTime,
              turnFailed,
              failReason,
              sessionIdOverride: freshSessionId,
            });
            // Обогащаем профиль (Neo4j) на основе явных самораскрытий/согласий пользователя.
            // Файловые загрузки раньше не вызывали consolidate — теперь учитываются.
            // Пустой ответ — не материал для обучения профиля: LLM-вызов
            // только при тексте ассистента (в частности, при записи хода
            // с пустым ответом ради ссылки на файл — не зовём).
            if (fullText.length > 0) {
              await this.chatService.consolidateAfterChatPublic(
                userId,
                assistantId,
                userMsgForHistory,
                fullText,
              );
            }
          } catch (e: any) {
            // eslint-disable-next-line no-console
            console.warn(`[upload-and-chat] persist failed for ${userId}_${assistantId}: ${e?.message}`);
          } finally {
            // Ход занят до сохранения истории, а не до res.end(): deploy.sh
            // не должен рестартовать между концом ответа и записью в БД.
            closeStream();
          }
        });
      } else {
        // Нечего сохранять (пустой ответ без текста и без файлов) — ход
        // закрывается сразу, без setImmediate-ветки выше.
        closeStream();
      }
    }
    } finally {
      // Безопасная сеть: срабатывает для любого выхода, который не успел
      // поставить persistDispatched (в т.ч. throw выше) — сам ход к этому
      // моменту уже не персистится, держать activeStreams незачем. Для
      // нормального пути с персистом ничего не делает: closeStream там
      // вызовется позже, из setImmediate, когда история и правда сохранится.
      if (!persistDispatched) closeStream();
      clientPing?.stop();
    }
  }

  @Get('chat/history')
  @UseGuards(JwtGuard)
  async getHistory(@CurrentUser() user: any, @Query('assistantId') assistantId: string, @Query('limit') limit: string, @Query('offset') offset: string, @Query('freshTs') freshTs: string, @Res() res: Response) {
    // freshTs: история fresh-сессии «чистого листа» (переживает F5 на фронте).
    const sessionOverride = freshTs && /^\d{6,}$/.test(freshTs)
      ? `${user.userId}_${assistantId}_fresh_${freshTs}`
      : undefined;
    const history = await this.chatService.getChatHistory(user.userId, assistantId, parseInt(limit) || 30, parseInt(offset) || 0, sessionOverride);
    return res.status(200).json(history);
  }

  @Delete('chat/history')
  @UseGuards(JwtGuard)
  async deleteHistory(@CurrentUser() user: any, @Query('assistantId') assistantId: string, @Res() res: Response) {
    const result = await this.chatService.deleteChatHistory(user.userId, assistantId);
    return res.status(200).json(result);
  }

  @Post('scan-document')
  @UseGuards(JwtGuard)
  async scanDocument(@CurrentUser() user: any, @Req() req: Request, @Res() res: Response) {
    let cwd: string | null = null;
    try {
      // Handle multipart file upload via multer
      const multer = require('multer');
      const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
      await new Promise<void>((resolve, reject) => {
        upload.single('file')(req as any, res as any, (err: any) => {
          if (err) reject(err);
          else resolve();
        });
      });

      const file = (req as any).file;
      if (!file) return res.status(400).json({ error: 'No file uploaded' });

      // Записываем загруженный файл в одноразовый cwd, разрешаем Read tool —
      // SDK прочитает PDF/изображение нативно через vision Claude.
      cwd = path.join(os.tmpdir(), `scan-${crypto.randomUUID()}`);
      await fsp.mkdir(cwd, { recursive: true });
      const safeName = (file.originalname || 'document.pdf').replace(/[^\w.\-]/g, '_');
      const filePath = path.join(cwd, safeName);
      await fsp.writeFile(filePath, file.buffer);

      let collected = '';
      // safeName уже очищен от не-[\w.\-], @ в нём быть не может; обезвреживание
      // @-упоминаний здесь — защита на будущее и единый инвариант для всех
      // SDK-вызовов (см. статический сторож).
      for await (const event of query({
        prompt: neutralizeAtMentions(`Прочитай файл ${safeName} инструментом Read, указав ровно относительное имя "${safeName}" (файл лежит в текущей рабочей директории; НЕ добавляй ведущий слэш и не придумывай другой путь), и извлеки профиль пользователя. Верни ТОЛЬКО JSON без markdown-обёрток:
{"name":"Имя","family_name":"Фамилия","profile":["факты"],"values":["ценности"],"skills":["навыки"],"beliefs":["убеждения"],"desires":["желания"],"interests":["интересы"],"search":["что ищет"]}`),
        options: {
          model: 'claude-haiku-4-5',
          cwd,
          // Безопасность (25.09.2026). Содержимое файла — НЕДОВЕРЕННОЕ: результат
          // разбора уходит в профиль пользователя, поэтому инструкция внутри
          // файла может попытаться увести модель на чтение чужого пути. Раньше
          // стоял bypassPermissions — он снимает ВСЕ проверки, и хотя тут только
          // Read, модель могла прочитать ~/spirits_back/.env (процесс API идёт
          // под владельцем .env). Теперь:
          //   • `tools: ['Read']` — единственный доступный тул (нужен, чтобы SDK
          //     нативно открыл PDF/картинку);
          //   • `permissionMode: 'default'` вместо bypass — на каждый Read зовётся
          //     canUseTool;
          //   • страж makeReadWithinDirGuard(cwd) пускает Read ТОЛЬКО по путям,
          //     чей realpath внутри одноразового cwd (симлинк наружу и
          //     несуществующий путь — отказ). cwd за пределами каталога бэкенда.
          tools: ['Read'],
          permissionMode: 'default',
          canUseTool: makeReadWithinDirGuard(cwd),
          settingSources: [],
        } as any,
      })) {
        if (event.type === 'assistant') {
          for (const block of ((event as any).message?.content || []) as any[]) {
            if (block.type === 'text') collected += block.text;
          }
        }
      }

      let text = stripWordJoiner(collected).trim();
      if (text.includes('```')) {
        text = text.replace(/^[\s\S]*?```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
      }
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return res.status(200).json({ output: { profile: [collected] } });
      const parsed = JSON.parse(jsonMatch[0]);
      return res.status(200).json({ output: parsed });
    } catch (e: any) {
      console.error('scan-document error:', e);
      return res.status(500).json({ error: e.message || 'Document parsing failed' });
    } finally {
      if (cwd) {
        await fsp.rm(cwd, { recursive: true, force: true }).catch(() => {});
      }
    }
  }
}
