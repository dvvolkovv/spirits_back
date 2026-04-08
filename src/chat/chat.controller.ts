import { Controller, Post, Get, Delete, Body, Query, Req, Res, UseGuards, Optional } from '@nestjs/common';
import { Request, Response } from 'express';
import { ChatService } from './chat.service';
import { JwtGuard } from '../common/guards/jwt.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import { JwtService } from '../common/services/jwt.service';
import { Neo4jService } from '../neo4j/neo4j.service';

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
    );
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
  async scanDocument(@CurrentUser() user: any, @Body() body: any, @Res() res: Response) {
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) return res.status(500).json({ error: 'LLM not configured' });

    const { content, filename } = body;
    if (!content) return res.status(400).json({ error: 'Missing content' });

    try {
      const Anthropic = require('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey: anthropicKey });
      const msg = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4096,
        messages: [{
          role: 'user',
          content: `Проанализируй следующий документ и извлеки профиль пользователя в JSON формате:
{
  "name": "Имя",
  "family_name": "Фамилия",
  "profile": ["ключевые факты"],
  "values": ["ценности"],
  "skills": ["навыки"],
  "beliefs": ["убеждения"],
  "desires": ["желания"],
  "interests": ["интересы"],
  "search": ["что ищет"]
}

Документ (${filename || 'document'}):
${content}`
        }],
      });
      let text = msg.content?.[0]?.text || '';
      if (text.startsWith('```')) text = text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
      const parsed = JSON.parse(text);
      return res.status(200).json(parsed);
    } catch (e) {
      return res.status(500).json({ error: e.message || 'Document parsing failed' });
    }
  }
}
