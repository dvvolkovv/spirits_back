import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { PgService } from '../common/services/pg.service';
import { JwtGuard } from '../common/guards/jwt.guard';
import { CurrentUser } from '../common/decorators/user.decorator';

/**
 * История пополнений баланса.
 *
 * Заведена по факту: на 2026-08-08 в token_transactions лежало 29 840 списаний
 * и НОЛЬ покупок — пользователь видел, как токены тают, но не мог узнать, когда
 * и откуда они пришли. Начисления шли прямым `tokens = tokens + N` мимо
 * add_user_tokens, и следа не оставляли.
 *
 * Отдаём только начисления: расход показывается в чате по каждому сообщению и
 * в общей ленте был бы шумом на десятки тысяч строк.
 */
@Controller('')
export class TokenHistoryController {
  constructor(private readonly pg: PgService) {}

  @Get('tokens/history')
  @UseGuards(JwtGuard)
  async history(@CurrentUser() user: any, @Query('limit') limit: string, @Res() res: Response) {
    const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);

    const rows = await this.pg.query(
      `SELECT created_at, transaction_type, amount, balance_after, description, metadata
         FROM token_transactions
        WHERE user_id = $1
          AND transaction_type <> 'consumed'
        ORDER BY created_at DESC
        LIMIT $2`,
      [user.userId, lim],
    );

    return res.status(200).json({
      items: rows.rows.map((r: any) => ({
        at: r.created_at,
        type: r.transaction_type,
        tokens: Number(r.amount),
        // У перенесённых строк остаток восстановить было нельзя — отдаём null,
        // а не ноль из базы, чтобы фронт не показал выдумку как факт.
        balanceAfter: r.metadata?.reconstructed ? null : Number(r.balance_after),
        description: r.description,
        // Провайдер и сумма в деньгах нужны, чтобы отличить рублёвую оплату от
        // криптовалютной — по одному числу токенов это неразличимо.
        provider: r.metadata?.provider ?? null,
        money: r.metadata?.amount != null
          ? { amount: Number(r.metadata.amount), currency: r.metadata.currency ?? null }
          : null,
        bonusTokens: r.metadata?.bonus_tokens ? Number(r.metadata.bonus_tokens) : 0,
      })),
    });
  }
}
