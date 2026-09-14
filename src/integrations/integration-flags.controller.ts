import { BadRequestException, Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { JwtGuard } from '../common/guards/jwt.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import { IntegrationFlag, IntegrationFlagsService } from './integration-flags.service';

/**
 * Переключатели интеграций в админке.
 *
 * Пара JwtGuard + AdminGuard — та же, что у остальных админских контроллеров.
 * Без второго любой залогиненный пользователь мог бы включить себе
 * экспериментальную интеграцию, то есть выключатель не выключал бы ничего.
 */
@Controller('admin/integrations')
@UseGuards(JwtGuard, AdminGuard)
export class IntegrationFlagsController {
  constructor(private readonly flags: IntegrationFlagsService) {}

  @Get()
  async list(): Promise<{ integrations: IntegrationFlag[] }> {
    return { integrations: await this.flags.list() };
  }

  /**
   * Переключить одну интеграцию.
   *
   * Отвечаем полным списком, а не «ок»: админка рисует состояние всех
   * переключателей, и второй запрос за ним был бы лишним.
   */
  @Post()
  async set(
    @CurrentUser() user: any,
    @Body() body: { key?: string; enabled?: boolean },
  ): Promise<{ integrations: IntegrationFlag[] }> {
    const key = String(body?.key ?? '');
    if (!key || typeof body?.enabled !== 'boolean') {
      throw new BadRequestException('key и enabled обязательны');
    }
    try {
      const actor = user?.userId ? String(user.userId) : undefined;
      return { integrations: await this.flags.set(key, body.enabled, actor) };
    } catch (e: any) {
      // Неизвестный ключ — ошибка запроса, а не сбой: в базе от опечатки
      // осталась бы строка, которую никто не читает.
      throw new BadRequestException(e?.message || 'не удалось переключить интеграцию');
    }
  }
}
