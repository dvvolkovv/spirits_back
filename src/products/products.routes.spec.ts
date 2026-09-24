import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { BadRequestException, RequestMethod, ValidationPipe } from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { ProductsController } from './products.controller';
import { RunnerController } from './runner.controller';
import { HostController } from './host.controller';
import { ProductsModule } from './products.module';
import { JwtGuard } from '../common/guards/jwt.guard';
import { AdminGuard } from '../common/guards/admin.guard';
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

/**
 * Гварды, действующие НА МЕТОД: с класса плюс свои. Прочитать только класс
 * здесь мало — у продуктов контроллер один на всех, и административные
 * маршруты закрываются вторым гвардом поштучно (образец — common/guards/
 * admin-routes.spec.ts, откуда взята и эта функция).
 */
const guardsFor = (ctrl: any, method: string): unknown[] => [
  ...(Reflect.getMetadata(GUARDS_METADATA, ctrl) ?? []),
  ...(Reflect.getMetadata(GUARDS_METADATA, ctrl.prototype[method]) ?? []),
];

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
function pathOf(ctrl: any, method: string): string {
  const ctrlPath = Reflect.getMetadata(PATH_METADATA, ctrl) ?? '';
  const methodPath = Reflect.getMetadata(PATH_METADATA, ctrl.prototype[method]) ?? '';
  return `/${[globalPrefix(), ctrlPath, methodPath].join('/')}`.replace(/\/{2,}/g, '/');
}

/**
 * Адрес ЦЕЛИКОМ, вместе с глаголом: «POST /webhook/products/host/poll».
 *
 * Глагол лежит под ДРУГИМ ключом метаданных (METHOD_METADATA), чем путь, и
 * сторож, читающий только путь, переживает замену @Post на @Get целиком:
 * измерено — все тесты зелёные, живой сервер отдаёт
 * `404 Cannot POST /webhook/products/host/poll`. Поэтому глагол склеен с
 * путём: адрес маршрута — это пара, и врозь они не сторожатся.
 */
function endpointOf(ctrl: any, method: string): string {
  const verb = Reflect.getMetadata(METHOD_METADATA, ctrl.prototype[method]);
  return `${RequestMethod[verb]} ${pathOf(ctrl, method)}`;
}

/** Все методы контроллера, объявленные маршрутами. */
const routeMethodsOf = (ctrl: any): string[] =>
  Object.getOwnPropertyNames(ctrl.prototype).filter(
    (m) => m !== 'constructor' && Reflect.hasMetadata(PATH_METADATA, ctrl.prototype[m]),
  );

/** Имена, которые маршрут спрашивает у пути через @Param('…'). */
function paramNamesOf(ctrl: any, method: string): string[] {
  const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, ctrl, method) ?? {};
  return Object.keys(args)
    .filter((k) => k.startsWith(`${RouteParamtypes.PARAM}:`))
    .map((k) => args[k].data)
    .sort();
}

