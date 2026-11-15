import 'reflect-metadata';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { ProfileService } from './profile.service';
import { ProfileModule } from './profile.module';
import { ChatUploadsModule } from '../chat/chat-uploads/chat-uploads.module';
import { ChatModule } from '../chat/chat.module';

/**
 * Удаление аккаунта перенесено в конвейер AccountDeletion (Task 18):
 * ProfileService.deleteProfile делегирует всё в lifecycle.deleteExplicit,
 * а очистку задач конвейера покрывают src/profile/account-deletion.spec.ts
 * и спеки account-deletion.
 *
 * Поведенческие тесты main на старый inline-путь (chatUploads.deleteForUser
 * внутри deleteProfile, Task 7 spec 2026-11-13-chat-upload-memory) сняты
 * вместе с самим inline-путём: интеграция chat_uploads в конвейер —
 * отдельная задача (Phase 2), она же вернёт покрытие удаления исходников
 * загрузок при удалении аккаунта.
 */

describe('ProfileService: deleteProfile делегирует конвейеру', () => {
  it('не держит зависимость от ChatUploadsService в конструкторе', () => {
    // Сторож решения Phase 1: пока chat_uploads не интегрирован в конвейер,
    // ProfileService не знает про реестр загрузок. Phase 2 заменит этот
    // сторож тестами адаптера конвейера.
    const paramTypes = Reflect.getMetadata('design:paramtypes', ProfileService) || [];
    expect(paramTypes.some((t: any) => t?.name === 'ChatUploadsService')).toBe(false);
  });
});

/**
 * Сторожа DI — по духу chat-uploads.module.spec.ts.
 */
describe('ProfileModule: проводка ChatUploads', () => {
  it('ProfileModule импортирует ChatUploadsModule, а не ChatModule', () => {
    // ChatUploadsModule не импортирует никого кроме CommonModule — цикла нет.
    // ChatModule тянет тяжёлые зависимости (Video, Room, Products, …) и сам
    // связан с профилем — импортировать его ради одного сервиса нельзя.
    // Импорт сохранён после переноса удаления в конвейер — до интеграции
    // chat_uploads в конвейер (Phase 2).
    const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, ProfileModule) || [];
    expect(imports).toContain(ChatUploadsModule);
    expect(imports).not.toContain(ChatModule);
  });
});
