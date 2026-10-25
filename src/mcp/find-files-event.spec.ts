import { ProductsMcpController } from './products-mcp.controller';
import { signProductToolToken } from '../products/product-tool.token';

process.env.JWT_SECRET = 'find-files-event-spec';

describe('find_files: событие для статистики', () => {
  it('владелец и канал — из токена, а не из аргументов модели; найдено и можно скачать', async () => {
    const files = {
      searchForUser: jest.fn(async () => ({ ok: true, total: 3, files: [{ stored: true }, { stored: false }, { stored: true }] })),
    };
    const events = { track: jest.fn() };
    const ctrl = new ProductsMcpController({} as any, files as any, {} as any, {} as any, events as any);
    await ctrl.callTool(`Bearer ${signProductToolToken('u-1')}`, { query: 'кот', userId: 'чужой' }, 'find_files');
    expect(events.track).toHaveBeenCalledWith('find_files_call', {
      userId: 'u-1',
      props: { channel: 'web', found: 3, stored: 2 },
    });
  });

  it('другие инструменты события не пишут', async () => {
    const tool = { execute: jest.fn(async () => ({ ok: true })) };
    const events = { track: jest.fn() };
    const ctrl = new ProductsMcpController(tool as any, {} as any, {} as any, {} as any, events as any);
    await ctrl.callTool(`Bearer ${signProductToolToken('u-1')}`, { action: 'list' }, 'manage_product');
    expect(events.track).not.toHaveBeenCalled();
  });
});
