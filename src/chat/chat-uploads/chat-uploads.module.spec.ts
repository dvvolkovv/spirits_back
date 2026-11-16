import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { CommonModule } from '../../common/common.module';
import { ChatModule } from '../chat.module';
import { ChatUploadsController } from './chat-uploads.controller';
import { ChatUploadsModule } from './chat-uploads.module';
import { ChatUploadsService } from './chat-uploads.service';

/**
 * Модуль обязан быть независимым (ChatModule и будущий ProfileModule
 * импортируют его без цикла DI) и применить миграцию chat_uploads при старте
 * — образец alert-bot.module.spec.ts.
 */
describe('ChatUploadsModule: состав и жизненный цикл', () => {
  afterEach(() => jest.restoreAllMocks());

  it('объявляет контроллер и сервис, экспортирует сервис, импортирует CommonModule', () => {
    expect(Reflect.getMetadata(MODULE_METADATA.IMPORTS, ChatUploadsModule)).toContain(CommonModule);
    expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, ChatUploadsModule)).toContain(
      ChatUploadsController,
    );
    expect(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, ChatUploadsModule)).toContain(
      ChatUploadsService,
    );
    expect(Reflect.getMetadata(MODULE_METADATA.EXPORTS, ChatUploadsModule)).toContain(
      ChatUploadsService,
    );
  });

  it('ChatModule импортирует ChatUploadsModule', () => {
    // Без этой строки маршрут /webhook/chat-uploads/:id не существует вовсе
    // (404), а юнит-тесты контроллера остаются зелёными.
    expect(Reflect.getMetadata(MODULE_METADATA.IMPORTS, ChatModule)).toContain(ChatUploadsModule);
  });

  it('onModuleInit применяет миграцию', async () => {
    const uploads = { migrate: jest.fn(async () => {}) };
    await new ChatUploadsModule(uploads as any).onModuleInit();
    expect(uploads.migrate).toHaveBeenCalledTimes(1);
  });

  it('сбой миграции прокидывается из onModuleInit — приложение не стартует без таблицы', async () => {
    const uploads = {
      migrate: jest.fn(async () => {
        throw new Error('db down');
      }),
    };
    await expect(new ChatUploadsModule(uploads as any).onModuleInit()).rejects.toThrow('db down');
  });
});

describe('ChatUploadsService.migrate', () => {
  afterEach(() => jest.restoreAllMocks());

  // Порядок фиксирован: 002 дополняет таблицу, которую создаёт 001.
  const FILES = ['001_chat_uploads.sql', '002_chat_uploads_media_notes.sql'];
  const srcPath = (file: string) => path.join(__dirname, 'migrations', file);

  it('отправляет SQL файлов миграций по порядку: 001, затем 002', async () => {
    const query = jest.fn(async (_sql: string) => ({ rows: [], rowCount: 0 }));
    await new ChatUploadsService({ query } as any, {} as any).migrate();

    expect(query).toHaveBeenCalledTimes(2);
    // В jest-окружении SQL читается из реальных файлов в src/ (оба кандидата
    // path.join нормализуются в один и тот же путь), а не зашит строкой.
    expect(String(query.mock.calls[0][0])).toBe(fs.readFileSync(srcPath(FILES[0]), 'utf8'));
    expect(String(query.mock.calls[1][0])).toBe(fs.readFileSync(srcPath(FILES[1]), 'utf8'));
    expect(String(query.mock.calls[0][0])).toContain('CREATE TABLE IF NOT EXISTS chat_uploads');
    expect(String(query.mock.calls[1][0])).toContain("hashtext('chat-uploads/002')");
  });

  it('после сборки берёт SQL из src (fallback из dist, три «..») — для обоих файлов', async () => {
    // Образец — alert-bot.module.spec.ts: первый кандидат имитирует dist-путь
    // (его не существует, nest-cli не копирует .sql в dist), второй обязан
    // найти файл в src. После сборки сервис лежит в dist/chat/chat-uploads,
    // поэтому «..» ровно три.
    const toDist = (p: string) =>
      p.replace(`${path.sep}src${path.sep}chat${path.sep}`, `${path.sep}dist${path.sep}chat${path.sep}`);
    const bundled = FILES.map(srcPath);
    const originalJoin = path.join;
    jest.spyOn(path, 'join').mockImplementation((...parts: string[]) => {
      if (parts.length === 3 && parts[1] === 'migrations' && FILES.includes(parts[2])) {
        return toDist(originalJoin(...parts));
      }
      return originalJoin(...parts);
    });
    const query = jest.fn(async (_sql: string) => ({ rows: [], rowCount: 0 }));
    const exists = jest
      .spyOn(fs, 'existsSync')
      .mockImplementation((candidate) => bundled.includes(String(candidate)));

    await new ChatUploadsService({ query } as any, {} as any).migrate();

    expect(exists).toHaveBeenNthCalledWith(1, toDist(bundled[0]));
    expect(exists).toHaveBeenNthCalledWith(2, bundled[0]);
    expect(exists).toHaveBeenNthCalledWith(3, toDist(bundled[1]));
    expect(exists).toHaveBeenNthCalledWith(4, bundled[1]);
    expect(query).toHaveBeenCalledTimes(2);
    expect(String(query.mock.calls[0][0])).toContain('CREATE TABLE IF NOT EXISTS chat_uploads');
    expect(String(query.mock.calls[1][0])).toContain('chat_uploads_source_check');
  });

  it('без файла миграции — явная ошибка, SQL не отправляется', async () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(false);
    const query = jest.fn(async (_sql: string) => ({ rows: [], rowCount: 0 }));

    await expect(new ChatUploadsService({ query } as any, {} as any).migrate()).rejects.toThrow(
      'chat-uploads migration 001_chat_uploads.sql not found',
    );
    expect(query).not.toHaveBeenCalled();
  });

  it('нет только 002 — ошибка до любого SQL: 001 в одиночку не применяется', async () => {
    const first = srcPath(FILES[0]);
    jest.spyOn(fs, 'existsSync').mockImplementation((candidate) => String(candidate) === first);
    const query = jest.fn(async (_sql: string) => ({ rows: [], rowCount: 0 }));

    await expect(new ChatUploadsService({ query } as any, {} as any).migrate()).rejects.toThrow(
      'chat-uploads migration 002_chat_uploads_media_notes.sql not found',
    );
    expect(query).not.toHaveBeenCalled();
  });
});