/** Имена, которые путь на самом деле объявляет: `:id`, `:turnId`. */
const placeholdersOf = (ctrl: any, method: string): string[] =>
  [...pathOf(ctrl, method).matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]).sort();

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

  it('маршруты гашения закрыты AdminGuard, а не одной проверкой в теле метода', () => {
    // РЕГРЕССИЯ ПО ОБРАЗЦУ РЕАЛЬНОЙ ДЫРЫ (28.07.2026, admin-routes.spec.ts): у
    // 13 маршрутов AdminController стоял только JwtGuard, то есть проверялось
    // «залогинен», а роль — нет. Проверка внутри тела метода от этой дыры не
    // отличается НИЧЕМ снаружи: сторожа обходят маршруты по метаданным
    // гвардов и про тело не знают.
    //
    // Гашение — самое дорогое действие модуля: оно останавливает чужой
    // работающий бизнес и убивает идущую правку.
    for (const method of ['block', 'unblock']) {
      expect(guardsFor(ProductsController, method)).toContain(AdminGuard);
      // JwtGuard тоже обязателен, и он с класса: AdminGuard читает
      // `request.user`, которого без JwtGuard нет вовсе — гвард отказал бы
      // всем подряд, а на пустом `user?.userId` это выглядело бы как «просто
      // не пускает».
      expect(guardsFor(ProductsController, method)).toContain(JwtGuard);
    }
  });

  it('AdminGuard стоит ПОШТУЧНО и не закрывает кабинет', () => {
    // Обратная половина. Тот же AdminGuard, поднятый на класс, — это не
    // «строже», а выключенный кабинет: список, заведение, чат и история
    // перестанут работать у всех, кроме администраторов. Прогон при этом
    // остаётся зелёным везде, кроме этой строки.
    for (const method of ['list', 'create', 'chat', 'history', 'retry', 'revert']) {
      expect(guardsFor(ProductsController, method)).not.toContain(AdminGuard);
    }
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
    // метаданных. Глагол — часть адреса: см. endpointOf.
    expect(endpointOf(HostController, 'poll')).toBe('POST /webhook/products/host/poll');
    expect(endpointOf(HostController, 'complete')).toBe(
      'POST /webhook/products/host/jobs/:id/complete',
    );
  });

  it('опрос агента берёт ВЕСЬ ЗАПРОС, и ничего кроме', () => {
    // Метку машины кладёт на запрос HostGuard, и добраться до неё можно только
    // через @Req(). Юнит-тесты маршрута зовут `ctrl.poll({ hostId: 'own' })`
    // напрямую и про декоратор не знают вовсе: снятый @Req остаётся там зелёным
    // и ломается на живом сервере — Nest передаст undefined, и опрос агента
    // станет 500-кой на каждом обороте.
    //
    // Вторая половина — «и ничего кроме»: @Body() у этого маршрута быть не
    // должно. Метка, взятая из тела, была бы заявлением агента о себе, то есть
    // правом одной строчкой в запросе забрать чужие задания вместе с
    // расшифрованными секретами чужих продуктов.
    const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, HostController, 'poll') ?? {};
    expect(Object.keys(args).map((k) => Number(k.split(':')[0]))).toEqual([
      RouteParamtypes.REQUEST,
    ]);
  });

  it('кнопки кабинета бьют туда же, куда ходит фронт', () => {
    expect(endpointOf(ProductsController, 'create')).toBe('POST /webhook/products');
    expect(endpointOf(ProductsController, 'retry')).toBe('POST /webhook/products/:id/retry');
  });

  it('ручки своего домена стоят по адресам, которые зовёт кабинет', () => {
    // Адреса — контракт с ДРУГИМ репозиторием (spirits_front, productsApi.ts),
    // поэтому сверяются с литералом.
    expect(endpointOf(ProductsController, 'getDomain')).toBe('GET /webhook/products/:id/domain');
    expect(endpointOf(ProductsController, 'attachDomain')).toBe('POST /webhook/products/:id/domain');
    expect(endpointOf(ProductsController, 'checkDomain')).toBe('POST /webhook/products/:id/domain/check');
    expect(endpointOf(ProductsController, 'detachDomain')).toBe('DELETE /webhook/products/:id/domain');
  });

  it('гашение и снятие стоят по своим адресам и не съедают друг друга', () => {
    // Адрес здесь — не формальность: кнопки у этих маршрутов нет вовсе (общего
    // списка продуктов у администратора нет, решение владельца от 21.09.2026),
    // и зовут их руками по жалобе. Переехавший адрес не обнаружит никто, кроме
    // человека, которому в этот момент нужно погасить чужой сайт.
    expect(endpointOf(ProductsController, 'block')).toBe('POST /webhook/products/block');
    expect(endpointOf(ProductsController, 'unblock')).toBe('POST /webhook/products/unblock');
  });

  it('ни один маршрут кабинета не занимает двухсегментный POST products/<что-то>', () => {
    // Nest разбирает маршруты В ПОРЯДКЕ ОБЪЯВЛЕНИЯ. `@Post('products/:id')`,
    // появившись выше, молча съел бы оба адреса гашения: запрос уехал бы в
    // чужой обработчик с `id = 'block'`, а весь прогон остался бы зелёным —
    // юнит-тесты зовут методы напрямую, мимо маршрутизатора.
    //
    // Сторожится не порядок (его в метаданных нет), а САМО СУЩЕСТВОВАНИЕ
    // такого маршрута: пока его нет, столкнуться не с чем.
    const shaped = routeMethodsOf(ProductsController)
      .map((m) => ({ m, path: pathOf(ProductsController, m) }))
      .filter(({ path }) => /^\/webhook\/products\/[^/]+$/.test(path) && path.includes(':'));

    expect(shaped).toEqual([]);
  });

  it('уже работающие маршруты соседей не переехали', () => {
    // Живой контроль самого прибора: эти адреса работают на проде, и если
    // endpointOf считает их неверно, все утверждения выше ничего не стоят.
    // GET здесь заодно доказывает, что глагол действительно читается, а не
    // подставляется одинаковым.
    expect(endpointOf(RunnerController, 'poll')).toBe('POST /webhook/products/runner/poll');
    expect(endpointOf(ProductsController, 'chat')).toBe('POST /webhook/products/:id/chat');
    expect(endpointOf(ProductsController, 'list')).toBe('GET /webhook/products');
  });

  it('каждый :плейсхолдер пути спрашивается @Param-ом с тем же именем', () => {
    // Имя в @Param('id') и имя в пути ':id' — два независимых литерала, и
    // Nest их не сверяет. Разъехавшись, они дают `undefined` в аргументе
    // маршрута: у агента отчёт уходит в `WHERE id = NULL` (ноль строк, ответ
    // { ok: true }, задание висит в running до сборщика), у кнопки «повторить»
    // — вечная 404. Оба случая полностью зелёные на юнит-тестах: те зовут
    // ctrl.complete('j-1', body) позиционно и про имена не знают.
    //
    // Сверка идёт со САМИМ ПУТЁМ, а не со списком литералов: переименование
    // ':id' в ':jobId' вместе с @Param остаётся законным, а разъезд — нет.
    let checked = 0;
    for (const ctrl of [ProductsController, RunnerController, HostController]) {
      for (const method of routeMethodsOf(ctrl)) {
        const where = `${ctrl.name}.${method}`;
        expect({ where, params: paramNamesOf(ctrl, method) }).toEqual({
          where,
          params: placeholdersOf(ctrl, method),
        });
        checked += placeholdersOf(ctrl, method).length;
      }
    }
    // Сторож самого цикла: пустой обход прошёл бы зелёным и ничего не значил.
    // Сегодня плейсхолдеров шесть — chat, history, revert (два), retry,
    // complete агента, events и complete раннера.
    expect(checked).toBeGreaterThanOrEqual(6);
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

  it('дробный порт не проходит', async () => {
    // @IsNumber вместо @IsInt проверки выше переживает целиком: 8003.5 и
    // число, и в диапазоне. А уезжает оно в COALESCE($2, port) по колонке int
    // и роняет запись 500-й внутри отчёта агента — тот же исход, что у
    // строкового порта, и невидимый теми же тестами.
    await expect(
      through(HostController, 'complete', { ok: true, port: 8003.5 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('длинная причина отказа НЕ отбивается: её режет сервер, а не труба', async () => {
    // Потолок в валидаторе означал бы 400 в ответ агенту на честном отчёте
    // (`docker build` со stderr — это тысячи символов). Агент отчёт в try не
    // заворачивает: 400 всплыл бы из цикла опроса и убил бы процесс, а
    // задание висело бы в running до сборщика зависших. Подрезка живёт в
    // маршруте — см. тест про ERROR_MAX в host.controller.spec.ts.
    const huge = 'у'.repeat(50_000);

    const ok = await through(HostController, 'complete', { ok: false, error: huge });

    expect((ok as any).error).toHaveLength(50_000);
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

  it('имя из одних пробелов не проходит', async () => {
    // @MinLength(1) считает пробелы символами, поэтому '   ' проходил бы, и в
    // кабинете появлялся бы продукт с пустым именем — переименовать его нечем.
    await expect(
      through(ProductsController, 'create', body({ name: '   ' })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('имя приезжает подрезанным по краям', async () => {
    const ok = await through(ProductsController, 'create', body({ name: '  Селянська  ' }));
    expect((ok as any).name).toBe('Селянська');
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
