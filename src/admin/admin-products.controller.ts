import { Controller, Get, NotFoundException, Param, Query, UseGuards } from '@nestjs/common';
import { JwtGuard } from '../common/guards/jwt.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { assertUuid } from '../products/products.dto';
import { AdminProductsService } from './admin-products.service';

/** Флаг из query-строки. Всё, кроме явного «да», считаем выключенным. */
const isTruthy = (v: string | undefined): boolean => v === '1' || v === 'true';

/** Число из query-строки; мусор — NaN, его сервис заменяет умолчанием. */
const toInt = (v: string | undefined): number | undefined => (v ? parseInt(v, 10) : undefined);

/**
 * Раздел «Сайты и боты»: продукты всех пользователей и карточка одного.
 *
 * Гварды на КЛАССЕ, та же пара, что у AdminController: выдача здесь — это
 * владельцы, их почта, адреса машин и тексты правок всех продуктов, то есть
 * ровно то, что утекало через admin/* с одним JwtGuard (см.
 * common/guards/admin-routes.spec.ts — он обходит и этот контроллер).
 * Отдельным контроллером, а не методами AdminController, — чтобы сервис
 * раздела не становился четвёртой зависимостью его конструктора.
 *
 * Действий нет: гасят и возвращают продукт маршруты products/block и
 * products/unblock (ключ — id из этой выдачи).
 */
@Controller('')
@UseGuards(JwtGuard, AdminGuard)
export class AdminProductsController {
  constructor(private readonly products: AdminProductsService) {}

  @Get('admin/products')
  listProducts(
    @Query('q') q: string | undefined,
    @Query('status') status: string | undefined,
    @Query('kind') kind: string | undefined,
    @Query('periodDays') periodDays: string | undefined,
    @Query('includeTest') includeTest: string | undefined,
    @Query('includeArchived') includeArchived: string | undefined,
  ) {
    // Значения не проверяем здесь: сервис сам прижимает период и отбрасывает
    // незнакомую форму. Проверка в двух местах разъехалась бы.
    return this.products.list({
      q,
      status,
      kind,
      periodDays: toInt(periodDays),
      includeTest: isTruthy(includeTest),
      includeArchived: isTruthy(includeArchived),
    });
  }

  /**
   * Карточка по id — без фильтров списка: архивный и тестовый продукт здесь
   * тоже открываются. Период необязателен и нужен, чтобы счётчики карточки
   * совпадали со строкой списка, из которой в неё пришли.
   *
   * Не-uuid и неизвестный id — одинаковая 404 (assertUuid): разница между ними
   * — подсказка о том, какие id существуют.
   */
  @Get('admin/products/:id')
  async productCard(@Param('id') id: string, @Query('periodDays') periodDays: string | undefined) {
    assertUuid(id, 'Product');
    const card = await this.products.card(id, { periodDays: toInt(periodDays) });
    if (!card) throw new NotFoundException('Product not found');
    return card;
  }
}
