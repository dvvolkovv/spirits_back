import { GUARDS_METADATA, MODULE_METADATA } from '@nestjs/common/constants';
import { BadRequestException, ConflictException, HttpException, NotFoundException, NotImplementedException } from '@nestjs/common';
import { ProductActionsController } from './product-actions.controller';
import { ProductsModule } from './products.module';
import { ProductActionsService } from './product-actions.service';
import { ProductLifecycleService } from './product-lifecycle.service';
import { ProductLifecycleTool } from './product-lifecycle-tool';
import { JwtGuard } from '../common/guards/jwt.guard';
import { IpRateLimiter } from '../common/guards/ip-rate-limit';

const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const row = (kind: string) => ({ id: ID, user_id: 'u1', product_id: 'p1', kind, status: 'pending', channel: 'web', confirmed_via: null, payload: { name: 'М' }, result: null, created_at: new Date(), expires_at: new Date(Date.now() + 60_000), resolved_at: null, tg_chat_id: null, tg_message_id: null, product_name: 'М', purge_after: null });

function make(kind: string | null) {
  const actions = { get: jest.fn(async () => (kind ? row(kind) : null)), listPending: jest.fn(async () => [row('delete')]), cancel: jest.fn(async () => true) };
  const lifecycle = { completeDelete: jest.fn(async () => ({ ok: true })), completeCreateBot: jest.fn(async () => ({ ok: true })) };
  // check() по умолчанию ничего не бросает — лимит не исчерпан.
  const limiter = { check: jest.fn(async () => undefined) };
  return { ctrl: new ProductActionsController(actions as any, lifecycle as any, limiter as any), actions, lifecycle, limiter };
}
const user = { userId: 'u1', isAdmin: false };

