import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { GUARDS_METADATA, MODULE_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { ProductsController } from './products.controller';
import { RunnerController } from './runner.controller';
import { HostController } from './host.controller';
import { ProductsModule } from './products.module';
import { JwtGuard } from '../common/guards/jwt.guard';
import { RunnerGuard } from './runner.guard';
import { HostGuard } from './host.guard';

/**
 * Регрессия по образцу src/common/guards/admin-routes.spec.ts.
 *
 * Клиентские маршруты продуктов отдают чужой код и историю правок; маршруты
 * раннера позволяют завершить ход и списать токены; маршрут агента хоста
 * отдаёт открытые токены и расшифрованные секреты ВСЕХ продуктов, стоящих в
 * очереди. Незакрытый маршрут здесь стоит дороже, чем в большинстве мест
 * кодовой базы.
 *
 * Файл сторожит ровно то, чего НЕ видит `new XController(mock)`: гвард, адрес,
 * регистрацию в модуле и то, во что превращается тело запроса по дороге к
 * маршруту. Каждая из этих четырёх вещей ломается молча — маршрут при этом
 * либо отсутствует (404), либо принимает что попало, а юнит-тесты остаются
 * зелёными.
 */
const guardsOf = (ctrl: any) => Reflect.getMetadata(GUARDS_METADATA, ctrl) ?? [];

const mainSrc = () => fs.readFileSync(path.join(__dirname, '..', 'main.ts'), 'utf8');

/**
 * Префикс читается из main.ts, а не берётся из головы: он там один на всё
 * приложение (`app.setGlobalPrefix('webhook')` — наследство маршрутов n8n), и
 * тест обязан считать адрес так же, как его считает Nest.
 */
function globalPrefix(): string {
  const m = mainSrc().match(/setGlobalPrefix\(\s*'([^']*)'/);
  if (!m) throw new Error('в main.ts не нашёлся setGlobalPrefix — тест потерял источник правды');
  return m[1];
}

/** Полный путь маршрута — тот самый, по которому в него стучатся снаружи. */
function routeOf(ctrl: any, method: string): string {
  const ctrlPath = Reflect.getMetadata(PATH_METADATA, ctrl) ?? '';
  const methodPath = Reflect.getMetadata(PATH_METADATA, ctrl.prototype[method]) ?? '';
  return `/${[globalPrefix(), ctrlPath, methodPath].join('/')}`.replace(/\/{2,}/g, '/');
}

/**
 * Тип, который Nest передаёт в ValidationPipe как metatype тела. Берётся из
 * САМОГО МАРШРУТА, а не из импорта DTO: тест, собравший трубу поверх
 * импортированного класса, проверял бы DTO, который маршрут может и не
 * использовать. Снятый `@Body() body: XDto` даёт здесь `Object`, на нём
 * ValidationPipe не проверяет ничего (см. toValidate внутри трубы) — и тело
 * уезжает в сервис как пришло.
 */
function bodyMetatype(ctrl: any, method: string): any {
  const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, ctrl, method) ?? {};
  // Ключи ROUTE_ARGS_METADATA имеют вид `<тип параметра>:<индекс>`.
  const key = Object.keys(args).find((k) => k.startsWith(`${RouteParamtypes.BODY}:`));
  if (!key) throw new Error(`у ${ctrl.name}.${method} нет параметра @Body — проверять нечего`);
  const types = Reflect.getMetadata('design:paramtypes', ctrl.prototype, method) ?? [];
  return types[args[key].index];
}

/**
 * Труба собирается НАСТРОЙКАМИ ИЗ main.ts, а не своими. Разница
 * поведенческая: `whitelist: true` срезал бы лишние поля, а
 * `enableImplicitConversion` превратил бы строку 'нет' в true — и проверки
 * ниже зеленели бы, ничего не сторожа. Пусть труба в тесте будет той же, что
 * на проде.
 */
function prodPipe(): ValidationPipe {
  const m = mainSrc().match(/new ValidationPipe\(\s*(\{[^)]*\})\s*\)/);
  if (!m) throw new Error('в main.ts не нашлась настройка ValidationPipe');
  const opts = new Function(`return (${m[1]})`)();
  return new ValidationPipe(opts);
}

/** Прогон тела по той же дороге, по какой оно идёт на проде. */
const through = (ctrl: any, method: string, body: any) =>
  prodPipe().transform(body, {
    type: 'body',
    metatype: bodyMetatype(ctrl, method),
    data: undefined,
  });

describe('охрана маршрутов products', () => {
  it('клиентские маршруты закрыты JwtGuard', () => {
    expect(guardsOf(ProductsController)).toContain(JwtGuard);
  });

  it('маршруты раннера закрыты RunnerGuard и НЕ пускают по JWT пользователя', () => {
    const guards = guardsOf(RunnerController);
    expect(guards).toContain(RunnerGuard);
    expect(guards).not.toContain(JwtGuard);
  });

  it('эндпоинты агента закрыты HostGuard, а не JwtGuard', () => {
    // JwtGuard здесь означал бы, что агент обязан иметь пользователя, которого
    // у него нет; отсутствие гварда — что задания вместе с токенами и
    // секретами раздаются всему интернету.
    const guards = guardsOf(HostController);
    expect(guards).toContain(HostGuard);
    expect(guards).not.toContain(JwtGuard);
  });
});

