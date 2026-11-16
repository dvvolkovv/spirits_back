import 'reflect-metadata';
import { MeetingModule } from './meeting.module';
import { MeetWebhookController } from './meet-webhook.controller';
import { MeetingWebhookInboxStore } from './meet-webhook-inbox.store';
import { MeetingWebhookDeliveryService } from './meet-webhook-delivery.service';
import { PgService } from '../common/services/pg.service';
import { VoiceCallService } from '../voice-call/voice-call.service';
import { LiveKitClient } from '../voice-call/livekit.client';

describe('MeetingModule', () => {
  it('регистрирует inbox store и delivery service как providers', () => {
    const providers = Reflect.getMetadata('providers', MeetingModule) as unknown[];
    expect(providers).toEqual(
      expect.arrayContaining([MeetingWebhookInboxStore, MeetingWebhookDeliveryService]),
    );
  });

  // @nestjs/testing в проекте не установлен, поэтому композицию проверяем по
  // метаданным конструкторов и ручной сборкой графа тем же резолвером типов,
  // что использует Nest: любой сдвиг порядка или типа параметров сломает тест.
  it('конструкторы контроллера и delivery разрешаются по design:paramtypes', () => {
    expect(Reflect.getMetadata('design:paramtypes', MeetWebhookController)).toEqual([
      VoiceCallService, MeetingWebhookInboxStore, MeetingWebhookDeliveryService,
    ]);
    expect(Reflect.getMetadata('design:paramtypes', MeetingWebhookDeliveryService)).toEqual([
      MeetingWebhookInboxStore, VoiceCallService, LiveKitClient,
    ]);
    expect(Reflect.getMetadata('design:paramtypes', MeetingWebhookInboxStore)).toEqual([PgService]);
  });

  it('граф собирается из моков внешних зависимостей', () => {
    const registry = new Map<unknown, unknown>([
      [PgService, { query: jest.fn() }],
      [VoiceCallService, { load: jest.fn(), isActive: jest.fn() }],
      [LiveKitClient, { send: jest.fn() }],
    ]);
    const build = <T>(cls: new (...a: any[]) => T): T => {
      if (registry.has(cls)) return registry.get(cls) as T;
      const deps = (Reflect.getMetadata('design:paramtypes', cls) as any[]).map((d) => {
        expect(d).toBeDefined();
        return build(d);
      });
      const inst = new cls(...deps);
      registry.set(cls, inst);
      return inst;
    };
    const ctl = build(MeetWebhookController) as any;
    expect(ctl.inbox).toBeInstanceOf(MeetingWebhookInboxStore);
    expect(ctl.delivery).toBeInstanceOf(MeetingWebhookDeliveryService);
    expect(ctl.delivery.inbox).toBe(ctl.inbox);
  });
});
