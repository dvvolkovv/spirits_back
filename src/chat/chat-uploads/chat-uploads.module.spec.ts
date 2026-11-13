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

  it('отправляет SQL файла миграции одним вызовом pg.query', async () => {
    const query = jest.fn(async () => ({ rows: [], rowCount: 0 }));
    await new ChatUploadsService({ query } as any, {} as any).migrate();

    expect(query).toHaveBeenCalledTimes(1);
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS chat_uploads');
    // В jest-окружении SQL читается из реального файла в src/ (оба кандидата
    // path.join нормализуются в один и тот же путь), а не зашит строкой.
    const expected = fs.readFileSync(
      path.join(__dirname, 'migrations', '001_chat_uploads.sql'),
      'utf8',
    );
    expect(sql).toBe(expected);
  });

  it('после сборки берёт SQL из src (fallback из dist, три «..»)', async () => {
    // Образец — alert-bot.module.spec.ts: первый кандидат имитирует dist-путь
    // (его не существует, nest-cli не копирует .sql в dist), второй обязан
    // найти файл в src. После сборки сервис лежит в dist/chat/chat-uploads,
    // поэтому «..» ровно три.
    const bundled = path.join(__dirname, 'migrations', '001_chat_uploads.sql');
    const distBundled = bundled.replace(
      `${path.sep}src${path.sep}chat${path.sep}`,
      `${path.sep}dist${path.sep}chat${path.sep}`,
    );
    const originalJoin = path.join;
    jest.spyOn(path, 'join').mockImplementation((...parts: string[]) => {
      if (parts.length === 3 && parts[1] === 'migrations' && parts[2] === '001_chat_uploads.sql') {
        return distBundled;
      }
      return originalJoin(...parts);
    });
    const query = jest.fn(async () => ({ rows: [], rowCount: 0 }));
    const exists = jest
      .spyOn(fs, 'existsSync')
      .mockImplementation((candidate) => String(candidate) === bundled);

    await new ChatUploadsService({ query } as any, {} as any).migrate();

    expect(exists).toHaveBeenNthCalledWith(1, distBundled);
    expect(exists).toHaveBeenNthCalledWith(2, bundled);
    expect(String(query.mock.calls[0][0])).toContain('CREATE TABLE IF NOT EXISTS chat_uploads');
  });

  it('без файла миграции — явная ошибка, SQL не отправляется', async () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(false);
    const query = jest.fn(async () => ({ rows: [], rowCount: 0 }));

    await expect(new ChatUploadsService({ query } as any, {} as any).migrate()).rejects.toThrow(
      'chat-uploads migration 001_chat_uploads.sql not found',
    );
    expect(query).not.toHaveBeenCalled();
  });
});
