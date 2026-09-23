import { UnauthorizedException } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { ProductsMcpController } from './products-mcp.controller';
import { signProductToolToken } from '../products/product-tool.token';

describe('точка /mcp/products', () => {
  const OLD = process.env.JWT_SECRET;
  beforeAll(() => { process.env.JWT_SECRET = 'test-secret-for-product-tool'; });
  afterAll(() => { process.env.JWT_SECRET = OLD; });

  const make = () => {
    const calls: any[] = [];
    const tool = {
      execute: jest.fn(async (userId: string, input: any) => { calls.push({ userId, input }); return { ok: true }; }),
    };
    return { ctrl: new ProductsMcpController(tool as any), calls, tool };
  };

  it('владелец берётся ИЗ ТОКЕНА', async () => {
    const { ctrl, calls } = make();
    await ctrl.callTool(`Bearer ${signProductToolToken('79030169187')}`, { action: 'list' });
    expect(calls[0].userId).toBe('79030169187');
  });

  // Главная защита этой точки. Поле userId в запросе не должно значить НИЧЕГО:
  // иначе возвращается ровно та дыра, из-за которой инструмент не отдали общей
  // точке /mcp (там userId пишет модель — mcp.controller.ts:74).
  it('поле userId в запросе игнорируется полностью', async () => {
    const { ctrl, calls } = make();
    await ctrl.callTool(`Bearer ${signProductToolToken('79030169187')}`, { action: 'list', userId: '70000000000' });
    expect(calls[0].userId).toBe('79030169187');
    expect(calls[0].input.userId).toBeUndefined();
  });

  it('без токена — отказ, инструмент не зовётся', async () => {
    const { ctrl, tool } = make();
    await expect(ctrl.callTool(undefined, { action: 'list' })).rejects.toThrow(UnauthorizedException);
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it('чужая подпись — отказ', async () => {
    const { ctrl, tool } = make();
    const alien = jwt.sign({ userId: '79030169187', type: 'product-tool' }, 'not-our-secret');
    await expect(ctrl.callTool(`Bearer ${alien}`, { action: 'list' })).rejects.toThrow(UnauthorizedException);
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it('access-токен пользователя сюда не пускают', async () => {
    const { ctrl, tool } = make();
    const access = jwt.sign({ userId: '79030169187', type: 'access' }, process.env.JWT_SECRET!);
    await expect(ctrl.callTool(`Bearer ${access}`, { action: 'list' })).rejects.toThrow(UnauthorizedException);
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it('общий MCP_SECRET здесь не работает', async () => {
    const { ctrl, tool } = make();
    process.env.MCP_SECRET = 'shared-secret';
    await expect(ctrl.callTool('Bearer shared-secret', { action: 'list' })).rejects.toThrow(UnauthorizedException);
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it('просроченный токен — отказ', async () => {
    const { ctrl, tool } = make();
    const stale = jwt.sign({ userId: '79030169187', type: 'product-tool' }, process.env.JWT_SECRET!, { expiresIn: -60 });
    await expect(ctrl.callTool(`Bearer ${stale}`, { action: 'list' })).rejects.toThrow(UnauthorizedException);
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it('список инструментов отдаётся без аргумента userId', () => {
    const { ctrl } = make();
    const tools = ctrl.listTools();
    expect(tools).toHaveLength(1);
    expect(Object.keys((tools[0] as any).inputSchema.properties)).not.toContain('userId');
  });
});
