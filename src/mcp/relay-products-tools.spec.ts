import * as fs from 'fs';
import * as path from 'path';
import { ProductsMcpController } from './products-mcp.controller';

/**
 * relay-agent/server.mjs — копия того, что едет на релей (веб-ассистенты).
 * Инструмент точки продуктов без имени в PRODUCTS_TOOLS CLI в -p отклонит
 * молча, а без строки «Тебе доступен инструмент …» в PRODUCTS_PROMPT модель
 * сочтёт его запрещённым (правило «только mcp__linkeon__*»).
 */
const relay = fs.readFileSync(path.join(__dirname, '../../relay-agent/server.mjs'), 'utf8');
const allowed = (/const PRODUCTS_TOOLS = "([^"]+)";/.exec(relay)?.[1] ?? '').split(',');

describe('копия релея знает все инструменты точки продуктов', () => {
  it('веб: каждый инструмент — в PRODUCTS_TOOLS и с явным исключением в PRODUCTS_PROMPT', () => {
    const ctrl = new ProductsMcpController({} as any, {} as any, {} as any, {} as any);
    const tools = ctrl.listTools('web') as any[];
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) {
      const name = `mcp__products__${t.name}`;
      expect(allowed).toContain(name);
      expect(relay).toContain(`Тебе доступен инструмент ${name}`);
    }
  });
});
