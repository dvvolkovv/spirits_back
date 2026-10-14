// src/chat/chat.module.chat-files.spec.ts
import { MODULE_METADATA } from '@nestjs/common/constants';
import { ChatModule } from './chat.module';
import { ChatFileStore } from './chat-files/chat-file-store';
import { ChatFilesController } from './chat-files/chat-files.controller';
import { ChatFilesService } from './chat-files/chat-files.service';
import { CostGrowthService } from '../cost-growth/cost-growth.service';
import { TgBotModule } from '../tg-bot/tg-bot.module';

/**
 * В ChatService копировщик подключён как @Optional() — так требуют спеки,
 * собирающие сервис позиционно. Обратная сторона: забытый провайдер не роняет
 * старт, а молча оставляет ссылки на релее. Этот тест — сторож регистрации.
 */
it('ChatFileStore зарегистрирован в ChatModule', () => {
  expect(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, ChatModule)).toContain(ChatFileStore);
});

it('панель «Медиа и файлы» зарегистрирована в ChatModule', () => {
  expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, ChatModule)).toContain(ChatFilesController);
  expect(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, ChatModule)).toContain(ChatFilesService);
});

/**
 * Сторож «стоимость растёт с каждым ответом» тоже @Optional() — в ChatService и
 * в TgBotService. Забытый провайдер старт не уронит, а сторож молча ослепнет
 * (ровно так 14.10 рост стоимости и прошёл незамеченным). Поэтому — сторож
 * регистрации в обоих модулях.
 */
it('CostGrowthService зарегистрирован в ChatModule и в TgBotModule', () => {
  expect(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, ChatModule)).toContain(CostGrowthService);
  expect(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, TgBotModule)).toContain(CostGrowthService);
});
