import { MODULE_METADATA } from '@nestjs/common/constants';
import { TgBotModule } from './tg-bot.module';
import { TgProductActionsService } from './tg-product-actions.service';
import { ProductsModule } from '../products/products.module';

/**
 * Без ProductsModule в imports — TgProductActionsService (его конструктор
 * просит ProductActionsService и ProductLifecycleService) не соберётся, а
 * @Optional в TgBotService тихо проглотит отсутствие: карточки продуктов
 * молча перестанут слаться, а нажатия «pa:» будут крутить спиннер вечно
 * (handleCallbackQuery без сервиса только гасит спиннер, самого действия не
 * делает). Зеркало src/chat/chat.product-actions-wiring.spec.ts.
 */
describe('карточки продуктов — модуль TG-бота собран с ProductsModule', () => {
  it('ProductsModule подключён к TgBotModule', () => {
    expect(Reflect.getMetadata(MODULE_METADATA.IMPORTS, TgBotModule)).toContain(ProductsModule);
  });

  it('TgProductActionsService — провайдер TgBotModule', () => {
    expect(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, TgBotModule)).toContain(TgProductActionsService);
  });
});
