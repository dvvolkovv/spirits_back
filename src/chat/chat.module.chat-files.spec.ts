// src/chat/chat.module.chat-files.spec.ts
import { MODULE_METADATA } from '@nestjs/common/constants';
import { ChatModule } from './chat.module';
import { ChatFileStore } from './chat-files/chat-file-store';
import { ChatFilesController } from './chat-files/chat-files.controller';
import { ChatFilesService } from './chat-files/chat-files.service';

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
