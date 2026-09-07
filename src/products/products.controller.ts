import { Body, Controller, Get, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { JwtGuard } from '../common/guards/jwt.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import { ProductsService } from './products.service';
import { TurnsService } from './turns.service';
import { TurnEventsService } from './turn-events.service';

@Controller('')
@UseGuards(JwtGuard)
export class ProductsController {
  constructor(
    private readonly products: ProductsService,
    private readonly turns: TurnsService,
    private readonly turnEvents: TurnEventsService,
  ) {}

  @Get('products')
  async list(@CurrentUser() user: any, @Res() res: Response) {
    return res.status(200).json(await this.products.list(user.userId));
  }

  @Get('products/:id/turns')
  async history(@CurrentUser() user: any, @Param('id') id: string, @Res() res: Response) {
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

    for await (const event of this.turnEvents.readEvents(id, turn.id)) {
      if (clientGone) break;
      res.write(JSON.stringify(event) + '\n');
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
    await this.products.getOwned(id, user.userId);
    const turn = await this.turns.revert({ productId: id, turnId, userId: user.userId });
    return res.status(202).json(turn);
  }
}
