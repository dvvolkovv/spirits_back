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
 * вместе с самим inline-путём: интеграция chat_uploads в конвейер сделана
 * (Phase 2) — исходники загрузок стирает задача chat-upload.purge, её
 * покрытие живёт в chat-uploads/chat-upload-account-deletion.adapter.spec.ts
 * и chat-upload-account-deletion.pg.spec.ts.
 */

describe('ProfileService: deleteProfile делегирует конвейеру', () => {
  it('не держит зависимость от ChatUploadsService в конструкторе', () => {
    // Сторож решения Phase 1 (сохранён и после Phase 2): очистка chat_uploads
    // идёт через адаптер конвейера, поэтому ProfileService по-прежнему не
    // знает про реестр загрузок — inline-вызов был бы вне fencing.
    const paramTypes = Reflect.getMetadata('design:paramtypes', ProfileService) || [];
    expect(paramTypes.some((t: any) => t?.name === 'ChatUploadsService')).toBe(false);
  });
});

/**
 * Сторожа DI — по духу chat-uploads.module.spec.ts.
 */
describe('ProfileModule: проводка ChatUploads', () => {
  it('ProfileModule больше не импортирует ChatUploadsModule и не тянет ChatModule', () => {
    // Phase 2: chat_uploads стирает конвейер (адаптер chat-upload.purge
    // зарегистрирован из ChatUploadsModule), ни один провайдер ProfileModule
    // не зависит от ChatUploadsService — мёртвый импорт удалён.
    // ChatModule по-прежнему импортировать нельзя: тяжёлые зависимости и цикл.
    const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, ProfileModule) || [];
    expect(imports).not.toContain(ChatUploadsModule);
    expect(imports).not.toContain(ChatModule);
  });
});
