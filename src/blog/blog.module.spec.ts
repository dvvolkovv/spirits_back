/**
 * Сходится ли граф зависимостей Nest. Ни `tsc`, ни обычные юнит-тесты этого
 * не проверяют: они не поднимают контейнер, а собирают сервисы руками с
 * моками. Развалившийся граф виден только на старте приложения — то есть на
 * проде, после деплоя.
 *
 * @nestjs/testing в проекте не установлен, поэтому поднимаем ровно те
 * внутренности @nestjs/core, которые дёргает NestFactory: scan + instance
 * loader. Именно createInstancesOfDependencies() бросает
 * "Nest can't resolve dependencies". Lifecycle-хуки (onModuleInit) при этом
 * НЕ вызываются — телеграм-вебхук, коннекты к БД и таймеры не поднимаются,
 * и .env тоже не нужен.
 */
import { NestContainer } from '@nestjs/core/injector/container';
import { InstanceLoader } from '@nestjs/core/injector/instance-loader';
import { Injector } from '@nestjs/core/injector/injector';
import { DependenciesScanner } from '@nestjs/core/scanner';
import { GraphInspector } from '@nestjs/core/inspector/graph-inspector';
import { MetadataScanner } from '@nestjs/core/metadata-scanner';

import { BlogModule } from './blog.module';
import { BlogSettingsService } from './blog-settings.service';
import { BlogTopicService } from './blog-topic.service';
import { BlogGitSource } from './blog-git.source';
import { BlogNewsService } from './blog-news.service';
import { BlogRelayClient } from './blog-relay.client';
import { BlogEditorService } from './blog-editor.service';
import { BlogImageService } from './blog-image.service';
import { BlogPublisherService } from './blog-publisher.service';
import { BlogApprovalService } from './blog-approval.service';
import { BlogCron } from './blog.cron';
import { BlogController } from './blog.controller';

jest.setTimeout(120000);

async function buildGraph(root: any): Promise<NestContainer> {
  const container = new NestContainer();
  const graphInspector = new GraphInspector(container);
  const scanner = new DependenciesScanner(container, new MetadataScanner(), graphInspector);
  await scanner.scan(root);
  const loader = new InstanceLoader(container, new Injector(), graphInspector);
  await loader.createInstancesOfDependencies();
  return container;
}

function find(container: NestContainer, cls: any): any {
  for (const [, mod] of container.getModules()) {
    const p = mod.providers.get(cls) || mod.controllers.get(cls);
    if (p && p.instance) return p.instance;
  }
  return undefined;
}

describe('DI graph', () => {
  it('AppModule: граф всего приложения сходится, все провайдеры блога в нём есть', async () => {
    const { AppModule } = require('../app.module');
    const container = await buildGraph(AppModule);
    for (const cls of [
      BlogSettingsService, BlogTopicService, BlogGitSource, BlogNewsService, BlogRelayClient,
      BlogEditorService, BlogImageService, BlogPublisherService,
      BlogApprovalService, BlogCron, BlogController,
    ]) {
      expect(find(container, cls)).toBeInstanceOf(cls as any);
    }
  });

  // Негативный контроль: проверка не резиновая — снимаем MiscModule из
  // импортов блога и убеждаемся, что граф рвётся.
  it('без MiscModule граф блога действительно ломается', async () => {
    const { AppModule } = require('../app.module');
    const imports = Reflect.getMetadata('imports', BlogModule);
    const saved = [...imports];
    imports.splice(imports.findIndex((m: any) => m?.name === 'MiscModule'), 1);
    try {
      await expect(buildGraph(AppModule)).rejects.toThrow(/BlogImageService|MiscService/);
    } finally {
      imports.splice(0, imports.length, ...saved);
    }
  });

  // ScheduleModule.forRoot() подключён глобально в app.module.ts и находит
  // краны через DiscoveryService по всему контейнеру. Проверяем ровно это:
  // BlogCron виден обходу провайдеров и на его методах есть SCHEDULE_CRON_OPTIONS.
  it('BlogCron виден ScheduleModule: шесть @Cron-методов с метаданными', async () => {
    const { AppModule } = require('../app.module');
    const container = await buildGraph(AppModule);
    const wrappers = [...container.getModules().values()]
      .flatMap((m) => [...m.providers.values()])
      .filter((w) => w.instance instanceof BlogCron);
    expect(wrappers.length).toBeGreaterThan(0);

    // ScheduleExplorer должен быть в графе — иначе @Cron некому обойти.
    const explorers = [...container.getModules().values()]
      .flatMap((m) => [...m.providers.values()])
      .filter((w) => w.instance && w.instance.constructor?.name === 'ScheduleExplorer');
    expect(explorers.length).toBeGreaterThan(0);

    const { SCHEDULE_CRON_OPTIONS } = require('@nestjs/schedule/dist/schedule.constants');
    const proto = Object.getPrototypeOf(wrappers[0].instance);
    const crons = Object.getOwnPropertyNames(proto).filter(
      (k) => Reflect.getMetadata(SCHEDULE_CRON_OPTIONS, proto[k]) !== undefined,
    );
    expect(crons.sort()).toEqual(
      ['dropStaleNews', 'prepareDrafts', 'publishDue', 'rearmStuck', 'refillTopics', 'remindPending'],
    );
  });
});
