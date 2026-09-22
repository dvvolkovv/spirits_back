import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Logger,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { JwtGuard } from '../common/guards/jwt.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import { ProductsService } from './products.service';
import { TurnsService } from './turns.service';
import { TurnEventsService } from './turn-events.service';
import { ProvisioningService } from './provisioning.service';
import { BlockService } from './block.service';
import { assertUuid, CreateProductDto } from './products.dto';

@Controller('')
@UseGuards(JwtGuard)
export class ProductsController {
  private readonly logger = new Logger(ProductsController.name);

  constructor(
    private readonly products: ProductsService,
    private readonly turns: TurnsService,
    private readonly turnEvents: TurnEventsService,
    private readonly provisioning: ProvisioningService,
    private readonly blocks: BlockService,
  ) {}

  /**
   * Список продуктов кабинета — и заодно ответ на вопрос «забирает ли
   * кто-нибудь задания».
   *
   * ПОЧЕМУ ЗАГОЛОВОК, А НЕ ТЕЛО. Тело этого маршрута — МАССИВ, и фронт читает
   * его массивом (`Array.isArray(rows) ? rows : null` в productsApi.list).
   * Завернуть его в конверт `{ items, hostAgent }` значит сломать кабинет у
   * всех, кто не перезагрузил вкладку, — статика и API катятся одним
   * скриптом, но открытая вкладка живёт своей жизнью сутками.
   *
   * Заголовок несёт ГОТОВЫЙ ВЕРДИКТ, а не отметку времени. Свежесть считается
   * по часам сервера: браузер с уехавшими часами (а это ноутбук, проспавший
   * неделю, а не экзотика) сам посчитал бы «агент молчит два дня» при
   * исправном агенте.
   *
   * Молчание заголовка — это «неизвестно», а не «всё хорошо»: старый бэкенд и
   * прокси, срезающий незнакомые заголовки, обязаны давать отсутствие тревоги,
   * а не ложную тревогу (разбор — на стороне кабинета).
   *
   * ## ЧТО ИЗМЕНИЛ РЕЕСТР МАШИН (кусок 4а, задача 3б)
   *
   * Вердикт больше не «про агента вообще»: он про МАШИНЫ ЭТОГО ВЛАДЕЛЬЦА (см.
   * hostAgentsLiveForUser). Прежняя формулировка с двумя машинами молчала бы
   * ровно там, где нужна, — живой агент одной машины отвечал бы за мёртвого
   * соседа, — и это единственное место, где ложь видна пользователю.
   *
   * СЛОВАРЬ ЗАГОЛОВКА ЗАМОРОЖЕН: только `live` и `silent`. Кабинет сверяет
   * значение со списком известных и читает ЛЮБОЕ другое как «сервер ничего не
   * сказал», то есть ГАСИТ тревогу (productsApi.list). Поэтому подробность вида
   * `silent:clients` — не расширение, а выключение предупреждения у всех, кто
   * не обновил вкладку, и выключение молчаливое.
   *
   * ПОЛЯ В СТРОКЕ ПРОДУКТА ЗДЕСЬ НЕТ, хотя с реестром возражение 003 против
   * него отпало: машина перестала быть фактом «о хостинге вообще» и стала
   * колонкой продукта (`products.host_id`), так что поле было бы уместным —
   * оно одно может сказать, КАКОЙ из продуктов стоит на молчащей машине.
   * Отложено сознательно, и триггер называется: владелец, чьи продукты стоят на
   * ДВУХ машинах сразу. С задачи 4 (выбор машины при заведении) это состояние
   * стало ДОСТИЖИМЫМ — раньше метку продукту никто не ставил вовсе, — но ещё не
   * наступило: аудитория выводится из признака администратора, то есть все
   * продукты одного владельца уезжают на машины одной аудитории, а машина там
   * сегодня одна. Триггер сработает на второй машине той же аудитории либо на
   * владельце, у которого признак администратора менялся между заведениями.
   * До тех пор заголовок точен: «худшая из моих машин» — она и есть
   * единственная. Ставить поле раньше значит зафиксировать форму ответа,
   * которую читает другой репозиторий, не имея там ни одного читателя.
   *
   * ВТОРОЙ ЗАГОЛОВОК со списком машин (`own=live,clients=silent`) отвергнут по
   * третьей причине: это внутренняя топология в браузере КАЖДОГО пользователя.
   * Её тут не отдают принципиально — по тому же правилу, по которому из выборки
   * кабинета вычеркнуты host_ip и checkout_path (см. COLUMNS).
   */
  @Get('products')
  async list(@CurrentUser() user: any, @Res() res: Response) {
    const rows = await this.products.list(user.userId);
    // Отказ проверки не превращается в тревогу и не роняет список. Вердикт —
    // приписка к ответу, а не сам ответ: 500 вместо списка продуктов из-за
    // недоступной отметки был бы платой большей, чем вся польза от неё. В лог
    // причина при этом попадает — молчаливое «live» иначе означало бы
    // сломанную проверку, неотличимую от исправной.
    const live = await this.provisioning.hostAgentsLiveForUser(user.userId).catch((e: any) => {
      this.logger.error(`проверка агента хоста не прошла: ${e?.message}`);
      return true;
    });
    res.setHeader('X-Host-Agent', live ? 'live' : 'silent');
    return res.status(200).json(rows);
  }

