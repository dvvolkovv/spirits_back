import 'reflect-metadata';
import { TalerIdCalendarConnector, NotConnected, SourceUnavailable } from './talerid-calendar.connector';

/**
 * ⚠️ 12.10.2026: календарь TalerID перестал открываться на телефоне СОВСЕМ — ошибка вместо
 * данных, при живом TalerID.
 *
 * Причина: добавляя классы ошибок в этот файл, я вставил их МЕЖДУ `@Injectable()` и
 * `TalerIdCalendarConnector`. Декоратор прилип к NotConnected, коннектор остался без DI,
 * `this.oauth` стал undefined — и каждый вызов падал с «Cannot read properties of
 * undefined». Типы при этом сходились, юнит-тесты проходили: ломается только сборка
 * графа зависимостей в рантайме.
 *
 * Тест проверяет ровно это: метаданные Nest должны лежать НА КОННЕКТОРЕ.
 */
describe('TalerIdCalendarConnector: DI не оторван от класса', () => {
  it('@Injectable() стоит на коннекторе, а не на соседнем классе', () => {
    expect(Reflect.hasMetadata('__injectable__', TalerIdCalendarConnector)).toBe(true);
  });

  it('классы ошибок инъектируемыми НЕ являются', () => {
    expect(Reflect.hasMetadata('__injectable__', NotConnected)).toBe(false);
    expect(Reflect.hasMetadata('__injectable__', SourceUnavailable)).toBe(false);
  });

  it('конструктор коннектора объявляет свою зависимость', () => {
    const deps = Reflect.getMetadata('design:paramtypes', TalerIdCalendarConnector);
    expect(Array.isArray(deps)).toBe(true);
    expect(deps.length).toBe(1);   // TalerIdOauthService
  });
});
