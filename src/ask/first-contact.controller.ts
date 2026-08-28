import { Body, Controller, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { CleanAskService } from './clean-ask.service';
import { IpRateLimiter } from '../common/guards/ip-rate-limit';

/**
 * Первый контакт (знакомство с Романом) [spec 2026-08-27-first-contact-experience].
 *
 * ⚠️ ПУБЛИЧНЫЙ (без JwtGuard) — знакомство и момент-отклик даются ДО входа (payoff-before-login),
 * поэтому токена нет. Ничего не сохраняется (эфемерно, как /webhook/ask). Против злоупотребления
 * (эндпоинт зовёт общий Claude-аккаунт): IP-rate-limit + кап на число реплик и длину.
 */
@Controller('first-contact')
export class FirstContactController {
  constructor(
    private readonly clean: CleanAskService,
    private readonly rl: IpRateLimiter,
  ) {}

  @Post()
  async firstContact(
    @Req() req: Request,
    @Body() body: { messages?: Array<{ from?: string; text?: string }>; finish?: boolean },
  ) {
    const ip = String((req.headers['x-forwarded-for'] as string) || req.ip || 'unknown')
      .split(',')[0]
      .trim();
    // Публичный вход → ограничиваем: не больше 40 обращений с одного IP в час (throws 429).
    await this.rl.check(ip, 'first-contact', 40, 3600);

    const raw = Array.isArray(body?.messages) ? body!.messages! : [];
    // ≤10 вопросов ⇒ ~20 реплик; режем и число (последние 24), и длину каждой.
    const messages = raw
      .slice(-24)
      .map((m) => ({ from: m?.from === 'roman' ? 'roman' : 'user', text: String(m?.text ?? '').trim().slice(0, 2000) }))
      .filter((m) => m.text.length > 0);

    try {
      const text = await this.clean.firstContact(messages, !!body?.finish);
      return { ok: true, text };
    } catch {
      return { ok: false, error: 'Не удалось получить ответ' };
    }
  }
}
