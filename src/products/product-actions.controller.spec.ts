import { GUARDS_METADATA, MODULE_METADATA } from '@nestjs/common/constants';
import { BadRequestException, NotFoundException, NotImplementedException } from '@nestjs/common';
import { ProductActionsController } from './product-actions.controller';
import { ProductsModule } from './products.module';
import { ProductActionsService } from './product-actions.service';
import { ProductLifecycleService } from './product-lifecycle.service';
import { ProductLifecycleTool } from './product-lifecycle-tool';
import { JwtGuard } from '../common/guards/jwt.guard';

const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const row = (kind: string) => ({ id: ID, user_id: 'u1', product_id: 'p1', kind, status: 'pending', channel: 'web', confirmed_via: null, payload: { name: 'М' }, result: null, created_at: new Date(), expires_at: new Date(Date.now() + 60_000), resolved_at: null, tg_chat_id: null, tg_message_id: null, product_name: 'М', purge_after: null });

function make(kind: string | null) {
  const actions = { get: jest.fn(async () => (kind ? row(kind) : null)), listPending: jest.fn(async () => [row('delete')]), cancel: jest.fn(async () => true) };
  const lifecycle = { completeDelete: jest.fn(async () => ({ ok: true })), completeCreateBot: jest.fn(async () => ({ ok: true })) };
  return { ctrl: new ProductActionsController(actions as any, lifecycle as any), actions, lifecycle };
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
    await expect(make(null).ctrl.get(user, ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('удаление — только с confirm: true', async () => {
    const h = make('delete');
    await expect(h.ctrl.submit(user, ID, {})).rejects.toBeInstanceOf(BadRequestException);
    await h.ctrl.submit(user, ID, { confirm: true, via: 'chat' });
    expect(h.lifecycle.completeDelete).toHaveBeenCalledWith({ userId: 'u1', actionId: ID, via: 'chat' });
  });

  it('бот — ключи из тела, по умолчанию подтверждено в кабинете', async () => {
    const h = make('create_bot');
    await h.ctrl.submit(user, ID, { set: { BOT_TOKEN: 't' } });
    expect(h.lifecycle.completeCreateBot).toHaveBeenCalledWith({ userId: 'u1', actionId: ID, set: { BOT_TOKEN: 't' }, via: 'cabinet' });
  });

  it('смена ключей — в очереди 2', async () => {
    await expect(make('keys').ctrl.submit(user, ID, { set: {} })).rejects.toBeInstanceOf(NotImplementedException);
  });

  it('ответ — вид без значений ключей', async () => {
    const v = await make('delete').ctrl.get(user, ID);
    expect(v).toMatchObject({ id: ID, kind: 'delete', status: 'pending' });
    expect(JSON.stringify(v)).not.toMatch(/BOT_TOKEN/);
  });
});
