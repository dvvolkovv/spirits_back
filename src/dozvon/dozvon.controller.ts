import {
  Controller, Get, Post, Delete, Param, Body, Res,
  UseGuards, ParseIntPipe, BadRequestException,
} from '@nestjs/common';
import { Response } from 'express';
import { DozvonService } from './dozvon.service';
import { DozvonChatService } from './dozvon-chat.service';
import { JwtGuard } from '../common/guards/jwt.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { CurrentUser } from '../common/decorators/user.decorator';

@Controller('dozvon')
@UseGuards(JwtGuard, AdminGuard)
export class DozvonController {
  constructor(
    private readonly dozvon: DozvonService,
    private readonly chat: DozvonChatService,
  ) {}

  // ─── CAMPAIGNS (= threads) ──────────────────────────────────────

  @Get('campaigns')
  list(@CurrentUser() user: any) {
    return this.dozvon.getCampaigns(user.phone);
  }

  @Post('campaigns')
  create(@CurrentUser() user: any, @Body() body: { title?: string; task_text?: string }) {
    return this.dozvon.createCampaign(user.phone, body || {});
  }

  @Get('campaigns/:id')
  get(@CurrentUser() user: any, @Param('id', ParseIntPipe) id: number) {
    return this.dozvon.getCampaign(user.phone, id);
  }

  @Delete('campaigns/:id')
  remove(@CurrentUser() user: any, @Param('id', ParseIntPipe) id: number) {
    return this.dozvon.deleteCampaign(user.phone, id);
  }

  // ─── CHAT (planning dialog) ─────────────────────────────────────

  @Get('campaigns/:id/history')
  async history(@CurrentUser() user: any, @Param('id', ParseIntPipe) id: number) {
    await this.dozvon.getCampaign(user.phone, id); // ACL — 404/forbidden если чужая
    return this.chat.getHistory(id);
  }

  @Post('campaigns/:id/chat')
  async sendMessage(
    @CurrentUser() user: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { message: string },
    @Res() res: Response,
  ) {
    if (!body?.message?.trim()) throw new BadRequestException('message is required');
    await this.dozvon.getCampaign(user.phone, id);
    await this.chat.streamChat(id, body.message.trim(), res);
  }

  // ─── EXECUTE ────────────────────────────────────────────────────

  @Post('campaigns/:id/execute')
  execute(@CurrentUser() user: any, @Param('id', ParseIntPipe) id: number) {
    return this.dozvon.executeCampaign(user.phone, id);
  }

  // ─── PRICING ────────────────────────────────────────────────────

  @Get('pricing')
  pricing() {
    return this.dozvon.getPricing();
  }
}
