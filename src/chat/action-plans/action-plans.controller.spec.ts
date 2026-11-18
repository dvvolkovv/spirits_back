import 'reflect-metadata';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { ActionPlansController } from './action-plans.controller';

/**
 * Лента одна (spec 2026-11-17-context-reset): план действий — по основной
 * переписке, `freshTs` старых клиентов до сервиса не доезжает.
 */
describe('ActionPlansController: без freshTs', () => {
  function makeCtrl() {
    const plans = {
      generate: jest.fn(async () => ({ id: 'plan-1' })),
      findForConversation: jest.fn(async () => null),
    };
    return { ctrl: new ActionPlansController(plans as any), plans };
  }

  it('generate — только пользователь и ассистент, freshTs из тела не передаётся', async () => {
    const { ctrl, plans } = makeCtrl();
    await ctrl.generate({ userId: 'u1' }, { assistantId: 10, freshTs: '1786468316338' });
    expect(plans.generate).toHaveBeenCalledWith('u1', '10');
  });

  it('find читает из запроса только assistantId', async () => {
    const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, ActionPlansController, 'find') ?? {};
    const queries = Object.keys(args)
      .filter((k) => k.startsWith(`${RouteParamtypes.QUERY}:`))
      .map((k) => args[k].data);
    expect(queries).toEqual(['assistantId']);

    const { ctrl, plans } = makeCtrl();
    await expect((ctrl.find as any).call(ctrl, { userId: 'u1' }, '10', '1786468316338')).resolves.toEqual({ plan: null });
    expect(plans.findForConversation).toHaveBeenCalledWith('u1', '10');
  });
});
