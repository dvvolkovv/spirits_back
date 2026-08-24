import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { JwtGuard } from '../common/guards/jwt.guard';
import { CleanAskService } from './clean-ask.service';

/**
 * «Поговорить начисто» [owner 2026-08-24]. POST /webhook/ask {text} → ответ облачного LLM БЕЗ
 * привязки к пользователю: без профиля, без истории, эфемерная сессия релея.
 *
 * JWT нужен ТОЛЬКО чтобы закрыть эндпоинт от посторонних — идентичность в промпт/провайдер не
 * попадает, содержимое запроса нигде не сохраняется. Токены v1 НЕ списываются (доведём при
 * продуктизации); ответ не пишется в custom_chat_history.
 */
@Controller('ask')
export class AskController {
  constructor(private readonly clean: CleanAskService) {}

  @Post()
  @UseGuards(JwtGuard)
  async ask(@Body() body: { text?: string; context?: string; history?: Array<{ role?: string; content?: string }> }) {
    const text = String(body?.text ?? '').trim();
    if (!text) return { ok: false, error: 'Пустой вопрос' };
    // context — уже обезличенный на устройстве (Egress). Реле не трогает его и не подмешивает профиль.
    const context = String(body?.context ?? '').trim();
    const history = Array.isArray(body?.history) ? body!.history!.slice(-12) : undefined; // последние ходы
    try {
      const answer = await this.clean.ask(text, context, history);
      return { ok: true, answer };
    } catch (e: any) {
      return { ok: false, error: 'Не удалось получить ответ' };
    }
  }
}