describe('ручки карточки', () => {
  it('закрыты JwtGuard и зарегистрированы в ProductsModule вместе с сервисами', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, ProductActionsController)).toContain(JwtGuard);
    expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, ProductsModule)).toContain(ProductActionsController);
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, ProductsModule);
    for (const p of [ProductActionsService, ProductLifecycleService, ProductLifecycleTool]) expect(providers).toContain(p);
    const exported = Reflect.getMetadata(MODULE_METADATA.EXPORTS, ProductsModule);
    for (const p of [ProductActionsService, ProductLifecycleService]) expect(exported).toContain(p);
  });

  it('чужое или несуществующее — 404', async () => {
    const h = make(null);
    await expect(h.ctrl.get(user, ID)).rejects.toBeInstanceOf(NotFoundException);
    expect(h.actions.get).toHaveBeenCalledWith('u1', ID);
  });

  it('submit на чужое или несуществующее — 404, ни один сервис жизненного цикла не зовётся', async () => {
    const h = make(null);
    await expect(h.ctrl.submit(user, ID, { confirm: true })).rejects.toBeInstanceOf(NotFoundException);
    expect(h.actions.get).toHaveBeenCalledWith('u1', ID);
    expect(h.lifecycle.completeDelete).not.toHaveBeenCalled();
    expect(h.lifecycle.completeCreateBot).not.toHaveBeenCalled();
  });

  it('cancel на чужое или несуществующее — 404, actions.cancel не зовётся', async () => {
    const h = make(null);
    await expect(h.ctrl.cancel(user, ID)).rejects.toBeInstanceOf(NotFoundException);
    expect(h.actions.get).toHaveBeenCalledWith('u1', ID);
    expect(h.actions.cancel).not.toHaveBeenCalled();
  });

  it('удаление — только с confirm: true', async () => {
    const h = make('delete');
    await expect(h.ctrl.submit(user, ID, {})).rejects.toBeInstanceOf(BadRequestException);
    // Отказ трубы (нет confirm) — до вызова сервиса: иначе 400 ничего не
    // значил бы, а продукт всё равно уехал бы в удаление.
    expect(h.lifecycle.completeDelete).not.toHaveBeenCalled();
    await h.ctrl.submit(user, ID, { confirm: true, via: 'chat' });
    expect(h.lifecycle.completeDelete).toHaveBeenCalledWith({ userId: 'u1', actionId: ID, via: 'chat' });
  });

  it('бот — ключи из тела, по умолчанию подтверждено в кабинете', async () => {
    const h = make('create_bot');
    await h.ctrl.submit(user, ID, { set: { BOT_TOKEN: 't' } });
    expect(h.lifecycle.completeCreateBot).toHaveBeenCalledWith({ userId: 'u1', actionId: ID, set: { BOT_TOKEN: 't' }, via: 'cabinet' });
  });

  it('канарейка: токен бота из тела не всплывает ни в одном поле ответа', async () => {
    // Строка одноразовая и узнаваемая — если toView когда-нибудь подменят
    // спредом тела запроса, тест ловит это по буквальному совпадению, а не
    // по совпадению с именем ключа (BOT_TOKEN в самом вопросе — обычное
    // имя, которое легко случайно пропустить в фильтре "не содержит").
    // Строка в карточке, которую отдаёт actions.get — любая: токен уходит
    // ТОЛЬКО через тело запроса, а не через то, что подставлен мок.
    const h = make('create_bot');
    const v = await h.ctrl.submit(user, ID, { set: { BOT_TOKEN: '123456:FAKE_CANARY_VALUE_xxxxxxxxxxxxxxxxxxxx' } });
    expect(JSON.stringify(v)).not.toMatch(/FAKE_CANARY/);
  });

  it('смена ключей — в очереди 2', async () => {
    await expect(make('keys').ctrl.submit(user, ID, { set: {} })).rejects.toBeInstanceOf(NotImplementedException);
  });

  for (const kind of ['create_site', 'restore', 'revert', 'purge']) {
    it(`${kind} — журнальная запись, не карточка: подтверждать нечего (409)`, async () => {
      const h = make(kind);
      await expect(h.ctrl.submit(user, ID, {})).rejects.toBeInstanceOf(ConflictException);
      expect(h.lifecycle.completeDelete).not.toHaveBeenCalled();
      expect(h.lifecycle.completeCreateBot).not.toHaveBeenCalled();
    });
  }

  it('pending — список своих ожидающих, пропущенный через toView', async () => {
    const h = make('delete');
    const list = await h.ctrl.pending(user);
    expect(h.actions.listPending).toHaveBeenCalledWith('u1');
    expect(list).toEqual([expect.objectContaining({ id: ID, kind: 'delete', status: 'pending' })]);
    // toView, а не сырая строка: значений ключей здесь нет по построению.
    expect(JSON.stringify(list)).not.toMatch(/BOT_TOKEN/);
  });

  it('cancel — счастливый путь: снимает карточку и отдаёт её свежий вид', async () => {
    const h = make('delete');
    const v = await h.ctrl.cancel(user, ID);
    expect(h.actions.cancel).toHaveBeenCalledWith('u1', ID);
    expect(v).toMatchObject({ id: ID, kind: 'delete' });
  });

  it('лимит подтверждений исчерпан — 429, жизненный цикл не зовётся', async () => {
    const h = make('delete');
    h.limiter.check.mockRejectedValue(new HttpException({ error: 'rate_limited' }, 429));
    let caught: any;
    try {
      await h.ctrl.submit(user, ID, { confirm: true });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HttpException);
    expect(caught.getStatus()).toBe(429);
    expect(h.lifecycle.completeDelete).not.toHaveBeenCalled();
    expect(h.lifecycle.completeCreateBot).not.toHaveBeenCalled();
    // Лимит — первым делом, до похода в базу за карточкой: иначе он не
    // защищал бы от самого дорогого (getMe к Telegram), который происходит
    // уже внутри completeCreateBot.
    expect(h.actions.get).not.toHaveBeenCalled();
  });
});
