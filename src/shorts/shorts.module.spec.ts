/**
 * Сходится ли граф Nest с модулем роликов — тем же способом, что
 * blog.module.spec.ts: scan + instance loader, без onModuleInit (ни базы, ни
 * Telegram, ни .env). Отдельно — что бот получает сервис роликов: он стоит в
 * TgBotService как @Optional, и разрыв графа там прошёл бы молча.
 */
import { NestContainer } from '@nestjs/core/injector/container';
import { InstanceLoader } from '@nestjs/core/injector/instance-loader';
import { Injector } from '@nestjs/core/injector/injector';
import { DependenciesScanner } from '@nestjs/core/scanner';
import { GraphInspector } from '@nestjs/core/inspector/graph-inspector';
import { MetadataScanner } from '@nestjs/core/metadata-scanner';
import { TgBotService } from '../tg-bot/tg-bot.service';
import { ShortsApprovalService } from './shorts-approval.service';
import { ShortsDirectorService } from './shorts-director.service';
import { ShortsModule } from './shorts.module';
import { ShortsPublisherService } from './shorts-publisher.service';
import { ShortsSchemaService } from './shorts-schema.service';
import { ShortsSettingsService } from './shorts-settings.service';
import { ShortsTopicService } from './shorts-topic.service';
import { ShortsWriterService } from './shorts-writer.service';
import { ShortsController } from './shorts.controller';
import { ShortsCron } from './shorts.cron';

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

describe('DI-граф роликов', () => {
  it('AppModule: все провайдеры роликов в графе', async () => {
    const { AppModule } = require('../app.module');
    const container = await buildGraph(AppModule);
    for (const cls of [
      ShortsSchemaService, ShortsSettingsService, ShortsTopicService, ShortsDirectorService, ShortsWriterService,
      ShortsApprovalService, ShortsPublisherService, ShortsCron, ShortsController,
    ]) {
      expect(find(container, cls)).toBeInstanceOf(cls as any);
    }
  });

  it('бот получает сервис роликов — @Optional не прячет разрыв графа', async () => {
    const { AppModule } = require('../app.module');
    const container = await buildGraph(AppModule);
    expect(find(container, TgBotService).shortsApproval).toBeInstanceOf(ShortsApprovalService);
  });

  it('без AgentsModule граф роликов ломается — проверка не резиновая', async () => {
    const { AppModule } = require('../app.module');
    const imports = Reflect.getMetadata('imports', ShortsModule);
    const saved = [...imports];
    imports.splice(imports.findIndex((m: any) => m?.name === 'AgentsModule'), 1);
    try {
      await expect(buildGraph(AppModule)).rejects.toThrow(/AgentsService|ShortsDirectorService/);
    } finally {
      imports.splice(0, imports.length, ...saved);
    }
  });

  it('ShortsCron виден ScheduleModule: четыре @Cron-метода', async () => {
    const { AppModule } = require('../app.module');
    const container = await buildGraph(AppModule);
    const cron = find(container, ShortsCron);
    const { SCHEDULE_CRON_OPTIONS } = require('@nestjs/schedule/dist/schedule.constants');
    const proto = Object.getPrototypeOf(cron);
    const crons = Object.getOwnPropertyNames(proto).filter((k) => Reflect.getMetadata(SCHEDULE_CRON_OPTIONS, proto[k]) !== undefined);
    expect(crons.sort()).toEqual(['prepare', 'publishDue', 'refillTopics', 'work']);
  });
});
