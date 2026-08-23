import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { JwtGuard } from '../common/guards/jwt.guard';
import { VoiceImproveService } from './voice-improve.service';

/**
 * Голосовые вспомогательные операции. `POST /webhook/voice/improve` — «причесать» надиктованный текст
 * (пунктуация/падежи) внешним ИИ. Вызывается клиентом ТОЛЬКО по явному согласию пользователя (кнопка
 * «Улучшить» + предупреждение о внешней обработке). Возвращает {text}; при сбое — исходный текст.
 */
@Controller('voice')
export class VoiceController {
  constructor(private readonly improveService: VoiceImproveService) {}

  @Post('improve')
  @UseGuards(JwtGuard)
  async improve(@Body() body: { text?: string }) {
    const text = await this.improveService.improve(String(body?.text || ''));
    return { text };
  }
}
