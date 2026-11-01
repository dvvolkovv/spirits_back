import 'reflect-metadata';
import { ChatService } from './chat.service';
import { ChatController } from './chat.controller';
import { UserLlmProviderService } from '../common/services/user-llm-provider.service';

/**
 * Контролёр A9, пункт 1 (как в chat.service.guest-carry.spec.ts, но для
 * выбора модели ответов, spec 2026-10-31-global-llm-switch): конструкторы
 * ChatService и ChatController обязаны объявлять llmProvider КЛАССОМ
 * UserLlmProviderService, а не интерфейсом/type alias — интерфейс стирается
 * в Object при компиляции в JS, Nest не найдёт провайдер по типу Object, и
 * @Optional() молча подставит undefined: личный выбор и общий рубильник
 * перестанут работать без единой ошибки при старте. Ни один из существующих
 * тестов на llmProvider этого не заметит — харнессы подставляют его полем в
 * обход DI-контейнера (как и здесь redis в chat.service.guest-carry.spec.ts).
 *
 * llmProvider у обеих остаётся @Optional() — так повелось с Kimi, спеки
 * собирают оба класса позиционно и не трогают это здесь; сторож проверяет
 * только ТИП параметра, а не его обязательность (design:paramtypes не видит
 * сам декоратор @Optional()).
 */
describe('ChatService/ChatController: DI-тип выбора модели ответов', () => {
  it('ChatService объявляет llmProvider классом UserLlmProviderService', () => {
    const paramTypes = Reflect.getMetadata('design:paramtypes', ChatService);
    expect(Array.isArray(paramTypes)).toBe(true);
    expect(paramTypes).toContain(UserLlmProviderService);
  });

  it('ChatController объявляет llmProvider классом UserLlmProviderService', () => {
    const paramTypes = Reflect.getMetadata('design:paramtypes', ChatController);
    expect(Array.isArray(paramTypes)).toBe(true);
    expect(paramTypes).toContain(UserLlmProviderService);
  });
});