describe('регистрация в модуле', () => {
  it('все три контроллера объявлены в ProductsModule', () => {
    // Отдельная проверка, и она обязательна. Тесты вида `new HostController(mock)`
    // читают метаданные гвардов и остаются зелёными при забытой строке в
    // products.module.ts — а маршрут вернёт 404. Проверка providers это НЕ
    // заменяет: другой ключ метаданных.
    const controllers = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, ProductsModule) ?? [];
    expect(controllers).toContain(HostController);
    // Соседи перечислены не для симметрии: список задаётся одним литералом, и
    // правка, заменившая его целиком, унесла бы их вместе с маршрутами
    // кабинета и раннера.
    expect(controllers).toContain(ProductsController);
    expect(controllers).toContain(RunnerController);
  });
});

describe('адреса маршрутов', () => {
  it('агент хоста стучится ровно туда, где маршруты объявлены', () => {
    // Префикс контроллера ПУСТОЙ: в main.ts стоит setGlobalPrefix('webhook'),
    // и путь пишется целиком в самом маршруте. @Controller('webhook') дал бы
    // /webhook/webhook/products/host/poll — агент получил бы 404 при
    // полностью зелёном прогоне, потому что метаданные гвардов и вызовы
    // сервиса от этого не меняются.
    //
    // Адреса — контракт с ДРУГИМ репозиторием (product-runner, точка входа
    // host), поэтому сверяются с литералом, а не с выражением из тех же
    // метаданных.
    expect(routeOf(HostController, 'poll')).toBe('/webhook/products/host/poll');
    expect(routeOf(HostController, 'complete')).toBe('/webhook/products/host/jobs/:id/complete');
  });

  it('кнопки кабинета бьют туда же, куда ходит фронт', () => {
    expect(routeOf(ProductsController, 'create')).toBe('/webhook/products');
    expect(routeOf(ProductsController, 'retry')).toBe('/webhook/products/:id/retry');
  });

  it('уже работающие маршруты соседей не переехали', () => {
    // Живой контроль самого прибора: эти два адреса работают на проде, и если
    // routeOf считает их неверно, все утверждения выше ничего не стоят.
    expect(routeOf(RunnerController, 'poll')).toBe('/webhook/products/runner/poll');
    expect(routeOf(ProductsController, 'chat')).toBe('/webhook/products/:id/chat');
  });
});

describe('тело отчёта агента', () => {
  it('строковое «ok» не уезжает по успешному пути', async () => {
    // Без DTO это тело доходит до completeJob как есть: 'нет' — непустая
    // строка, то есть истина, и отказ агента записывается как успех. Продукт
    // получает порт и уезжает в running, не будучи развёрнутым.
    await expect(through(HostController, 'complete', { ok: 'нет' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('строковый порт не доезжает до COALESCE', async () => {
    // '8003' уехало бы прямо в COALESCE($2, port) — колонка int, и запись
    // упала бы 500-й уже внутри отчёта агента, оставив задание в running до
    // сборщика зависших.
    await expect(
      through(HostController, 'complete', { ok: true, port: '8003' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('порт вне диапазона не проходит', async () => {
    await expect(through(HostController, 'complete', { ok: true, port: 0 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      through(HostController, 'complete', { ok: true, port: 70000 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('отчёт без ok не проходит', async () => {
    // Отсутствующий признак исхода — это не «успех по умолчанию»: без него
    // completeJob пошёл бы по ветке отказа и похоронил бы развёрнутый продукт.
    await expect(through(HostController, 'complete', { port: 8003 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('нормальный отчёт проходит и приезжает своими типами', async () => {
    const ok = await through(HostController, 'complete', { ok: true, port: 8003 });
    expect(ok).toMatchObject({ ok: true, port: 8003 });
    expect(typeof (ok as any).port).toBe('number');

    const failed = await through(HostController, 'complete', { ok: false, error: 'не собралось' });
    expect(failed).toMatchObject({ ok: false, error: 'не собралось' });
  });
});

describe('тело заведения продукта', () => {
  const body = (over: any = {}) => ({ name: 'Селянська', slug: 'selyanska', kind: 'site', ...over });

  it('пустое имя не проходит', async () => {
    await expect(through(ProductsController, 'create', body({ name: '' }))).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('неизвестная форма продукта не проходит', async () => {
    await expect(
      through(ProductsController, 'create', body({ kind: 'сайт' })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('слаг с ведущим дефисом не проходит', async () => {
    // '-rf' уезжает именем каталога и аргументом docker/nginx, где ведущий
    // дефис разбирается как флаг. Форма слага — одна на весь модуль (SLUG_RE),
    // здесь она лишь смыкается с трубой.
    await expect(through(ProductsController, 'create', body({ slug: '-rf' }))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      through(ProductsController, 'create', body({ slug: 'Верхний Регистр' })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('секреты строкой не проходят', async () => {
    await expect(
      through(ProductsController, 'create', body({ secrets: 'BOT_TOKEN=123' })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('нормальное тело проходит', async () => {
    await expect(
      through(ProductsController, 'create', body({ secrets: { BOT_TOKEN: '123:abc' } })),
    ).resolves.toMatchObject({ slug: 'selyanska', kind: 'site' });
    // Секреты необязательны: сайт заводится без них.
    await expect(through(ProductsController, 'create', body())).resolves.toMatchObject({
      name: 'Селянська',
    });
  });
});