  /**
   * Кнопка «Новый продукт». Поля перечисляются ЯВНО, по той же причине, что и
   * в chat(): ValidationPipe стоит с `whitelist: false`, лишнее из тела не
   * срезается, и спред отдал бы любому авторизованному пользователю право
   * завести продукт на чужой `userId`.
   *
   * ПРИЗНАК АДМИНИСТРАТОРА БЕРЁТСЯ У ГВАРДА, И БОЛЬШЕ НИГДЕ. `request.user`
   * кладёт JwtGuard, читая `ai_profiles_consolidated.isadmin`; ровно это
   * значение уезжает в кабинет и закрывает там вкладку «Продукты». Признак
   * решает, на машины какой аудитории уедет продукт (кусок 4а), то есть
   * второе понятие «свой пользователь» означало бы вкладку, открытую одному
   * правилу, и машину, выбранную другим.
   *
   * ИЗ ТЕЛА ОН НЕ ЧИТАЕТСЯ НИКОГДА: `whitelist: false` пропускает `isAdmin` в
   * body насквозь, и спред отдал бы любому желающему право поставить свой
   * продукт рядом с боевыми.
   *
   * `=== true`, а не приведение к истинности: `user` здесь `any`, и признак из
   * него доезжает без единой проверки типа. Любое не-`true` уводит продукт на
   * клиентскую машину — в сторону, где ошибка безобидна.
   */
  @Post('products')
  async create(@CurrentUser() user: any, @Body() body: CreateProductDto) {
    const r = await this.provisioning.create({
      userId: user.userId,
      name: body.name,
      slug: body.slug,
      kind: body.kind,
      secrets: body.secrets ?? {},
      isAdmin: user?.isAdmin === true,
    });
    // Наружу только id. Открытый токен раннера — ключ от чекаута продукта, он
    // нужен агенту хоста, а не браузеру; `return r` отправил бы его в ответ и
    // в логи прокси.
    return { id: r.productId };
  }

  /**
   * ПРИЗНАК АДМИНИСТРАТОРА — У ГВАРДА, И БОЛЬШЕ НИГДЕ. Ровно то же правило,
   * что у `create()` выше, и по той же причине: `request.user` кладёт JwtGuard,
   * читая `ai_profiles_consolidated.isadmin`, а ValidationPipe стоит с
   * `whitelist: false` — то есть `{"isAdmin": true}` в ТЕЛЕ доезжает до
   * маршрута насквозь и было бы правом погасить любой чужой продукт одной
   * строчкой в запросе.
   *
   * `=== true`, а не приведение к истинности: `user` здесь `any`, значение
   * доезжает без единой проверки типа, и строка `'false'` — истина. У
   * `create()` цена такой ошибки — продукт не на той машине; здесь — погашенный
   * чужой бизнес.
   */
  private assertAdmin(user: any): void {
    if (user?.isAdmin !== true) throw new ForbiddenException('Нет доступа');
  }

