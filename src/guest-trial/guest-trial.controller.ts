// src/guest-trial/guest-trial.controller.ts
import { Body, Controller, Get, Logger, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { JwtGuard } from '../common/guards/jwt.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import { RedisService } from '../common/services/redis.service';
import { GuestTurnService, parseGuestTurnInput } from './guest-turn.service';
import { GuestClaimService } from './guest-claim.service';
import { GuestTrialStore } from './guest-trial-store.service';
import { GuestSessionsService } from './guest-sessions.service';
import { hashGuestToken, isGuestTokenShape } from './guest-token';
import { isAllowedGuestOrigin } from './guest-origin';
import { answerRules, trialRules } from './guest-limits';
import { DEFAULT_GUEST_LIMITS, GUEST_REDIS_TIMEOUT_MS, GuestMode } from './guest-trial.types';
import { withTimeout } from '../common/with-timeout';

/**
 * Ключи общих окон — те же, что считает сам ход гостя (guest-limits.ts):
 * не дублировать строки руками (ревью A10). Значения лимитов тут неважны —
 * trialRules/answerRules нужны только за .key, DEFAULT_GUEST_LIMITS — просто
 * валидный GuestLimits, чтобы их позвать.
 */
const WINDOW_KEYS: readonly string[] = [...trialRules(DEFAULT_GUEST_LIMITS), ...answerRules(DEFAULT_GUEST_LIMITS)].map((r) => r.key);

/** Чужой Origin — в лог не чаще раза в 10 минут на процесс, иначе шквал запросов залил бы его (ревью A10). */
const ORIGIN_WARN_EVERY_MS = 10 * 60_000;

/**
 * Проба ассистента без регистрации (spec 2026-10-30-guest-trial-design.md).
 * Ключ гостя ходит только в теле запроса: адреса оседают в журналах nginx и прокси.
 */
@Controller('')
export class GuestTrialController {
  private readonly log = new Logger('GuestTrialController');
  private lastOriginWarnAt = 0;

  constructor(
    private readonly turns: GuestTurnService,
    private readonly claims: GuestClaimService,
    private readonly store: GuestTrialStore,
    private readonly sessions: GuestSessionsService,
    private readonly redis: RedisService,
  ) {}

  /** Открыта: кабинет без входа решает, показывать ли пробу. */
  @Get('guest/config')
  async config(@Req() req: Request, @Res() res: Response) {
    if (this.rejectForeignOrigin(req, res)) return;
    const { mode, limits } = await this.store.settings();
    return res.status(200).json({ mode, answersPerTrial: limits.answersPerTrial, maxChars: limits.maxChars });
  }

  @Post('guest/chat')
  async chat(@Req() req: Request, @Body() body: any, @Res() res: Response) {
    if (this.rejectForeignOrigin(req, res)) return;
    await this.turns.handle(parseGuestTurnInput(body), res);
  }

  /** Разговор пробы после перезагрузки страницы. */
  @Post('guest/session')
  async session(@Req() req: Request, @Body() body: any, @Res() res: Response) {
    if (this.rejectForeignOrigin(req, res)) return;
    const token = body?.token;
    if (!isGuestTokenShape(token)) return res.status(404).json({ error: 'trial' });
    const row = await this.sessions.findLive(hashGuestToken(token));
    if (!row || row.claimed_at) return res.status(404).json({ error: 'trial' });
    const { limits } = await this.store.settings();
    const messages = await this.sessions.messages(row.id);
    return res.status(200).json({
      assistantId: String(row.assistant_id),
      messages: messages.map((m) => ({ role: m.sender_type === 'human' ? 'user' : 'assistant', content: m.content })),
      left: Math.max(0, limits.answersPerTrial - row.answers),
    });
  }

  @Post('guest/claim')
  @UseGuards(JwtGuard)
  async claim(@CurrentUser() user: any, @Body() body: any, @Res() res: Response) {
    const r = await this.claims.claim(String(user?.userId ?? ''), String(body?.token ?? ''));
    return res.status(r.status).json(r.body);
  }

  /** Как у остальной админки: status, enable, preview, disable, set (лимиты). */
  @Post('admin/guest-trial')
  @UseGuards(JwtGuard, AdminGuard)
  async admin(@CurrentUser() user: any, @Body() body: any, @Res() res: Response) {
    switch (body?.action) {
      case 'status': {
        const settings = await this.store.settings();
        // Ревью A10 (1в): подсчёт счётчиков может упасть по причине, не
        // связанной с режимом/лимитами (БД моргнула) — mode/limits/windows
        // при этом всё равно видны, а не теряются вместе с counts.
        const counts = await this.sessions.status().catch((e: any) => {
          this.log.warn(`guest trial status: подсчёт не удался — ${e?.message}`);
          return null;
        });
        return res.status(200).json({ ...settings, counts, windows: await this.windows() });
      }
      case 'enable':
        return this.applyMode('on', user, res);
      case 'preview':
        return this.applyMode('preview', user, res);
      case 'disable':
        return this.applyMode('off', user, res);
      case 'set': {
        // Ревью A3: setLimits ничего не пишет и отдаёт changed:false, если в
        // патче нет ни одного валидного ключа (опечатка, не объект) — это
        // ошибка вызова, а не успех с лимитами по умолчанию. error:'limits' —
        // как у остальной админки (ревью A10).
        const r = await this.store.setLimits(body?.limits);
        return r.changed ? res.status(200).json(r) : res.status(400).json({ error: 'limits', ...r });
      }
      default:
        return res.status(400).json({ error: `Unknown action: ${body?.action}` });
    }
  }

  private async applyMode(mode: GuestMode, user: any, res: Response) {
    await this.store.setMode(mode);
    this.log.log(`guest trial mode → ${mode} (${user?.userId ?? '?'})`);
    return res.status(200).json({ mode });
  }

  /**
   * Общее для всех открытых ручек пробы (config/chat/session, ревью A10):
   * ответ всегда зависит от Origin (200 или 403) — промежуточный кеш не
   * должен запомнить его за другого посетителя (Cache-Control: no-store).
   * true — уже ответили (403), вызывающий должен остановиться без дальнейшей
   * работы (для chat — до вызова turns.handle).
   */
  private rejectForeignOrigin(req: Request, res: Response): boolean {
    res.setHeader('Cache-Control', 'no-store');
    const origin = req.headers.origin;
    if (isAllowedGuestOrigin(origin)) return false;
    if (Date.now() - this.lastOriginWarnAt > ORIGIN_WARN_EVERY_MS) {
      this.lastOriginWarnAt = Date.now();
      this.log.warn(`guest trial: чужой Origin ${String(origin).slice(0, 80)}`);
    }
    res.status(403).json({ error: 'origin' });
    return true;
  }

  /** Параллельно (ревью A10): лежащий Redis даёт ~2 с (один таймаут), а не 4×2 с последовательно. */
  private async windows(): Promise<Record<string, number | null>> {
    const entries = await Promise.all(
      WINDOW_KEYS.map(async (key): Promise<[string, number | null]> => {
        try {
          const v = await withTimeout(this.redis.get(key), GUEST_REDIS_TIMEOUT_MS);
          return [key, v === null ? 0 : Number(v)];
        } catch {
          return [key, null];
        }
      }),
    );
    return Object.fromEntries(entries);
  }
}
