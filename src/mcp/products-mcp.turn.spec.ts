import { ProductsMcpController } from './products-mcp.controller';
import { signProductToolToken } from '../products/product-tool.token';

const TURN = '11111111-2222-4333-8444-555555555555';

it('метка хода — из подписи токена, а не из аргументов модели', async () => {
  const tool = { execute: jest.fn(async () => ({ ok: true })) };
  const ctrl = new ProductsMcpController(tool as any, {} as any, {} as any, {} as any);
  await ctrl.callTool(`Bearer ${signProductToolToken('u1', 'web', TURN)}`, { action: 'list', turn: 'подделка', userId: 'x' });
  expect(tool.execute).toHaveBeenCalledWith('u1', { action: 'list' }, 'web', TURN);
});
