import { PRODUCT_TOOLS, PRODUCT_TOOL_NAME } from './product-tool.service';

describe('определение инструмента продуктов', () => {
  const tool = () => PRODUCT_TOOLS.find((t) => t.name === PRODUCT_TOOL_NAME)!;

  it('инструмент ровно один, с тремя действиями', () => {
    expect(PRODUCT_TOOLS).toHaveLength(1);
    expect((tool().input_schema as any).properties.action.enum.slice().sort()).toEqual(['edit', 'list', 'status']);
  });

  // Аргумента userId здесь быть НЕ ДОЛЖНО: владелец приезжает из подписи
  // токена. Появление поля вернуло бы дыру, ради закрытия которой заведена
  // отдельная точка /mcp/products.
  it('аргумента userId нет вовсе', () => {
    const schema = tool().input_schema as any;
    expect(Object.keys(schema.properties)).not.toContain('userId');
    expect(schema.required).not.toContain('userId');
  });

  it('описание прямо запрещает называть откат успехом', () => {
    expect(tool().description).toMatch(/откат/i);
    expect(tool().description).toMatch(/reverted/);
  });

  it('описание требует назвать расход', () => {
    expect(tool().description).toMatch(/токен/i);
  });

  it('описание запрещает обещать до вызова', () => {
    expect(tool().description).toMatch(/не говори|пока не вызвал/i);
  });

  it('описание требует уточнять при неоднозначности', () => {
    expect(tool().description).toMatch(/уточн|спрос/i);
  });

  it('описание говорит, что завести продукт нельзя', () => {
    expect(tool().description).toMatch(/не можешь/i);
  });

  it('описание различает спящего и погашенного', () => {
    expect(tool().description).toMatch(/sleeping/);
    expect(tool().description).toMatch(/blocked/);
  });

  it('каждое действие названо в описании', () => {
    for (const a of ['list', 'edit', 'status']) {
      expect(tool().description).toContain(a);
    }
  });
});
