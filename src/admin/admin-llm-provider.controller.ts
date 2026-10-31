import { Body, Controller, Get, Logger, Param, Post, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { JwtGuard } from '../common/guards/jwt.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import { LLM_PROVIDERS, LlmProvider, UserLlmProviderService } from '../common/services/user-llm-provider.service';
import { readFallbackConfigs } from '../common/services/llm-fallback';

/**
 * Модель ответов ассистентов по аккаунту (spec 2026-10-30-llm-provider-switch,
 * 2026-10-31-kimi-provider-design). :userId — тот же идентификатор, что у
 * /webhook/admin/users/:phone/activity (телефон или UUID входа по почте).
 * configured — задан ли ключ запасного на бэкенде, по каждому: без него выбор
 * молча работает как Claude. qwenConfigured — прежнее поле для фронта до выката.
 */
@Controller('')
@UseGuards(JwtGuard, AdminGuard)
export class AdminLlmProviderController {
  private readonly logger = new Logger(AdminLlmProviderController.name);

  constructor(private readonly providers: UserLlmProviderService) {}

  @Get('admin/users/:userId/llm-provider')
  async get(@Param('userId') userId: string, @Res() res: Response) {
    const provider = await this.providers.get(userId);
    return res.status(200).json(this.body(userId, provider));
  }

  @Post('admin/users/:userId/llm-provider')
  async set(
    @Param('userId') userId: string,
    @CurrentUser() user: any,
    @Body() body: any,
    @Res() res: Response,
  ) {
    const provider = String(body?.provider ?? '') as LlmProvider;
    if (!LLM_PROVIDERS.includes(provider)) {
      return res.status(400).json({ error: `provider: ${LLM_PROVIDERS.map((p) => `'${p}'`).join(' | ')}` });
    }
    if (!(await this.providers.set(userId, provider))) {
      return res.status(404).json({ error: 'user not found' });
    }
    // Смена модели ответов тратит квоту владельца — оставляем след: кто и
    // кого переключил.
    const actor = user?.userId ?? 'unknown';
    this.logger.log(`llm_provider: ${actor} → ${userId} = ${provider}`);
    return res.status(200).json(this.body(userId, provider));
  }

  private body(userId: string, provider: LlmProvider) {
    const configs = readFallbackConfigs();
    const configured = { qwen: configs.qwen !== null, kimi: configs.kimi !== null };
    return { userId, provider, qwenConfigured: configured.qwen, configured };
  }
}
