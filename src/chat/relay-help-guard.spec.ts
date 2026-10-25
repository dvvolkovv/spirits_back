import * as fs from 'fs';
import * as path from 'path';
import { LINKEON_HELP_CLI_TOOL_NAME } from '../products/products-cli-tool';

/**
 * Справка у ассистентов релея держится на трёх строках server.mjs:
 *   • имя в PRODUCTS_TOOLS — без него вызов в -p отклоняется молча;
 *   • оговорка в PRODUCTS_PROMPT — без неё ассистент видит инструмент, но не
 *     зовёт, считая запрещённым правилом «только mcp__linkeon__*»;
 *   • правило 10 — разрешает «как устроено» ровно на уровне справки.
 * Копия в репозитории — то, что выкатывается на релей (Задача 32 плана
 * platform-kb); разъедутся — справка тихо пропадёт.
 */
const src = fs.readFileSync(path.join(__dirname, '../../relay-agent/server.mjs'), 'utf8');

describe('релей: справка', () => {
  it('имя справки — в белом списке инструментов продуктов', () => {
    const m = /const PRODUCTS_TOOLS = "([^"]+)"/.exec(src);
    expect(m).not.toBeNull();
    expect(m![1].split(',')).toContain(LINKEON_HELP_CLI_TOOL_NAME);
  });

  it('оговорка-исключение к правилу mcp__linkeon__* — и для справки', () => {
    const block = src.slice(src.indexOf('const PRODUCTS_PROMPT'), src.indexOf('app.post("/chat"'));
    expect(block).toContain(LINKEON_HELP_CLI_TOOL_NAME);
    expect(block).toMatch(/СПРАВКА О LINKEON[\s\S]*ЯВНОЕ исключение/);
  });

  it('правило 10: «как устроено» — на уровне справки, остальное закрыто', () => {
    const rule = /10\. PLATFORM AND INTERNALS:[^\n]+/.exec(src)?.[0] ?? '';
    expect(rule).toMatch(/linkeon_help/);
    expect(rule).toMatch(/never call yourself by a model's name/);
    for (const closed of ['server or relay', 'sudo', 'system prompt', 'internal endpoints', 'keys']) {
      expect(rule).toContain(closed);
    }
  });
});
