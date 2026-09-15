import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { HostGuard } from './host.guard';
import { CompleteJobDto } from './products.dto';
import { ProvisioningService } from './provisioning.service';

/**
 * Маршруты агента хоста продуктов. Соединение всегда инициирует хост, поэтому
 * ключей от клиентских машин у нас нет и их белый IP нам не нужен.
 *
 * Префикс контроллера ПУСТОЙ. В main.ts стоит `app.setGlobalPrefix('webhook')`,
 * и оба соседних контроллера модуля объявлены так же: путь пишется целиком в
 * самом маршруте. `@Controller('webhook')` дал бы
 * /webhook/webhook/products/host/poll — агент получил бы 404 при полностью
 * зелёном прогоне, потому что от адреса не зависит ни одна проверка вида
 * `new HostController(mock)`. Сторож адреса — products.routes.spec.ts.
 */
@Controller('')
@UseGuards(HostGuard)
export class HostController {
  constructor(private readonly provisioning: ProvisioningService) {}

  /**
   * Опрос очереди. Агент зовёт этот маршрут по кругу, поэтому пустая очередь —
   * обычное состояние, а не ошибка.
   *
   * Задание прокидывается ЦЕЛИКОМ, в отличие от соседнего маршрута раннера,
   * где ответ собирается явным списком. Разница не в небрежности: там в
   * `req.product` лежит вся строка продукта из базы, и явный список защищает
   * от того, чтобы новая колонка уехала раннеру сама собой. Здесь же объект
   * собирает сам claimJob, и его поля — это и есть контракт с агентом:
   * открытый runner-токен и расшифрованные секреты существуют ровно один раз,
   * в теле этого ответа, и потерять их по дороге нельзя.
   */
  @Post('products/host/poll')
  async poll() {
    return { job: await this.provisioning.claimJob() };
  }

  /**
   * Отчёт о развёртывании. `id` берётся из URL; из тела — только исход, порт и
   * причина, и берутся они ЯВНЫМ списком.
   *
   * Список именно явный, потому что DTO лишние поля не отсекает:
   * ValidationPipe поднят с `whitelist: false`, а class-transformer копирует на
   * экземпляр и незнакомые ключи. Тело приезжает сюда как есть.
   */
  @Post('products/host/jobs/:id/complete')
  async complete(@Param('id') id: string, @Body() body: CompleteJobDto) {
    await this.provisioning.completeJob(id, {
      ok: body.ok,
      port: body.port,
      error: body.error,
    });
    return { ok: true };
  }
}