  /**
   * ГАШЕНИЕ ПРОДУКТА ПО ЖАЛОБЕ. Администратор присылает ОДНО поле — домен,
   * слаг или идентификатор; разбирает его сервер (см. `BlockService.lookup`).
   *
   * ## ЗАЩИЩАЕТ ГВАРД, А НЕ ОДНА СТРОКА В ТЕЛЕ МЕТОДА
   *
   * `@UseGuards(AdminGuard)` — тот же способ, которым закрыты все прочие
   * административные поверхности этого репозитория (admin, agents, vmm, blog,
   * backlog, integrations), и это не симметрия ради симметрии:
   *
   *   - проверка в теле метода не видна СНАРУЖИ. Сторож
   *     `common/guards/admin-routes.spec.ts` обходит маршруты по метаданным
   *     гвардов и про тело метода не знает ничего; дыра, которую он однажды
   *     нашёл (13 маршрутов AdminController с одним JwtGuard), выглядела
   *     ровно так же — «проверка же есть»;
   *   - гвард отбивает ДО разбора тела и до всякого обращения к сервису;
   *   - AdminGuard читает `isadmin` из базы СВЕЖИМ запросом, а `req.user`
   *     несёт значение из кеша JwtGuard на 60 секунд. Снятые права начинают
   *     действовать сразу, а не через минуту.
   *
   * Проверка в теле при этом ОСТАЁТСЯ, и не как перестраховка: два рубежа
   * краснеют в разных прогонах. Снятый декоратор ловит
   * `products.routes.spec.ts` (юнит-тесты маршрута зовут метод напрямую и
   * гвардов не исполняют вовсе), снятую строку — юнит-тесты маршрута
   * (метаданные гвардов от неё не меняются). Каждый рубеж поодиночке
   * снимается одной правкой при зелёном прогоне соседа.
   *
   * ## ТЕЛО БЕЗ DTO — РЕШЕНИЕ, А НЕ ЗАБЫВЧИВОСТЬ
   *
   * `@Body()` с литеральным типом даёт ValidationPipe metatype `Object`, на
   * котором она не проверяет ничего (см. `bodyMetatype` в
   * products.routes.spec.ts). Здесь это допустимо ровно потому, что оба поля
   * проверяет сам сервис и проверяет СТРОГО: не-строка и пустая строка — это
   * 400 с объяснением (`lookup`, «за что гасим»), а не 500 из глубины
   * запроса. DTO дал бы второе место, где живёт та же проверка, и первое
   * расхождение между ними прошло бы незамеченным.
   *
   * ## ЧТО В ОТВЕТЕ
   *
   * Не `{ ok: true }`. Искали по строке из жалобы — значит в ответе обязано
   * быть, ЧТО именно погашено: слаг, идентификатор, чем разобран ключ, каким
   * был статус и сколько чужих идущих правок при этом убито. Разбор — у
   * `BlockResult`.
   *
   * ## ПОЧЕМУ ЭТИ ДВА МАРШРУТА ОБЪЯВЛЕНЫ ВЫШЕ ВСЕХ `products/:id/...`
   *
   * Сегодня двухсегментного `POST products/:id` в контроллере нет, и
   * столкнуться не с чем. Но Nest разбирает маршруты В ПОРЯДКЕ ОБЪЯВЛЕНИЯ, и
   * такой маршрут, появившись выше, молча съел бы `products/block`: гашение
   * уехало бы в чужой обработчик с `id = 'block'`, а прогон остался бы
   * зелёным — юнит-тесты зовут методы напрямую, мимо маршрутизатора.
   */
  @Post('products/block')
  @UseGuards(AdminGuard)
  async block(@CurrentUser() user: any, @Body() body: { key: string; reason: string }) {
    this.assertAdmin(user);
    return this.blocks.block(body?.key, body?.reason);
  }

