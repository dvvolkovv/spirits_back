import 'reflect-metadata';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { ProfileService } from './profile.service';
import { ProfileModule } from './profile.module';
import { ChatUploadsService } from '../chat/chat-uploads/chat-uploads.service';
import { ChatUploadsModule } from '../chat/chat-uploads/chat-uploads.module';
import { ChatModule } from '../chat/chat.module';

/**
 * Удаление аккаунта обязано уносить исходники загрузок (Task 7,
 * spec 2026-11-13-chat-upload-memory): байты в приватном MinIO и строки
 * chat_uploads. Порядок — ДО удаления истории переписки: очистка реестра
 * такая же безусловная часть процедуры, как остальные шаги deleteProfile.
 *
 * Поведение самой deleteForUser (MinIO раньше строк, терпимость к NotFound)
 * покрыто в chat-uploads/chat-uploads.delete.spec.ts — здесь только вызов.
 */

function makeProfile(chatUploads?: { deleteForUser: jest.Mock }) {
  const log: string[] = [];
  const pg = {
    query: jest.fn(async (sql: string) => {
      log.push(String(sql).replace(/\s+/g, ' ').trim());
      return { rows: [] };
    }),
  };
  const profile = new ProfileService(
    pg as any, undefined, undefined, undefined, chatUploads as any,
  );
  return { profile, pg, log };
}

describe('ProfileService.deleteProfile: исходники загрузок', () => {
  it('удаляет загрузки владельца ДО удаления истории переписки', async () => {
    const log: string[] = [];
    const chatUploads = {
      deleteForUser: jest.fn(async (userId: string) => {
        log.push(`chatUploads.deleteForUser(${userId})`);
      }),
    };
    const pg = {
      query: jest.fn(async (sql: string) => {
        log.push(String(sql).replace(/\s+/g, ' ').trim());
        return { rows: [] };
      }),
    };
    const profile = new ProfileService(pg as any, undefined, undefined, undefined, chatUploads as any);

    await profile.deleteProfile('u1');

    expect(chatUploads.deleteForUser).toHaveBeenCalledWith('u1');
    const uploadsAt = log.findIndex((e) => e.startsWith('chatUploads.deleteForUser'));
    const historyAt = log.findIndex((e) => e.startsWith('DELETE FROM custom_chat_history'));
    expect(uploadsAt).toBeGreaterThanOrEqual(0);
    expect(historyAt).toBeGreaterThanOrEqual(0);
    expect(uploadsAt).toBeLessThan(historyAt);
  });

  it('сбой очистки загрузок срывает удаление — как и другие шаги процедуры', async () => {
    // Семантика deleteProfile: шаги очистки безусловные (await без catch).
    // Проглоченная ошибка MinIO оставила бы байты после «удалённого» аккаунта;
    // deleteForUser сам хранит строки для повтора и прокидывает ошибку сюда.
    const chatUploads = {
      deleteForUser: jest.fn(async () => {
        throw new Error('minio down');
      }),
    };
    const { profile, log } = makeProfile(chatUploads);

    await expect(profile.deleteProfile('u1')).rejects.toThrow('minio down');
    expect(log.some((e) => e.startsWith('DELETE FROM custom_chat_history'))).toBe(false);
    expect(log.some((e) => e.startsWith('DELETE FROM user_identities'))).toBe(false);
  });

  it('без реестра (модуль не подключён) удаление работает как раньше', async () => {
    const { profile } = makeProfile(undefined);
    await expect(profile.deleteProfile('u1')).resolves.toEqual({ success: true });
  });
});

/**
 * Сторожа DI — по духу chat-uploads.prompt.spec.ts и chat-uploads.module.spec.ts.
 */
describe('ProfileService/ProfileModule: проводка ChatUploads', () => {
  it('конструктор объявляет зависимость классом ChatUploadsService', () => {
    // Интерфейс стёрся бы в Object при компиляции, Nest не нашёл бы провайдер,
    // и @Optional() молча подставил undefined — очистки загрузок не было бы.
    const paramTypes = Reflect.getMetadata('design:paramtypes', ProfileService);
    expect(Array.isArray(paramTypes)).toBe(true);
    expect(paramTypes).toContain(ChatUploadsService);
  });

  it('ProfileModule импортирует ChatUploadsModule, а не ChatModule', () => {
    // ChatUploadsModule не импортирует никого кроме CommonModule — цикла нет.
    // ChatModule тянет тяжёлые зависимости (Video, Room, Products, …) и сам
    // связан с профилем — импортировать его ради одного сервиса нельзя.
    const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, ProfileModule) || [];
    expect(imports).toContain(ChatUploadsModule);
    expect(imports).not.toContain(ChatModule);
  });
});
