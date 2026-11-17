import 'reflect-metadata';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { CommonModule } from '../../common/common.module';
import { PgService } from '../../common/services/pg.service';
import { ContextResetModule } from './context-reset.module';
import { ChatContextResetService } from './context-reset.service';

/**
 * Модуль точки «Чистого листа» обязан быть самостоятельным (его импортируют
 * чат, звонок и сборщик контекста — без цикла через ChatModule) и применить
 * миграцию chat_context_resets при старте. Образец — chat-uploads.module.spec.ts.
 */
describe('ContextResetModule: состав и жизненный цикл', () => {
  it('объявляет и экспортирует сервис, импортирует CommonModule', () => {
    expect(Reflect.getMetadata(MODULE_METADATA.IMPORTS, ContextResetModule)).toContain(CommonModule);
    expect(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, ContextResetModule)).toContain(
      ChatContextResetService,
    );
    expect(Reflect.getMetadata(MODULE_METADATA.EXPORTS, ContextResetModule)).toContain(
      ChatContextResetService,
    );
  });

  it('design:paramtypes сервиса — настоящий PgService (защита от import type)', () => {
    // `import type { PgService }` стёр бы тип до Object: Nest не разрешил бы
    // зависимость, и бутстрап упал бы на старте (см. chat-uploads.di.spec.ts).
    expect(Reflect.getMetadata('design:paramtypes', ChatContextResetService)).toEqual([PgService]);
  });

  it('onModuleInit применяет миграцию', async () => {
    const resets = { migrate: jest.fn(async () => {}) };
    await new ContextResetModule(resets as any).onModuleInit();
    expect(resets.migrate).toHaveBeenCalledTimes(1);
  });

  it('сбой миграции прокидывается из onModuleInit — приложение не стартует без таблицы', async () => {
    const resets = {
      migrate: jest.fn(async () => {
        throw new Error('db down');
      }),
    };
    await expect(new ContextResetModule(resets as any).onModuleInit()).rejects.toThrow('db down');
  });
});
