import { Body, Controller, Delete, Get, Param, Patch, Post, Res, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { Response } from 'express';
import { JwtGuard } from '../common/guards/jwt.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import { TgIdentityService } from './tg-identity.service';
import { TgConfigService, TgBotConfigRow } from './tg-config.service';
import { CreateBotConfigDto, UpdateBotConfigDto } from './tg-bot.dto';

@Controller('tg-bot')
@UseGuards(JwtGuard)
@UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
export class TgBotConfigController {
  constructor(
    private readonly identity: TgIdentityService,
    private readonly configs: TgConfigService,
  ) {}

  @Get('identity-status')
  async identityStatus(@CurrentUser() user: any, @Res() res: Response) {
    const id = await this.identity.getIdentityByLinkeonId(user.userId);
    if (!id) return res.status(200).json({ bound: false });
    return res.status(200).json({ bound: true, tgUsername: id.tgUsername, tgFirstName: id.tgFirstName });
  }

  @UseGuards(AdminGuard)
  @Post('identity-link')
  async identityLink(@CurrentUser() user: any, @Res() res: Response) {
    const token = await this.identity.createAuthToken(user.userId);
    const botUsername = process.env.TG_BOT_USERNAME || 'LinkeonAgentBot';
    return res.status(200).json({ token, deepLink: `https://t.me/${botUsername}?start=${token}` });
  }

  @Get('configs')
  async list(@CurrentUser() user: any, @Res() res: Response) {
    const rows = await this.configs.listForOwner(user.userId);
    return res.status(200).json(rows.map(this.toJson));
  }

  @UseGuards(AdminGuard)
  @Post('configs')
  async create(@CurrentUser() user: any, @Body() dto: CreateBotConfigDto, @Res() res: Response) {
    const result = await this.configs.createPending(user.userId, dto);
    return res.status(201).json({
      config: this.toJson(result.config),
      claimToken: result.claimToken,
      deepLink: result.deepLink,
    });
  }

  @Get('configs/:id')
  async detail(@CurrentUser() user: any, @Param('id') id: string, @Res() res: Response) {
    const cfg = await this.configs.getById(id, user.userId);
    return res.status(200).json(this.toJson(cfg));
  }

  @UseGuards(AdminGuard)
  @Patch('configs/:id')
  async update(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() dto: UpdateBotConfigDto,
    @Res() res: Response,
  ) {
    const cfg = await this.configs.update(id, user.userId, dto);
    return res.status(200).json(this.toJson(cfg));
  }

  @UseGuards(AdminGuard)
  @Delete('configs/:id')
  async remove(@CurrentUser() user: any, @Param('id') id: string, @Res() res: Response) {
    await this.configs.archive(id, user.userId);
    return res.status(200).json({ ok: true });
  }

  @Get('configs/:id/messages')
  async messages(@CurrentUser() user: any, @Param('id') id: string, @Res() res: Response) {
    const rows = await this.configs.getMessagesForConfig(id, user.userId);
    return res.status(200).json(rows);
  }

  private toJson = (cfg: TgBotConfigRow) => ({
    id: cfg.id,
    tgChatId: cfg.tg_chat_id ? String(cfg.tg_chat_id) : null,
    tgChatTitle: cfg.tg_chat_title,
    displayName: cfg.display_name,
    presetAgentId: cfg.preset_agent_id,
    customAgentId: cfg.custom_agent_id,
    addressingMode: cfg.addressing_mode,
    voiceReplyMode: cfg.voice_reply_mode,
    status: cfg.status,
    lastReplyAt: cfg.last_reply_at,
    createdAt: cfg.created_at,
    archivedAt: cfg.archived_at,
  });
}
