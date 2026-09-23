import * as fs from 'fs';
import * as path from 'path';
import { RELAY_TURN_BUDGET_MS, TOOL_STEPS_PER_TURN, PRODUCT_TOOL_WAIT_MS } from './relay-budget';

describe('бюджет хода релея', () => {
  it('потолок ожидания ВЫЧИСЛЕН из бюджета хода, а не выбран своим числом', () => {
    expect(PRODUCT_TOOL_WAIT_MS * TOOL_STEPS_PER_TURN).toBe(RELAY_TURN_BUDGET_MS);
  });

  it('потолок строго меньше бюджета: инструменту нельзя съесть весь ход', () => {
    expect(PRODUCT_TOOL_WAIT_MS).toBeLessThan(RELAY_TURN_BUDGET_MS);
    expect(PRODUCT_TOOL_WAIT_MS).toBeGreaterThan(0);
  });

  // Тест по исходнику, а не по поведению, — сознательно. Вычислить бюджет
  // из работающего axios нельзя, а именно возврат литерала обратно в
  // chat.service.ts и есть та поломка, ради которой константа заводилась:
  // два числа разъедутся молча, и ассистент будет ждать дольше, чем его
  // слушают.
  it('chat.service берёт бюджет из константы, а не держит свой литерал', () => {
    const src = fs.readFileSync(path.join(__dirname, '../chat/chat.service.ts'), 'utf8');
    expect(src).toContain('RELAY_TURN_BUDGET_MS');
    expect(src).not.toMatch(/timeout:\s*600000/);
  });
});
