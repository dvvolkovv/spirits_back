/**
 * Сходится ли DI-граф загрузок чата. Паттерн — blog.module.spec.ts /
 * shorts.module.spec.ts: @nestjs/testing в проекте не установлен, поэтому
 * поднимаем ровно те внутренности @nestjs/core, которые дёргает NestFactory
 * (scan + instance loader). Lifecycle-хуки не вызываются — ни БД, ни MinIO,
 * ни .env не нужны.
 *
 * Пины защищают класс дефектов, который не видят ни tsc, ни юнит-тесты:
 * `import type { StorageService }` стирает design:paramtypes до
 * Function/Object, Nest не может разрешить зависимости провайдера, и
 * бутстрап AppModule падает на старте (при дефолтном abortOnError — молча,
 * process.exit(1)). Именно так прошёл chat-upload.purge: адаптер компилировался
 * и был покрыт юнит-спеками, но в реальном графе был мёртв — executor не
 * регистрировался. Прямые пины design:paramtypes локализуют дефект до
 * конкретного файла без подъёма графа; граф-тест AppModule доказывает, что
 * executor вообще бутстрапится в прод-wiring.
 *
 * Пины paramtypes для ChatFileAccountDeletionAdapter и
 * VoiceDocumentAccountDeletionAdapter — та же линейка: тот же порок
 * ПРЕДСУЩЕСТВОВАЛ в них на базе b81f6ba9 и красил blog/shorts DI-спеки.
 */
import { Module } from '@nestjs/common';
import type { Type } from '@nestjs/common';
import { NestContainer } from '@nestjs/core/injector/container';
import { InstanceLoader } from '@nestjs/core/injector/instance-loader';
import { Injector } from '@nestjs/core/injector/injector';
import { DependenciesScanner } from '@nestjs/core/scanner';
import { GraphInspector } from '@nestjs/core/inspector/graph-inspector';
import { MetadataScanner } from '@nestjs/core/metadata-scanner';

import { AccountDeletionRegistry } from '../../account-deletion/account-deletion.registry';
import { LanguageService } from '../../common/services/language.service';
import { StorageService } from '../../common/services/storage.service';
import { VoiceDocumentAccountDeletionAdapter } from '../../voice-call/voice-document-account-deletion';
import { ChatFileAccountDeletionAdapter } from '../chat-files/chat-file-account-deletion.adapter';
import { ChatUploadAccountDeletionAdapter } from './chat-upload-account-deletion.adapter';
import { ChatUploadsService } from './chat-uploads.service';

jest.setTimeout(120000);

async function buildGraph(root: Type<any>): Promise<NestContainer> {
  const container = new NestContainer();
  const graphInspector = new GraphInspector(container);
  const scanner = new DependenciesScanner(container, new MetadataScanner(), graphInspector);
  await scanner.scan(root);
  const loader = new InstanceLoader(container, new Injector(), graphInspector);
  await loader.createInstancesOfDependencies();
  return container;
}

function find(container: NestContainer, cls: unknown): unknown {
  for (const [, mod] of container.getModules()) {
    const key = cls as new () => unknown;
    const p = mod.providers.get(key) || mod.controllers.get(key);
    if (p && p.instance) return p.instance;
  }
  return undefined;
}

describe('DI-граф загрузок чата', () => {
  it('design:paramtypes адаптера chat-upload — настоящие классы, а не Function/Object (защита от import type)', () => {
    expect(Reflect.getMetadata('design:paramtypes', ChatUploadAccountDeletionAdapter)).toEqual([
      StorageService,
      AccountDeletionRegistry,
    ]);
  });

  it('та же линейка: paramtypes chat-file и voice-document адаптеров — настоящие классы', () => {
    expect(Reflect.getMetadata('design:paramtypes', ChatFileAccountDeletionAdapter)).toEqual([
      StorageService,
      AccountDeletionRegistry,
    ]);
    expect(Reflect.getMetadata('design:paramtypes', VoiceDocumentAccountDeletionAdapter)).toEqual([
      StorageService,
      AccountDeletionRegistry,
    ]);
  });

  it('AppModule: адаптер chat-upload.purge и сервис загрузок разрешимы в реальном графе', async () => {
    const { AppModule } = require('../../app.module');
    const container = await buildGraph(AppModule);
    const adapter = find(container, ChatUploadAccountDeletionAdapter);
    expect(adapter).toBeInstanceOf(ChatUploadAccountDeletionAdapter);
    // Инжектировано именно StorageService, а не undefined/Object-заглушка.
    expect((adapter as { storage: unknown }).storage).toBeInstanceOf(StorageService);
    expect(find(container, ChatUploadsService)).toBeInstanceOf(ChatUploadsService);
    // LanguageService в конструкторе — @Optional(): без этой проверки потеря
    // провайдера прошла бы молча, и «файл удалён» всегда писался бы по-русски.
    expect((find(container, ChatUploadsService) as { language: unknown }).language).toBeInstanceOf(
      LanguageService,
    );
  });

  // Негативный контроль: проверка не резиновая — голый модуль с одним
  // адаптером (без CommonModule/AccountDeletionModule) рвёт граф ровно той
  // ошибкой, которую ловят пины выше.
  it('без импортов модулей граф на адаптере действительно рвётся', async () => {
    @Module({ providers: [ChatUploadAccountDeletionAdapter] })
    class BareAdapterModule {}

    await expect(buildGraph(BareAdapterModule)).rejects.toThrow(
      /ChatUploadAccountDeletionAdapter/,
    );
  });
});
