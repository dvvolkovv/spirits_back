import { Controller, Post, Get, Delete, Body, Query, Req, Res, UseGuards, Optional } from '@nestjs/common';
import { Request, Response } from 'express';
import { ChatService } from './chat.service';
import { JwtGuard } from '../common/guards/jwt.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import { JwtService } from '../common/services/jwt.service';
import { Neo4jService } from '../neo4j/neo4j.service';
import * as fs from 'fs';

@Controller('')
export class ChatController {
  constructor(
    private readonly chatService: ChatService,
    private readonly jwtSvc: JwtService,
    @Optional() private readonly neo4j: Neo4jService,
  ) {}

  @Post('soulmate/chat')
  async chat(@Req() req: Request, @Res() res: Response) {
    // Auth: check Bearer but don't throw (auth inside workflow behavior)
    const authHeader = req.headers['authorization'];
    let userId: string | null = null;
    if (authHeader?.startsWith('Bearer ')) {
      try {
        const payload = this.jwtSvc.verify(authHeader.substring(7));
        if (payload.type === 'access') userId = payload.phone;
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

    await this.chatService.streamChat(
      userId,
      message,
      String(assistantId),
      sessionId || `${userId}_${assistantId}`,
      profileText,
      res,
      req,
    );
  }

  @Post('agent/upload-and-chat')
  async uploadAndChat(@Req() req: Request, @Res() res: Response) {
    const authHeader = req.headers['authorization'];
    let userId: string | null = null;
    if (authHeader?.startsWith('Bearer ')) {
      try {
        const payload = this.jwtSvc.verify(authHeader.substring(7));
        if (payload.type === 'access') userId = payload.phone;
      } catch {}
    }
    if (!userId) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.status(200).send('');
    }

    const multer = require('multer');
    const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

    await new Promise<void>((resolve, reject) => {
      upload.single('file')(req as any, res as any, (err: any) => {
        if (err) reject(err);
        else resolve();
      });
    });

    const file = (req as any).file;
    const body = (req as any).body || {};
    const message = body.message || body.task || '';
    const assistantId = body.assistantId || 'Роман';

    if (!file) return res.status(400).json({ error: 'No file uploaded' });

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
    fd.append('files', file.buffer, { filename: file.originalname, contentType: file.mimetype });
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
        const userMsgForHistory = `📎 ${file.originalname}\n${message}`;
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
  async getHistory(@CurrentUser() user: any, @Query('assistantId') assistantId: string, @Query('limit') limit: string, @Query('offset') offset: string, @Res() res: Response) {
    const history = await this.chatService.getChatHistory(user.phone, assistantId, parseInt(limit) || 30, parseInt(offset) || 0);
    return res.status(200).json(history);
  }

  @Delete('chat/history')
  @UseGuards(JwtGuard)
  async deleteHistory(@CurrentUser() user: any, @Query('assistantId') assistantId: string, @Res() res: Response) {
    const result = await this.chatService.deleteChatHistory(user.phone, assistantId);
    return res.status(200).json(result);
  }

  @Post('scan-document')
  @UseGuards(JwtGuard)
  async scanDocument(@CurrentUser() user: any, @Req() req: Request, @Res() res: Response) {
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) return res.status(500).json({ error: 'LLM not configured' });

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

      const base64 = file.buffer.toString('base64');
      const mediaType = file.mimetype || 'application/pdf';
      const filename = file.originalname || 'document.pdf';

      const Anthropic = require('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey: anthropicKey });
      const msg = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4096,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: mediaType, data: base64 },
            },
            {
              type: 'text',
              text: `Проанализируй этот документ (${filename}) и извлеки профиль пользователя. Верни ТОЛЬКО JSON:
{"name":"Имя","family_name":"Фамилия","profile":["факты"],"values":["ценности"],"skills":["навыки"],"beliefs":["убеждения"],"desires":["желания"],"interests":["интересы"],"search":["что ищет"]}`,
            },
          ],
        }],
      });

      let text = msg.content?.[0]?.text || '';
      if (text.includes('```')) text = text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
      // Find JSON in response
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return res.status(200).json({ output: { profile: [text] } });
      const parsed = JSON.parse(jsonMatch[0]);
      return res.status(200).json({ output: parsed });
    } catch (e) {
      console.error('scan-document error:', e);
      return res.status(500).json({ error: e.message || 'Document parsing failed' });
    }
  }
}
