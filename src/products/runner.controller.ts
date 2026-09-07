import { Body, Controller, Param, Post, Req, UseGuards } from '@nestjs/common';
import { RunnerGuard } from './runner.guard';
import { TurnsService, CompleteInput } from './turns.service';

@Controller('')
@UseGuards(RunnerGuard)
export class RunnerController {
  constructor(private readonly turns: TurnsService) {}

  /**
   * Long-poll раннера. Возвращает задание либо turn: null. Раннер зовёт этот
   * маршрут по кругу; соединение инициирует VM, поэтому бэкенд не хранит
   * SSH-ключей от клиентских машин и не зависит от их белого IP.
   */
  @Post('products/runner/poll')
  async poll(@Req() req: any) {
    const product = req.product;
    await this.turns.touchRunner(product.id);

    const turn = await this.turns.claimNext(product.id);
    return {
      turn: turn
        ? {
            id: turn.id,
            prompt: turn.prompt,
            userId: turn.user_id,
            // Раннер читает поле, а не парсит префикс промпта: контракт между
            // двумя репозиториями не должен быть строковым.
            revertToSha: turn.revert_to_sha,
          }
        : null,
      product: {
        checkoutPath: product.checkout_path,
        buildCmd: product.build_cmd,
        restartCmd: product.restart_cmd,
        healthUrl: product.health_url,
        repoUrl: product.repo_url,
        claudeSessionId: product.claude_session_id,
      },
    };
  }

  /**
   * `productId` и `userId` берутся ИСКЛЮЧИТЕЛЬНО из `req.product`, который
   * положил `RunnerGuard`. Ничего из тела и URL, кроме `turnId`, доверять
   * нельзя: guard подтверждает, каким продуктом является раннер, но не то,
   * что переданный `turnId` принадлежит этому продукту.
   *
   * `Omit` здесь не защита, а документация: `ValidationPipe` поднят с
   * `whitelist: false`, TS-типы в рантайме не существуют, и лишние поля из
   * тела дошли бы до сервиса. Спасает то, что `complete` собирает параметры
   * явным списком.
   */
  @Post('products/runner/turns/:id/complete')
  async complete(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: Omit<CompleteInput, 'userId' | 'productId'>,
  ) {
    await this.turns.complete(id, {
      ...body,
      productId: req.product.id,
      userId: req.product.user_id,
    });
    return { ok: true };
  }
}
