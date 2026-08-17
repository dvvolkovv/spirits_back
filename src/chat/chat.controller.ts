import { Controller, Post, Get, Delete, Body, Query, Req, Res, UseGuards, Optional } from '@nestjs/common';
import { Request, Response } from 'express';
import { ChatService } from './chat.service';
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
import { decodeMultipartFilename } from '../common/utils/multipart-filename';

/**
 * Потолок загрузки, ОДИН на всю цепочку. Раньше каждое звено держало свой, и
 * пользователь получал голый 413 с надписью «не удалось обработать файл»:
 * 11.08 она трижды пыталась отправить 56–61 МБ сканов и трижды упиралась в
 * стену без объяснения.
 *
 * Узким местом был НЕ наш nginx, а Selectel-прокси 92.53.64.147, через который
 * обязан ходить весь трафик РФ: у него стоял свой `client_max_body_size 50m`.
 * 11.08 подняты оба слоя до 120m и замерено через прокси: 55 и 100 МБ проходят,
 * 130 МБ → 413. 100 МБ здесь — это 120m минус запас на служебные поля multipart.
 *
 * Менять это число можно только вместе с ОБОИМИ nginx: origin
 * (/etc/nginx/conf.d/upload.conf) и edge (sites-enabled/my.linkeon.io на
 * 92.53.64.147). Завысить его хуже, чем не иметь вовсе: проверка пропустит
 * пачку, а nginx отобьёт её немым 413 — тем самым, от которого мы уходили.
 */
export const MAX_UPLOAD_TOTAL_BYTES = 100 * 1024 * 1024;
export const MAX_UPLOAD_FILE_BYTES = 100 * 1024 * 1024;

@Controller('')
export class ChatController {
  constructor(
    private readonly chatService: ChatService,
    private readonly jwtSvc: JwtService,
    @Optional() private readonly neo4j: Neo4jService,
    @Optional() private readonly events?: EventsService,
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
    const distribution = String(req.headers['x-linkeon-distribution'] || '').toLowerCase();
    const storeBuild = distribution === 'appstore' || distribution === 'play';
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

    let profileText = '';
    if (this.neo4j) {
      try { profileText = await this.neo4j.getProfileDescription(userId); } catch {}
    }

    // Build message with profile context
    let fullMessage = '';
    if (profileText && profileText.trim()) {
      fullMessage += `User profile:\n${profileText}\n\n`;
    }
    fullMessage += message || 'Проанализируй этот файл';

    const AGENT_URL = process.env.AGENT_URL || 'https://r.linkeon.io';

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
    fd.append('sessionId', `${userId}_${assistantId}`);

    // Set streaming headers
    res.status(200);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Access-Control-Allow-Origin', '*');

    res.write(JSON.stringify({ type: 'begin' }) + '\n');

    const chunks: string[] = [];
    let upstreamError: Error | null = null;

    // Если клиент дисконнектился (переключил ассистента), всё равно дочитываем
    // r.linkeon.io до конца и сохраняем ответ в БД — иначе результат теряется.
    const safeWrite = (payload: any) => {
      try { res.write(JSON.stringify(payload) + '\n'); } catch {}
    };

    try {
      const agentRes = await axios.default.post(`${AGENT_URL}/chat`, fd, {
        headers: fd.getHeaders(),
        responseType: 'stream',
        timeout: 600000,
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
              } else if (ev.type === 'result' && ev.text && chunks.length === 0) {
                chunks.push(ev.text);
                safeWrite({ type: 'item', content: ev.text });
              } else if (ev.type === 'done' && ev.outputFiles?.length > 0) {
                const fileLinks = ev.outputFiles
                  .map((f: any) => `[Скачать ${f.name}](${AGENT_URL}${f.url})`)
                  .join('\n');
                if (fileLinks) {
                  chunks.push('\n\n' + fileLinks);
                  safeWrite({ type: 'item', content: '\n\n' + fileLinks });
                }
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
      const fullText = chunks.join('');

      if (fullText.length > 0) {
        safeWrite({ type: 'end', content: fullText, usage: { input: 0, output: fullText.length, total: fullText.length } });
      } else if (upstreamError) {
        const errText = 'Ошибка обработки файла. Попробуйте ещё раз.';
        safeWrite({ type: 'item', content: errText });
        safeWrite({ type: 'end', content: errText, usage: { input: 0, output: 0, total: 0 } });
      }
      try { res.end(); } catch {}

      // Save history — гарантированно, даже если клиент дисконнектился
      // на любом этапе. Запускаем после res.end чтобы не блокировать ответ.
      if (fullText.length > 0) {
        // Все имена в одну строку: при группе файлов в истории должно быть
        // видно, что именно присылали, а не только первый из них.
        const names = files.map((f: any) => f.originalname).join(', ');
        const userMsgForHistory = `📎 ${names}\n${message}`;
        setImmediate(async () => {
          try {
            await this.chatService.saveChatHistoryPublic(
              userId,
              assistantId,
              userMsgForHistory,
              fullText,
              fullText.length,
            );
            // Обогащаем профиль (Neo4j) на основе явных самораскрытий/согласий пользователя.
            // Файловые загрузки раньше не вызывали consolidate — теперь учитываются.
            await this.chatService.consolidateAfterChatPublic(
              userId,
              assistantId,
              userMsgForHistory,
              fullText,
            );
          } catch (e: any) {
            // eslint-disable-next-line no-console
            console.warn(`[upload-and-chat] persist failed for ${userId}_${assistantId}: ${e?.message}`);
          }
        });
      }
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
      for await (const event of query({
        prompt: `Прочитай файл ${safeName} (он в текущей директории) и извлеки профиль пользователя. Верни ТОЛЬКО JSON без markdown-обёрток:
{"name":"Имя","family_name":"Фамилия","profile":["факты"],"values":["ценности"],"skills":["навыки"],"beliefs":["убеждения"],"desires":["желания"],"interests":["интересы"],"search":["что ищет"]}`,
        options: {
          model: 'claude-haiku-4-5',
          cwd,
          allowedTools: ['Read'],
          permissionMode: 'bypassPermissions',
          settingSources: [],
        } as any,
      })) {
        if (event.type === 'assistant') {
          for (const block of ((event as any).message?.content || []) as any[]) {
            if (block.type === 'text') collected += block.text;
          }
        }
      }

      let text = collected.trim();
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
