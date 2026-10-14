import { CHAT_TOOLS, ChatToolsService } from './chat-tools';

describe('инструмент calculate_human_design в чате', () => {
  it('в списке инструментов — с понятной схемой и правилом про картинку', () => {
    const tool = CHAT_TOOLS.find((t) => t.name === 'calculate_human_design');
    expect(tool).toBeDefined();
    const schema = tool!.input_schema as any;
    expect(schema.required).toEqual(['date', 'time', 'city']);
    expect(Object.keys(schema.properties).sort()).toEqual(['city', 'cityId', 'date', 'dst', 'time']);
    expect(schema.properties.dst.enum).toEqual(['before', 'after']);
    expect(tool!.description).toContain('![](imageUrl)');
    expect(tool!.description).toMatch(/choose_city/);
    expect(tool!.description).toMatch(/choose_dst/);
    expect(tool!.description).toContain('нынешнее официальное название');
    expect(tool!.description).toContain('по-русски');
    expect(tool!.description).toMatch(/на любом языке сайта/);
    expect(tool!.description).toContain('慕尼黑');
    expect(tool!.description).toMatch(/русскими названиями/);
    expect(schema.properties.city.description).toMatch(/на любом языке сайта/);
    expect(schema.properties.city.description).toContain('нынешнее официальное название по-русски');
    expect(tool!.description).toMatch(/imageUrl.*null/);
  });

  it('executeTool отдаёт вызов сервису как есть — без списания токенов', async () => {
    const result = { ok: true, kind: 'choose_city', candidates: [] };
    const humanDesign = { calculate: jest.fn(async () => result) };
    const pg = { query: jest.fn() };
    const svc = new ChatToolsService(
      {} as any, {} as any, pg as any, {} as any, {} as any, {} as any, {} as any, humanDesign as any,
    );
    const input = { date: '1990-03-12', time: '14:25', city: 'Казань' };
    await expect(svc.executeTool('70000000000', 'calculate_human_design', input)).resolves.toBe(result);
    expect(humanDesign.calculate).toHaveBeenCalledWith(input);
    expect(pg.query).not.toHaveBeenCalled();
  });
});
