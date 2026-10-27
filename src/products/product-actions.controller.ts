import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, NotFoundException, NotImplementedException, Optional, Param, Post, UseGuards } from '@nestjs/common';
import { IsArray, IsBoolean, IsIn, IsObject, IsOptional, IsString } from 'class-validator';
import { JwtGuard } from '../common/guards/jwt.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import { IpRateLimiter } from '../common/guards/ip-rate-limit';
import { ProductActionsService, toView } from './product-actions.service';
import { ProductLifecycleService } from './product-lifecycle.service';
import { ProductKeysService } from './product-keys.service';

export class SubmitActionDto {
  @IsOptional() @IsBoolean() confirm?: boolean;
  @IsOptional() @IsObject() set?: Record<string, string>;
  @IsOptional() @IsArray() @IsString({ each: true }) remove?: string[];
  @IsOptional() @IsIn(['chat', 'cabinet', 'tma']) via?: 'chat' | 'cabinet' | 'tma';
}

/**
 * Карточка ожидающего действия: веб-чат, кабинет и мини-приложение. Свой
 * префикс `product-actions`, а не `products/actions`: не спорить с маршрутами
 * `products/:id/...` соседнего контроллера. Чужое действие — 404, а не 403:
 * не выдавать его существование. Значения ключей в ответ не попадают никогда —
 * ответ строится из toView, в котором их нет по построению.
 *
 * Ключи (`keys`) — `{set, remove}`: значения уходят в ProductKeysService и
 * дальше только в коробку карточки; ответ — `toView`, в котором значений нет
 * по построению.
 */
@Controller('')
@UseGuards(JwtGuard)
export class ProductActionsController {
  constructor(
    private readonly actions: ProductActionsService,
    private readonly lifecycle: ProductLifecycleService,
    private readonly limiter: IpRateLimiter,
    @Optional() private readonly keys?: ProductKeysService,
  ) {}

  @Get('product-actions')
  async pending(@CurrentUser() user: any) {
    return (await this.actions.listPending(user.userId)).map((r) => toView(r));
  }

  @Get('product-actions/:id')
  async get(@CurrentUser() user: any, @Param('id') id: string) {
    const row = await this.actions.get(user.userId, id);
    if (!row) throw new NotFoundException('Action not found');
    return toView(row);
  }

  @Post('product-actions/:id')
  @HttpCode(200)
  async submit(@CurrentUser() user: any, @Param('id') id: string, @Body() body: SubmitActionDto) {
    // Первым делом, раньше похода в базу за карточкой: каждое нажатие бота
    // создания зовёт getMe в Telegram с нашего IP, а неверный токен
    // возвращает карточку в pending — без лимита цикл «нажал — ошибка —
    // нажал снова» неограничен. Ключ — userId, а не IP запроса: карточка
    // принадлежит человеку, а не адресу (мобильный интернет и NAT отдают
    // один IP тысячам людей — лимит по IP наказал бы соседей по сети).
    await this.limiter.check(user.userId, 'product-action-submit', 20, 600);
    const row = await this.actions.get(user.userId, id);
    if (!row) throw new NotFoundException('Action not found');
    const via = body?.via ?? 'cabinet';
    if (row.kind === 'delete') {
      if (body?.confirm !== true) throw new BadRequestException('Нужно подтверждение');
      await this.lifecycle.completeDelete({ userId: user.userId, actionId: id, via });
    } else if (row.kind === 'create_bot') {
      await this.lifecycle.completeCreateBot({ userId: user.userId, actionId: id, set: body?.set ?? {}, via });
    } else if (row.kind === 'keys') {
      if (!this.keys) throw new NotImplementedException('Смена ключей сейчас недоступна');
      await this.keys.complete({ userId: user.userId, actionId: id, set: body?.set ?? {}, remove: body?.remove ?? [], via });
    } else {
      // create_site, restore, revert, purge — журнальные записи итога, не
      // ожидающие карточки (см. CardKind в product-actions.service):
      // actions.get их отдаёт (чужого от своего не отличить иначе),
      // подтверждать в них нечего — заведение/возврат/откат уже случились.
      throw new ConflictException('Это не карточка — подтверждать нечего');
    }
    return toView((await this.actions.get(user.userId, id))!);
  }

  @Post('product-actions/:id/cancel')
  @HttpCode(200)
  async cancel(@CurrentUser() user: any, @Param('id') id: string) {
    const row = await this.actions.get(user.userId, id);
    if (!row) throw new NotFoundException('Action not found');
    await this.actions.cancel(user.userId, id);
    return toView((await this.actions.get(user.userId, id))!);
  }
}
