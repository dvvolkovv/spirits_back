import { Body, Controller, Get, Logger, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { JwtGuard } from '../common/guards/jwt.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import { ProductsService } from './products.service';
import { TurnsService } from './turns.service';
import { TurnEventsService } from './turn-events.service';
import { ProvisioningService } from './provisioning.service';
import { assertUuid, CreateProductDto } from './products.dto';

@Controller('')
@UseGuards(JwtGuard)
export class ProductsController {
  private readonly logger = new Logger(ProductsController.name);

  constructor(
    private readonly products: ProductsService,
    private readonly turns: TurnsService,
    private readonly turnEvents: TurnEventsService,
    private readonly provisioning: ProvisioningService,
  ) {}

  /**
   * Список продуктов кабинета — и заодно ответ на вопрос «забирает ли
   * кто-нибудь задания».
   *
   * ПОЧЕМУ ЗАГОЛОВОК, А НЕ ТЕЛО. Тело этого маршрута — МАССИВ, и фронт читает
   * его массивом (`Array.isArray(rows) ? rows : null` в productsApi.list).
   * Завернуть его в конверт `{ items, hostAgent }` значит сломать кабинет у
   * всех, кто не перезагрузил вкладку, — статика и API катятся одним
   * скриптом, но открытая вкладка живёт своей жизнью сутками.
   *
   * Поле в каждой строке отпадает по другой причине: это факт о МАШИНЕ, а не о
   * продукте. Продуктов может быть десять — и тогда один и тот же факт
   * повторён десять раз, а читатель гадает, какой строке верить; а может быть
   * НОЛЬ — и тогда предупреждению негде появиться ровно там, где оно нужнее
   * всего: перед первым нажатием «Новый продукт».
   *
   * Заголовок несёт ГОТОВЫЙ ВЕРДИКТ, а не отметку времени. Свежесть считается
   * по часам сервера: браузер с уехавшими часами (а это ноутбук, проспавший
   * неделю, а не экзотика) сам посчитал бы «агент молчит два дня» при
   * исправном агенте.
   *
   * Молчание заголовка — это «неизвестно», а не «всё хорошо»: старый бэкенд и
   * прокси, срезающий незнакомые заголовки, обязаны давать отсутствие тревоги,
   * а не ложную тревогу (разбор — на стороне кабинета).
   */
  @Get('products')
  async list(@CurrentUser() user: any, @Res() res: Response) {
    const rows = await this.products.list(user.userId);
    // Отказ проверки не превращается в тревогу и не роняет список. Вердикт —
    // приписка к ответу, а не сам ответ: 500 вместо списка продуктов из-за
    // недоступной отметки был бы платой большей, чем вся польза от неё. В лог
    // причина при этом попадает — молчаливое «live» иначе означало бы
    // сломанную проверку, неотличимую от исправной.
    const live = await this.provisioning.hostAgentLive().catch((e: any) => {
      this.logger.error(`проверка агента хоста не прошла: ${e?.message}`);
      return true;
    });
    res.setHeader('X-Host-Agent', live ? 'live' : 'silent');
    return res.status(200).json(rows);
  }

  /**
   * Кнопка «Новый продукт». Поля перечисляются ЯВНО, по той же причине, что и
   * в chat(): ValidationPipe стоит с `whitelist: false`, лишнее из тела не
   * срезается, и спред отдал бы любому авторизованному пользователю право
   * завести продукт на чужой `userId`.
   */
  @Post('products')
  async create(@CurrentUser() user: any, @Body() body: CreateProductDto) {
    const r = await this.provisioning.create({
      userId: user.userId,
      name: body.name,
      slug: body.slug,
      kind: body.kind,
      secrets: body.secrets ?? {},
    });
    // Наружу только id. Открытый токен раннера — ключ от чекаута продукта, он
    // нужен агенту хоста, а не браузеру; `return r` отправил бы его в ответ и
    // в логи прокси.
    return { id: r.productId };
  }

  /**
   * Кнопка «повторить» на карточке сорванного заведения. Владение и состояние
   * проверяет сам сервис — одним оператором вместе с постановкой задания.
   */
  @Post('products/:id/retry')
  async retry(@CurrentUser() user: any, @Param('id') id: string) {
    assertUuid(id, 'Product');
    await this.provisioning.retry(id, user.userId);
    return { ok: true };
  }

  @Get('products/:id/turns')
  async history(@CurrentUser() user: any, @Param('id') id: string, @Res() res: Response) {
    assertUuid(id, 'Product');
    await this.products.getOwned(id, user.userId);
    return res.status(200).json(await this.turns.history(id, user.userId));
  }

  /**
   * Заголовки скопированы из chat.controller.ts: X-Accel-Buffering: no
   * обязателен, иначе nginx придержит чанки и стриминг превратится в один
   * ответ в конце.
   *
   * Поля в enqueue перечисляются ЯВНО. Спред тела вернул бы дыру: клиент
   * прислал бы revertToSha и получил право сбросить прод на произвольный
   * коммит мимо всех проверок revert(). ValidationPipe с whitelist: false
   * лишнее не срежет.
   */
  @Post('products/:id/chat')
  async chat(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() body: { prompt: string },
    @Req() req: Request,
    @Res() res: Response,
  ) {
    assertUuid(id, 'Product');
    await this.products.getOwned(id, user.userId);
    const turn = await this.turns.enqueue({
      productId: id,
      userId: user.userId,
      channel: 'web',
      prompt: body.prompt,
    });

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');

    // Обрыв клиента прекращает чтение. Без этого генератор крутится до своего
    // предела в 15 минут, опрашивая Redis и Postgres ради ответа, который
    // некому принять: nginx рвёт соединение по proxy_read_timeout заметно
    // раньше, а воркер Node всё это время занят. На параллельных ходах это
    // накопительная утечка.
    //
    // Ход при этом не прерывается — он живёт на VM и договорит сам. Клиент
    // дочитает результат из истории.
    let clientGone = false;
    req.on('close', () => {
      clientGone = true;
    });

    try {
      // Внешняя проверка `if (clientGone) break` остаётся: она закрывает
      // гонку внутри одного тика, когда `readEvents` уже отдал событие, а
      // обрыв случился, пока мы дописывали предыдущее в сокет. Основная
      // защита — предикат `isCancelled`, переданный внутрь генератора: без
      // него отмена не срабатывает, пока поток тихий (см. readEvents).
      for await (const event of this.turnEvents.readEvents(id, turn.id, () => clientGone)) {
        if (clientGone) break;
        res.write(JSON.stringify(event) + '\n');
      }
    } catch (e: any) {
      // Заголовки уже ушли, поэтому фильтр исключений Nest отдать чистый JSON
      // не сможет — клиент увидел бы обрыв сокета без объяснения. Отдаём
      // событие error, чтобы NDJSON-парсер на той стороне получил внятное
      // завершение.
      this.logger.error(`chat: поток хода ${turn.id} прерван: ${e?.message}`);
      if (!clientGone) {
        res.write(JSON.stringify({ type: 'error', message: 'Поток прерван' }) + '\n');
      }
    }
    if (!clientGone) res.end();
  }

  @Post('products/:id/turns/:turnId/revert')
  async revert(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Param('turnId') turnId: string,
    @Res() res: Response,
  ) {
    assertUuid(id, 'Product');
    // Оба параметра, а не только первый: turnId уезжает в такой же
    // `WHERE id = $1` внутри revert().
    assertUuid(turnId, 'Turn');
    await this.products.getOwned(id, user.userId);
    const turn = await this.turns.revert({ productId: id, turnId, userId: user.userId });
    return res.status(202).json(turn);
  }
}
