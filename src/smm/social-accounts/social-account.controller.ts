// src/smm/social-accounts/social-account.controller.ts
import {
  Body, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, Post,
  Req, UseGuards, UsePipes, ValidationPipe, BadRequestException,
} from '@nestjs/common';
import { JwtGuard } from '../../common/guards/jwt.guard';
import { SocialAccountService } from './social-account.service';
import { CreateTelegramAccountDto } from './social-account.dto';
import { IpRateLimiter } from '../../common/guards/ip-rate-limit';
import axios from 'axios';

@Controller('smm/social-accounts')
@UseGuards(JwtGuard)
@UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
export class SocialAccountController {
  constructor(
    private readonly accounts: SocialAccountService,
    private readonly limiter: IpRateLimiter,
  ) {}

  @Get()
  async list(@Req() req: any) {
    const rows = await this.accounts.listForUser(req.user.userId);
    // Don't return credentials field — leak prevention
    return rows.map((a) => ({
      id: a.id,
      platform: a.platform,
      displayName: a.displayName,
      status: a.status,
      createdAt: a.createdAt,
    }));
  }

  @Post('telegram')
  async createTelegram(@Req() req: any, @Body() dto: CreateTelegramAccountDto) {
    await this.limiter.check(req.user.userId, 'smm_social_create', 10, 3600);
    // Validate bot token by calling Telegram getMe
    let displayName = dto.displayName;
    try {
      const r = await axios.get(`https://api.telegram.org/bot${dto.botToken}/getMe`, { timeout: 10000 });
      if (!r.data?.ok || !r.data?.result?.username) {
        throw new BadRequestException(`getMe response invalid`);
      }
      displayName ??= `@${r.data.result.username} → ${dto.chatId}`;
    } catch (e: any) {
      throw new BadRequestException(`Invalid bot token: ${e.message}`);
    }
    // Optional: verify the bot can post to the chat by calling getChat
    try {
      await axios.get(`https://api.telegram.org/bot${dto.botToken}/getChat`, {
        params: { chat_id: dto.chatId }, timeout: 10000,
      });
    } catch (e: any) {
      throw new BadRequestException(`Cannot access chat ${dto.chatId}: ${e.message}`);
    }

    const finalDisplayName: string = displayName ?? `${dto.chatId}`;
    const account = await this.accounts.create({
      userId: req.user.userId,
      platform: 'telegram',
      displayName: finalDisplayName,
      credentialsPlain: { botToken: dto.botToken, chatId: dto.chatId },
      expiresAt: null,
    });
    return { id: account.id, displayName: account.displayName, platform: 'telegram' };
  }

  @Delete(':id')
  async remove(@Req() req: any, @Param('id') id: string) {
    const acc = await this.accounts.findById(id);
    if (!acc) throw new NotFoundException(`account ${id}`);
    if (acc.userId !== req.user.userId) throw new ForbiddenException();
    const ok = await this.accounts.deleteById(id);
    return { ok };
  }
}
