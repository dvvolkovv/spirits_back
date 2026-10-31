// src/guest-trial/guest-trial.module.spec.ts
import 'reflect-metadata';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { GuestTrialModule } from './guest-trial.module';
import { ChatModule } from '../chat/chat.module';
import { ChatService } from '../chat/chat.service';
import { EventsService } from '../events/events.service';
import { Neo4jService } from '../neo4j/neo4j.service';
import { GuestTrialController } from './guest-trial.controller';
import { GuestTrialStore } from './guest-trial-store.service';
import { GuestSessionsService } from './guest-sessions.service';
import { GuestTurnService } from './guest-turn.service';
import { GuestClaimService } from './guest-claim.service';
import { GuestTrialCron } from './guest-trial.cron';

/**
 * GuestTurnService принимает ChatService/EventsService, а GuestClaimService —
 * EventsService, оба как @Optional() — это нужно их позиционным спекам
 * (A8/A9: `new GuestTurnService(pg, redis, cli, store, sessions)` без
 * хвоста; аналогично часть вызовов `new GuestClaimService(pg, redis)` в
 * guest-claim.pg.spec.ts). Обратная сторона (дополнение к A10, перед её
 * стартом): забытый импорт модуля или подмена типа параметра на интерфейс в
 * конструкторе не роняет старт — DI молча подставит undefined. deploy.sh
 * перестанет видеть гостевые ходы (ChatService.beginStream/endStream),
 * события и статистика пробы опустеют без единой ошибки в логе. Сторож — по
 * образцу chat.module.chat-files.spec.ts (состав модуля) и
 * chat.service.guest-carry.spec.ts (design:paramtypes самого сервиса).
 *
 * Решение владельца 31.10.2026: GuestClaimService больше НЕ принимает
 * Neo4jService — перенос пробы в аккаунт не дополняет профиль ценностей
 * (общий компьютер, см. комментарий в guest-claim.service.ts). Проверяем это
 * явно (deps не должен содержать Neo4jService), а не только то, что сервис
 * собирается, — случайный возврат зависимости (например, копипастой из
 * GuestTurnService) иначе прошёл бы незамеченным.
 */
describe('GuestTrialModule: граф зависимостей не оторван', () => {
  it('импортирует ChatModule (иначе ChatService придёт как undefined)', () => {
    expect(Reflect.getMetadata(MODULE_METADATA.IMPORTS, GuestTrialModule)).toContain(ChatModule);
  });

  // Ревью A10: дополняет проверку выше с другой стороны графа — ChatModule
  // должен ПРОДОЛЖАТЬ экспортировать ChatService. Забытое экспортирование
  // (например, при рефакторинге ChatModule) не роняет старт — @Optional() в
  // GuestTurnService молча подставит undefined, ровно как и забытый импорт.
  it('ChatModule экспортирует ChatService', () => {
    expect(Reflect.getMetadata(MODULE_METADATA.EXPORTS, ChatModule)).toContain(ChatService);
  });

  it('регистрирует все пять провайдеров', () => {
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, GuestTrialModule);
    expect(providers).toContain(GuestTrialStore);
    expect(providers).toContain(GuestSessionsService);
    expect(providers).toContain(GuestTurnService);
    expect(providers).toContain(GuestClaimService);
    expect(providers).toContain(GuestTrialCron);
  });

  it('регистрирует контроллер', () => {
    expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, GuestTrialModule)).toContain(GuestTrialController);
  });

  it('GuestTurnService объявляет ChatService и EventsService классами, не Object', () => {
    const deps = Reflect.getMetadata('design:paramtypes', GuestTurnService);
    expect(Array.isArray(deps)).toBe(true);
    expect(deps).toContain(ChatService);
    expect(deps).toContain(EventsService);
  });

  it('GuestClaimService объявляет EventsService классом, не Object, и больше не зависит от Neo4jService', () => {
    const deps = Reflect.getMetadata('design:paramtypes', GuestClaimService);
    expect(Array.isArray(deps)).toBe(true);
    expect(deps).toContain(EventsService);
    expect(deps).not.toContain(Neo4jService);
  });
});
