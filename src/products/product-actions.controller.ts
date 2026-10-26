import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, NotImplementedException, Param, Post, UseGuards } from '@nestjs/common';
import { IsBoolean, IsIn, IsObject, IsOptional } from 'class-validator';
import { JwtGuard } from '../common/guards/jwt.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import { ProductActionsService, toView } from './product-actions.service';
import { ProductLifecycleService } from './product-lifecycle.service';

export class SubmitActionDto {
  @IsOptional() @IsBoolean() confirm?: boolean;
  @IsOptional() @IsObject() set?: Record<string, string>;
  @IsOptional() @IsIn(['chat', 'cabinet', 'tma']) via?: 'chat' | 'cabinet' | 'tma';
}

/**
 * Карточка ожидающего действия: веб-чат, кабинет и мини-приложение. Свой
 * префикс `product-actions`, а не `products/actions`: не спорить с маршрутами
 * `products/:id/...` соседнего контроллера. Чужое действие — 404, а не 403:
 * не выдавать его существование. Значения ключей в ответ не попадают никогда —
 * ответ строится из toView, в котором их нет по построению.
 */
@Controller('')
@UseGuards(JwtGuard)
export class ProductActionsController {
  constructor(
    private readonly actions: ProductActionsService,
    private readonly lifecycle: ProductLifecycleService,
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
    const row = await this.actions.get(user.userId, id);
    if (!row) throw new NotFoundException('Action not found');
    const via = body?.via ?? 'cabinet';
    if (row.kind === 'delete') {
      if (body?.confirm !== true) throw new BadRequestException('Нужно подтверждение');
      await this.lifecycle.completeDelete({ userId: user.userId, actionId: id, via });
    } else if (row.kind === 'create_bot') {
      await this.lifecycle.completeCreateBot({ userId: user.userId, actionId: id, set: body?.set ?? {}, via });
    } else {
      throw new NotImplementedException('Это действие появится позже');
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
