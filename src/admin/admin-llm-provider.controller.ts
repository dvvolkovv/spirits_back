import { Body, Controller, Get, Logger, Param, Post, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { JwtGuard } from '../common/guards/jwt.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import { AnswerRoute, LLM_CHOICES, LlmChoice, UserLlmProviderService, isLlmChoice } from '../common/services/user-llm-provider.service';
import { GlobalLlmProviderService } from '../common/services/global-llm-provider.service';
import { AnswerProvider, readFallbackConfigs } from '../common/services/llm-fallback';

/**
 * Модель ответов ассистентов по аккаунту (spec 2026-10-30-llm-provider-switch,
 * 2026-10-31-global-llm-switch). :userId — тот же идентификатор, что у
 * /webhook/admin/users/:phone/activity (телефон или UUID входа по почте).
 * provider — личный выбор ('default' — «Как у всех»); effective — чем человек
 * отвечает сейчас с учётом рубильника и ключей; global — модель рубильника
 * (для подписи «Как у всех (сейчас: …)»). qwenConfigured — прежнее поле.
 */
@Controller('')
@UseGuards(JwtGuard, AdminGuard)
export class AdminLlmProviderController {
  private readonly logger = new Logger(AdminLlmProviderController.name);

  constructor(
    private readonly providers: UserLlmProviderService,
    // Без @Optional(): карточка не должна молча остаться без effective/global,
    // если граф DI не нашёл GlobalLlmProviderService — Nest считает
    // зависимость обязательной и валит старт при поломке графа (ловит smoke
    // на test, а не тишина на проде), та же логика, что у
    // UserLlmProviderService.globalProvider (spec 2026-10-31-global-llm-switch).
    // TS-опциональность (?) сохранена ради юнит-тестов: они создают
    // контроллер через `new` с одним аргументом. Сторож типа —
    // design:paramtypes в admin-llm-provider.controller.spec.ts.
    private readonly global?: GlobalLlmProviderService,
  ) {}

  @Get('admin/users/:userId/llm-provider')
  async get(@Param('userId') userId: string, @Res() res: Response) {
    const choice = await this.providers.get(userId);
    return res.status(200).json(await this.body(userId, choice, await this.providers.route(userId)));
  }

  @Post('admin/users/:userId/llm-provider')
  async set(
    @Param('userId') userId: string,
    @CurrentUser() user: any,
    @Body() body: any,
    @Res() res: Response,
  ) {
    const choice = String(body?.provider ?? '');
    if (!isLlmChoice(choice)) {
      return res.status(400).json({ error: `provider: ${LLM_CHOICES.map((p) => `'${p}'`).join(' | ')}` });
    }
    if (!(await this.providers.set(userId, choice))) {
      return res.status(404).json({ error: 'user not found' });
    }
    // Смена модели ответов тратит квоту владельца — оставляем след: кто и
    // кого переключил.
    const actor = user?.userId ?? 'unknown';
    this.logger.log(`llm_provider: ${actor} → ${userId} = ${choice}`);
    return res.status(200).json(await this.body(userId, choice, await this.providers.route(userId)));
  }

  private async body(userId: string, choice: LlmChoice, route: AnswerRoute) {
    const configs = readFallbackConfigs();
    const configured = { qwen: configs.qwen !== null, kimi: configs.kimi !== null };
    const usable = (p: AnswerProvider) => p === 'claude' || configured[p];
    const global: AnswerProvider = this.global ? await this.global.get() : 'claude';
    return {
      userId,
      provider: choice,
      effective: usable(route.provider) ? route.provider : 'claude',
      global,
      qwenConfigured: configured.qwen,
      configured,
    };
  }
}