  /**
   * Снятие блокировки. Отдельный маршрут, а не флаг в теле гашения: «погасить»
   * и «вернуть» — разные решения с разными последствиями, и опечатка в
   * значении флага не должна превращать одно в другое.
   *
   * Причины здесь нет намеренно: снятие стирает `block_reason` (см.
   * `BlockService.unblock`), и писать туда нечего.
   */
  @Post('products/unblock')
  @UseGuards(AdminGuard)
  async unblock(@CurrentUser() user: any, @Body() body: { key: string }) {
    this.assertAdmin(user);
    return this.blocks.unblock(body?.key);
  }

  /**
   * Кнопка «повторить» на карточке сорванного заведения. Владение и состояние
   * проверяет сам сервис — одним оператором вместе с постановкой задания.
   */
  @Post('products/:id/retry')
  async retry(@CurrentUser() user: any, @Param('id') id: string) {
    assertUuid(id, 'Product');
    await this.provisioning.retry(id, user.userId);
    return { ok: true };
  }

  @Get('products/:id/turns')
  async history(@CurrentUser() user: any, @Param('id') id: string, @Res() res: Response) {
    assertUuid(id, 'Product');
    await this.products.getOwned(id, user.userId);
    return res.status(200).json(await this.turns.history(id, user.userId));
  }

  /**
   * Заголовки скопированы из chat.controller.ts: X-Accel-Buffering: no
   * обязателен, иначе nginx придержит чанки и стриминг превратится в один
   * ответ в конце.
   *
   * Поля в enqueue перечисляются ЯВНО. Спред тела вернул бы дыру: клиент
   * прислал бы revertToSha и получил право сбросить прод на произвольный
   * коммит мимо всех проверок revert(). ValidationPipe с whitelist: false
   * лишнее не срежет.
   */
  @Post('products/:id/chat')
  async chat(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() body: { prompt: string },
    @Req() req: Request,
    @Res() res: Response,
  ) {
    assertUuid(id, 'Product');
    await this.products.getOwned(id, user.userId);
    const turn = await this.turns.enqueue({
      productId: id,
      userId: user.userId,
      channel: 'web',
      prompt: body.prompt,
    });

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');

    // Обрыв клиента прекращает чтение. Без этого генератор крутится до своего
    // предела в 15 минут, опрашивая Redis и Postgres ради ответа, который
    // некому принять: nginx рвёт соединение по proxy_read_timeout заметно
    // раньше, а воркер Node всё это время занят. На параллельных ходах это
    // накопительная утечка.
    //
    // Ход при этом не прерывается — он живёт на VM и договорит сам. Клиент
    // дочитает результат из истории.
    let clientGone = false;
    req.on('close', () => {
      clientGone = true;
    });

    try {
      // Внешняя проверка `if (clientGone) break` остаётся: она закрывает
      // гонку внутри одного тика, когда `readEvents` уже отдал событие, а
      // обрыв случился, пока мы дописывали предыдущее в сокет. Основная
      // защита — предикат `isCancelled`, переданный внутрь генератора: без
      // него отмена не срабатывает, пока поток тихий (см. readEvents).
      for await (const event of this.turnEvents.readEvents(id, turn.id, () => clientGone)) {
        if (clientGone) break;
        res.write(JSON.stringify(event) + '\n');
      }
    } catch (e: any) {
      // Заголовки уже ушли, поэтому фильтр исключений Nest отдать чистый JSON
      // не сможет — клиент увидел бы обрыв сокета без объяснения. Отдаём
      // событие error, чтобы NDJSON-парсер на той стороне получил внятное
      // завершение.
      this.logger.error(`chat: поток хода ${turn.id} прерван: ${e?.message}`);
      if (!clientGone) {
        res.write(JSON.stringify({ type: 'error', message: 'Поток прерван' }) + '\n');
      }
    }
    if (!clientGone) res.end();
  }

  @Post('products/:id/turns/:turnId/revert')
  async revert(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Param('turnId') turnId: string,
    @Res() res: Response,
  ) {
    assertUuid(id, 'Product');
    // Оба параметра, а не только первый: turnId уезжает в такой же
    // `WHERE id = $1` внутри revert().
    assertUuid(turnId, 'Turn');
    await this.products.getOwned(id, user.userId);
    const turn = await this.turns.revert({ productId: id, turnId, userId: user.userId });
    return res.status(202).json(turn);
  }
}
